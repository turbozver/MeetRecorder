const statusEl = document.getElementById("status");
const FORMAT_KEY = "meetRecorderFormat";
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const recoverSettingsBtn = document.getElementById("recoverSettings");
const micAccessSettingsBtn = document.getElementById("micAccessSettings");
const formatEl = document.getElementById("format");
let settingsOpen = false;

document.getElementById("settingsBtn").addEventListener("click", toggleSettings);
formatEl.addEventListener("change", () => {
    chrome.storage.local.set({ [FORMAT_KEY]: formatEl.value });
});

startBtn.addEventListener("click", async () => {
    setStatus("Starting...");
    const response = await chrome.runtime.sendMessage({
        type: "pair_recordings_start",
        format: formatEl.value
    });
    if (!response?.ok) {
        setStatus(response?.error || "Unable to start");
        return;
    }
    render(response.recording);
});

stopBtn.addEventListener("click", async () => {
    setStatus("Stopping...");
    await chrome.runtime.sendMessage({ type: "pair_recordings_stop" });
    load();
});

recoverSettingsBtn.addEventListener("click", recoverRecording);
micAccessSettingsBtn.addEventListener("click", requestMicAccess);

function toggleSettings() {
    settingsOpen = !settingsOpen;
    document.getElementById("mainView").classList.toggle("hidden", settingsOpen);
    document.getElementById("settingsView").classList.toggle("hidden", !settingsOpen);
    const button = document.getElementById("settingsBtn");
    button.innerHTML = settingsOpen ? "&#8617;" : "&#9881;";
    button.classList.toggle("back-button", settingsOpen);
    button.title = settingsOpen ? "Back" : "Settings";
    button.setAttribute("aria-label", button.title);
}

async function recoverRecording() {
    setStatus("Looking for recovered chunks...");
    const response = await chrome.runtime.sendMessage({ type: "pair_recordings_recover" });
    setStatus(response?.ok ? "Recovered recording save dialog opened" : response?.error || "No recovered recording");
}

async function requestMicAccess() {
    await chrome.tabs.create({
        url: chrome.runtime.getURL("mic-permission.html"),
        active: true
    });
    setStatus("Microphone permission page opened");
}

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "pair_recordings_download_started") {
        setStatus("Saved to Downloads");
        load();
    } else if (message?.type === "pair_recordings_save_dialog_opened") {
        setStatus("Save dialog opened");
    } else if (message?.type === "pair_recordings_download_failed") {
        setStatus("Save canceled; recovery is still available");
    }
});

chrome.storage.local.get([FORMAT_KEY], (data) => {
    formatEl.value = data[FORMAT_KEY] === "mp4" ? "mp4" : "webm";
});
load();
setInterval(load, 1000);

async function load() {
    const recording = await chrome.runtime.sendMessage({ type: "pair_recordings_status" });
    render(recording);
}

function render(recording) {
    const active = !!recording?.active;
    startBtn.disabled = active;
    stopBtn.disabled = !active;
    formatEl.disabled = active;
    if (active) {
        setStatus(`Recording ${formatDuration(Date.now() - recording.startedAt)}`);
    } else if (statusEl.textContent === "Stopping...") {
        setStatus("Saving...");
    } else if (!statusEl.textContent || statusEl.textContent.startsWith("Recording")) {
        setStatus("Idle");
    }
}

function setStatus(value) {
    statusEl.textContent = value;
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
}


document.querySelectorAll("[data-rate-link]").forEach((link) => {
    if (navigator.userAgent.includes("Firefox")) {
        link.href = link.dataset.firefoxUrl;
    }
});
