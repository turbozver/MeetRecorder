const STATUS_KEY = "pairRecordingsStatus";
const FORMAT_KEY = "meetRecorderFormat";

let recording = {
    active: false,
    tabId: null,
    startedAt: null,
    filename: ""
};
const pendingDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "pair_recordings_start") {
        startRecording(message, sender).then(sendResponse);
        return true;
    }

    if (message?.type === "pair_recordings_stop") {
        stopRecording().then(sendResponse);
        return true;
    }

    if (message?.type === "pair_recordings_recover") {
        recoverRecording().then(sendResponse);
        return true;
    }

    if (message?.type === "pair_recordings_status") {
        sendResponse(recording);
        return false;
    }

    if (message?.type === "pair_recordings_mic_state") {
        chrome.runtime.sendMessage({ type: "pair_recordings_offscreen_mic_state", unmuted: !!message.unmuted }).catch(() => {});
        return false;
    }

    if (message?.type === "pair_recordings_download") {
        chrome.downloads.download({
            url: message.url,
            filename: message.filename,
            saveAs: true
        }, (downloadId) => {
            if (chrome.runtime.lastError || !downloadId) {
                chrome.runtime.sendMessage({ type: "pair_recordings_download_failed" }).catch(() => {});
                return;
            }

            if (message.sessionId) {
                pendingDownloads.set(downloadId, message.sessionId);
            }
            chrome.runtime.sendMessage({ type: "pair_recordings_save_dialog_opened" }).catch(() => {});
        });
        return false;
    }

    if (message?.type === "pair_recordings_stopped") {
        recording = { active: false, tabId: null, startedAt: null, filename: "" };
        chrome.storage.local.set({ [STATUS_KEY]: recording });
        return false;
    }

    return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (recording.active && recording.tabId === tabId) {
        stopRecording();
    }
});

chrome.downloads.onChanged.addListener((delta) => {
    if (!pendingDownloads.has(delta.id) || !delta.state?.current) return;
    const sessionId = pendingDownloads.get(delta.id);

    if (delta.state.current === "complete") {
        pendingDownloads.delete(delta.id);
        chrome.runtime.sendMessage({
            type: "pair_recordings_offscreen_clear_session",
            sessionId
        }).catch(() => {});
        chrome.runtime.sendMessage({ type: "pair_recordings_download_started" }).catch(() => {});
    } else if (delta.state.current === "interrupted") {
        pendingDownloads.delete(delta.id);
        chrome.runtime.sendMessage({ type: "pair_recordings_download_failed" }).catch(() => {});
    }
});

async function startRecording(options = {}, sender = {}) {
    if (recording.active) return { ok: false, error: "Recording is already active" };
    const stored = await chrome.storage.local.get([FORMAT_KEY]);
    const rawFormat = options.format || stored[FORMAT_KEY] || "webm";
    const requestedFormat = rawFormat === "mp4" ? "mp4" : "webm";

    const tab = await getTargetTab(options, sender);
    if (!tab?.id || !/^https:\/\/meet\.google\.com\//.test(tab.url || "")) {
        return { ok: false, error: "Open a Google Meet tab before starting" };
    }

    await ensureOffscreenDocument();

    let streamId;
    try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (error) {
        await resetOffscreenRecorder();
        await chrome.offscreen.closeDocument().catch(() => {});
        await ensureOffscreenDocument();
        try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        } catch (retryError) {
            return { ok: false, error: retryError.message || error.message || "Unable to capture tab" };
        }
    }

    recording = {
        active: true,
        tabId: tab.id,
        startedAt: Date.now(),
        filename: `meet-recording/meet-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`
    };
    chrome.storage.local.set({ [STATUS_KEY]: recording });

    const started = await chrome.runtime.sendMessage({
        type: "pair_recordings_offscreen_start",
        streamId,
        tabId: tab.id,
        filename: recording.filename,
        format: requestedFormat,
        sessionId: String(recording.startedAt)
    });
    if (!started?.ok) {
        recording = { active: false, tabId: null, startedAt: null, filename: "" };
        chrome.storage.local.set({ [STATUS_KEY]: recording });
        return { ok: false, error: started?.error || "Unable to start recorder" };
    }

    chrome.tabs.sendMessage(tab.id, { type: "pair_recordings_request_mic_state" }).catch(() => {});
    return { ok: true, recording };
}

async function getTargetTab(options, sender) {
    if (options.tabId) {
        return chrome.tabs.get(options.tabId).catch(() => null);
    }

    if (sender?.tab?.id) {
        return sender.tab;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
}

async function recoverRecording() {
    await ensureOffscreenDocument();
    return chrome.runtime.sendMessage({ type: "pair_recordings_offscreen_recover" });
}

async function resetOffscreenRecorder() {
    await chrome.runtime.sendMessage({ type: "pair_recordings_offscreen_stop" }).catch(() => {});
    recording = { active: false, tabId: null, startedAt: null, filename: "" };
    chrome.storage.local.set({ [STATUS_KEY]: recording });
}

async function stopRecording() {
    if (!recording.active) return { ok: true };
    await chrome.runtime.sendMessage({ type: "pair_recordings_offscreen_stop" }).catch(() => {});
    return { ok: true };
}

async function ensureOffscreenDocument() {
    const url = chrome.runtime.getURL("offscreen.html");
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url]
    });

    if (contexts.length > 0) return;

    await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA", "BLOBS"],
        justification: "Record Google Meet tab media and create a downloadable recording blob."
    });
}
