let lastState = null;
let scanTimer = null;
let recordingStatusTimer = null;
let pageControl = null;

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "pair_recordings_request_mic_state") {
        lastState = null;
        sendMicState();
    }
});

const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
setInterval(sendMicState, 1000);
sendMicState();
ensurePageControl();
setInterval(updatePageControl, 1000);

function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(sendMicState, 150);
}

function sendMicState() {
    const unmuted = detectMicUnmuted();
    if (unmuted === lastState) return;
    lastState = unmuted;
    chrome.runtime.sendMessage({ type: "pair_recordings_mic_state", unmuted }).catch(() => {});
}

function detectMicUnmuted() {
    const controls = [...document.querySelectorAll("button, div[role='button']")];
    const candidates = controls
        .map((element) => ({ element, label: getControlText(element) }))
        .filter((item) => isMicControl(item.element, item.label));

    for (const { element, label } of candidates) {
        if (isMutedLabel(label) || hasMutedIcon(element) || hasMutedState(element)) return false;
        if (isUnmutedLabel(label)) return true;
    }

    return false;
}

function getControlText(element) {
    return [
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.getAttribute("title"),
        element.textContent
    ].filter(Boolean).join(" ").toLowerCase();
}

function isMicControl(element, label) {
    return label.includes("microphone") ||
        /\bmic\b/.test(label) ||
        label.includes("микрофон") ||
        label.includes("мікрофон") ||
        element.querySelector(".google-symbols")?.textContent?.trim() === "mic" ||
        element.querySelector(".google-symbols")?.textContent?.trim() === "mic_off";
}

function isMutedLabel(label) {
    return label.includes("turn on") ||
        label.includes("unmute") ||
        label.includes("muted") ||
        label.includes("is off") ||
        label.includes("включить микрофон") ||
        label.includes("увімкнути мікрофон");
}

function isUnmutedLabel(label) {
    return label.includes("turn off") ||
        /\bmute\b/.test(label) ||
        label.includes("is on") ||
        label.includes("выключить микрофон") ||
        label.includes("отключить микрофон") ||
        label.includes("вимкнути мікрофон") ||
        label.includes("відключити мікрофон");
}

function hasMutedIcon(element) {
    return [...element.querySelectorAll(".google-symbols, i")]
        .some((icon) => icon.textContent?.trim() === "mic_off");
}

function hasMutedState(element) {
    const state = [
        element.getAttribute("data-is-muted"),
        element.getAttribute("aria-pressed"),
        element.className
    ].filter(Boolean).join(" ").toLowerCase();

    return state.includes("muted") || state.includes("mic-off");
}

function ensurePageControl() {
    if (pageControl) return;

    const style = document.createElement("style");
    style.textContent = `
        #meet-recording-control {
            position: fixed;
            right: 168px;
            bottom: 18px;
            z-index: 2147483647;
            display: grid;
            grid-template-columns: auto auto;
            gap: 8px;
            align-items: center;
            padding: 0;
            border: 0;
            border-radius: 0;
            color: #f2f3f5;
            background: transparent;
            box-shadow: none;
            font: 12px/1.3 Arial, sans-serif;
        }
        #meet-recording-control button {
            display: grid;
            place-items: center;
            width: 38px;
            height: 38px;
            min-width: 38px;
            min-height: 38px;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 50%;
            color: #fff;
            background: rgba(18,20,26,.78);
            cursor: pointer;
            backdrop-filter: blur(10px);
        }
        #meet-recording-control[data-active="true"] button {
            color: #ffb6b6;
            background: rgba(36,23,28,.78);
        }
        #meet-recording-control button span {
            display: block;
            width: 13px;
            height: 13px;
            min-width: 0;
            border-radius: 50%;
            background: #ff4d5d;
        }
        #meet-recording-control[data-active="true"] button span {
            border-radius: 3px;
        }
        #meet-recording-control .timer {
            min-width: 44px;
            color: #a8adb8;
            text-align: right;
            font-variant-numeric: tabular-nums;
            font-size: 14px;
            font-weight: 700;
        }
        #meet-recording-control[data-active="true"] .timer {
            color: #ff4d5d;
        }
        #meet-recording-control .message {
            position: absolute;
            right: 0;
            bottom: 46px;
            display: none;
            width: max-content;
            max-width: 280px;
            padding: 8px 10px;
            border: 1px solid rgba(255,255,255,.16);
            border-radius: 8px;
            color: #f2f3f5;
            background: rgba(18,20,26,.94);
            box-shadow: 0 12px 34px rgba(0,0,0,.35);
            font-size: 12px;
            line-height: 1.35;
            text-align: left;
            backdrop-filter: blur(10px);
        }
        #meet-recording-control[data-message="true"] .message {
            display: block;
        }
    `;
    document.documentElement.appendChild(style);

    pageControl = document.createElement("div");
    pageControl.id = "meet-recording-control";
    pageControl.innerHTML = '<button type="button" title="Start recording" aria-label="Start recording"><span aria-hidden="true"></span></button><span class="timer">0:00</span><div class="message" role="status" aria-live="polite"></div>';
    pageControl.querySelector("button").addEventListener("click", toggleRecordingFromPage);
    document.documentElement.appendChild(pageControl);
    updatePageControl();
}

async function toggleRecordingFromPage() {
    const status = await chrome.runtime.sendMessage({ type: "pair_recordings_status" }).catch(() => null);
    let response;
    if (status?.active) {
        response = await chrome.runtime.sendMessage({ type: "pair_recordings_stop" }).catch((error) => ({ ok: false, error: error.message }));
    } else {
        response = await chrome.runtime.sendMessage({ type: "pair_recordings_start" }).catch((error) => ({ ok: false, error: error.message }));
        if (!response?.ok && isActiveTabError(response?.error)) {
            showPageControlMessage("Icon", "Chrome requires opening Meet Recorder popup once before tab capture can start.");
            return;
        }
    }

    if (response && !response.ok) {
        showPageControlMessage("Error", response.error || "Recording failed");
        return;
    }
    window.clearTimeout(recordingStatusTimer);
    recordingStatusTimer = window.setTimeout(updatePageControl, 300);
}

function isActiveTabError(error) {
    const text = String(error || "").toLowerCase();
    return text.includes("activetab") || text.includes("has not been invoked");
}

function showPageControlMessage(label, message) {
    if (!pageControl) return;
    const timer = pageControl.querySelector(".timer");
    const messageEl = pageControl.querySelector(".message");
    timer.textContent = label;
    messageEl.textContent = message;
    pageControl.dataset.message = "true";
    window.clearTimeout(recordingStatusTimer);
    recordingStatusTimer = window.setTimeout(() => {
        pageControl.dataset.message = "false";
        messageEl.textContent = "";
        updatePageControl();
    }, 4500);
}

async function updatePageControl() {
    if (!pageControl) return;
    const status = await chrome.runtime.sendMessage({ type: "pair_recordings_status" }).catch(() => null);
    const active = !!status?.active;
    pageControl.dataset.active = String(active);
    const button = pageControl.querySelector("button");
    button.title = active ? "Stop recording" : "Start recording";
    button.setAttribute("aria-label", button.title);
    pageControl.querySelector(".timer").textContent = active ? formatDuration(Date.now() - status.startedAt) : "0:00";
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
