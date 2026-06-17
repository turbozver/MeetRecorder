const statusEl = document.getElementById("status");
const requestBtn = document.getElementById("request");

requestBtn.addEventListener("click", requestAccess);

async function requestAccess() {
    statusEl.textContent = "Requesting microphone access...";
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach((track) => track.stop());
        statusEl.textContent = "Microphone access is allowed. If Chrome offers a temporary choice, switch it to Allow while visiting the site before closing this tab.";
    } catch (error) {
        statusEl.textContent = error?.message || "Microphone access was not allowed.";
    }
}
