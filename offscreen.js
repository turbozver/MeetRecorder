let recorder = null;
let chunks = [];
let tabStream = null;
let micStream = null;
let audioContext = null;
let micGain = null;
let filename = "";
let sessionId = "";
let recorderMimeType = "video/webm";
let pendingChunkWrites = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "pair_recordings_offscreen_start") {
        start(message)
            .then(sendResponse)
            .catch((error) => sendResponse({ ok: false, error: error.message || "Unable to start recorder" }));
        return true;
    }

    if (message?.type === "pair_recordings_offscreen_stop") {
        stop()
            .then(sendResponse)
            .catch((error) => sendResponse({ ok: false, error: error.message || "Unable to stop recorder" }));
        return true;
    }

    if (message?.type === "pair_recordings_offscreen_recover") {
        recoverLatestRecording()
            .then(sendResponse)
            .catch((error) => sendResponse({ ok: false, error: error.message || "Unable to recover recording" }));
        return true;
    }

    if (message?.type === "pair_recordings_offscreen_clear_session") {
        clearSessionChunks(message.sessionId).catch(() => {});
        return false;
    }

    if (message?.type === "pair_recordings_offscreen_mic_state") {
        setMicEnabled(!!message.unmuted);
        return false;
    }

    return false;
});

async function start(message) {
    if (recorder?.state === "recording") return { ok: false, error: "Already recording" };

    filename = message.filename;
    sessionId = message.sessionId || String(Date.now());
    chunks = [];
    await clearSessionChunks(sessionId);

    tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: message.streamId
            }
        },
        video: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: message.streamId
            }
        }
    });

    const mixedStream = await createMixedStream(tabStream);
    recorder = createRecorder(mixedStream, message.format || "webm");
    recorderMimeType = recorder.mimeType || "video/webm";
    recorder.ondataavailable = (event) => {
        if (event.data?.size) {
            chunks.push(event.data);
            pendingChunkWrites.push(storeChunk(sessionId, event.data, recorderMimeType));
        }
    };
    recorder.onstop = handleStop;
    recorder.start(5000);
    return { ok: true };
}

async function createMixedStream(sourceStream) {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    const tabSource = audioContext.createMediaStreamSource(sourceStream);

    tabSource.connect(destination);
    tabSource.connect(audioContext.destination);

    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const micSource = audioContext.createMediaStreamSource(micStream);
        micGain = audioContext.createGain();
        micGain.gain.value = 0;
        micSource.connect(micGain);
        micGain.connect(destination);
    } catch {
        micStream = null;
        micGain = null;
    }

    return new MediaStream([
        ...sourceStream.getVideoTracks(),
        ...destination.stream.getAudioTracks()
    ]);
}

async function stop() {
    if (recorder && recorder.state !== "inactive") {
        recorder.stop();
    } else {
        cleanup();
        chrome.runtime.sendMessage({ type: "pair_recordings_stopped" });
    }
    return { ok: true };
}

async function handleStop() {
    await Promise.allSettled(pendingChunkWrites);
    const savedChunks = await readSessionChunks(sessionId);
    const blob = new Blob(savedChunks.length ? savedChunks : chunks, { type: recorderMimeType || "video/webm" });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({
        type: "pair_recordings_download",
        url,
        filename: filenameForMimeType(filename, blob.type),
        sessionId
    });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    cleanup();
    chrome.runtime.sendMessage({ type: "pair_recordings_stopped" });
}

function cleanup() {
    for (const stream of [tabStream, micStream]) {
        stream?.getTracks().forEach((track) => track.stop());
    }
    tabStream = null;
    micStream = null;
    micGain = null;
    audioContext?.close?.();
    audioContext = null;
    recorder = null;
    chunks = [];
    pendingChunkWrites = [];
    sessionId = "";
    recorderMimeType = "video/webm";
}

function setMicEnabled(enabled) {
    if (!micGain) return;
    micGain.gain.value = enabled ? 1 : 0;
}

function createRecorder(stream, format) {
    for (const type of getPreferredMimeTypes(format)) {
        if (!MediaRecorder.isTypeSupported(type)) continue;
        try {
            return new MediaRecorder(stream, { mimeType: type });
        } catch {
            // Try the next format.
        }
    }

    return new MediaRecorder(stream);
}

function getPreferredMimeTypes(format) {
    if (format === "webm") {
        return [
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm"
        ];
    }

    const mp4Types = [
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4"
    ];
    const webmTypes = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
    ];
    return format === "mp4" ? mp4Types.concat(webmTypes) : mp4Types.concat(webmTypes);
}

function filenameForMimeType(name, mimeType) {
    if (String(mimeType || "").startsWith("video/mp4")) {
        return name.replace(/\.webm$/i, ".mp4");
    }
    return name;
}

async function recoverLatestRecording() {
    const sessions = await listSavedSessions();
    const latest = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return { ok: false, error: "No recovered recording chunks found" };

    const recoveredChunks = await readSessionChunks(latest.sessionId);
    if (recoveredChunks.length === 0) return { ok: false, error: "Recovered recording is empty" };

    const mimeType = latest.mimeType || "video/webm";
    const blob = new Blob(recoveredChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({
        type: "pair_recordings_download",
        url,
        filename: filenameForMimeType(`meet-recording/recovered-${latest.sessionId}.webm`, mimeType),
        sessionId: latest.sessionId
    });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true };
}

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("meet-recording", 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true });
            store.createIndex("sessionId", "sessionId", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function storeChunk(currentSessionId, blob, mimeType) {
    const db = await openDb();
    await txDone(db, "chunks", "readwrite", (store) => {
        store.add({
            sessionId: currentSessionId,
            blob,
            mimeType,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    });
    db.close();
}

async function readSessionChunks(currentSessionId) {
    const db = await openDb();
    const chunksForSession = await new Promise((resolve, reject) => {
        const tx = db.transaction("chunks", "readonly");
        const request = tx.objectStore("chunks").index("sessionId").getAll(currentSessionId);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
    db.close();
    return chunksForSession.sort((a, b) => a.id - b.id).map((item) => item.blob);
}

async function listSavedSessions() {
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction("chunks", "readonly");
        const request = tx.objectStore("chunks").getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
    db.close();

    const sessions = new Map();
    for (const row of rows) {
        const current = sessions.get(row.sessionId) || {
            sessionId: row.sessionId,
            mimeType: row.mimeType,
            updatedAt: 0
        };
        current.updatedAt = Math.max(current.updatedAt, row.updatedAt || row.createdAt || 0);
        current.mimeType = current.mimeType || row.mimeType;
        sessions.set(row.sessionId, current);
    }
    return [...sessions.values()];
}

async function clearSessionChunks(currentSessionId) {
    if (!currentSessionId) return;
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction("chunks", "readonly");
        const request = tx.objectStore("chunks").index("sessionId").getAllKeys(currentSessionId);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
    await txDone(db, "chunks", "readwrite", (store) => {
        for (const key of rows) store.delete(key);
    });
    db.close();
}

function txDone(db, storeName, mode, callback) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        callback(tx.objectStore(storeName));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
