const captureButtons = [...document.querySelectorAll("[data-mode]")];
const outputButtons = [...document.querySelectorAll("[data-output]")];
const status = document.querySelector("#status");
const POPUP_CLIPBOARD_MESSAGE = "HOLD_STILL_POPUP_COPY";
let outputMode = "copy";
let statusResetTimer = null;
let outputChangePending = false;
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== POPUP_CLIPBOARD_MESSAGE) return false;

  copyImageToClipboard(message.url).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({
      ok: false,
      error: error?.message || String(error)
    })
  );
  return true;
});


initializeOutput();

for (const button of captureButtons) {
  button.addEventListener("click", () => startCapture(button.dataset.mode));
}

for (const button of outputButtons) {
  button.addEventListener("click", () => chooseOutput(button.dataset.output));
}

// clipboardWrite ships as a required permission, so choosing Copy no longer
// negotiates anything: the popup reads the stored preference and writes it back.
async function initializeOutput() {
  try {
    const stored = await chrome.storage.local.get({ outputMode: "copy" });
    outputMode = stored.outputMode === "download" ? "download" : "copy";
    renderOutput();
    setStatus(outputHint(outputMode), "neutral");
  } catch (error) {
    outputMode = "copy";
    renderOutput();
    setStatus(error.message || String(error), "error");
  }
}

async function chooseOutput(mode) {
  if (
    !["download", "copy"].includes(mode) ||
    mode === outputMode ||
    outputChangePending
  ) return;

  // Paint the choice first so the toggle never lags behind the click, then
  // roll back if the write fails.
  const previousMode = outputMode;
  outputChangePending = true;
  outputMode = mode;
  renderOutput();
  setStatus(outputHint(mode), "neutral");

  try {
    await chrome.storage.local.set({ outputMode });
  } catch (error) {
    outputMode = previousMode;
    renderOutput();
    setStatus(error.message || String(error), "error");
  } finally {
    outputChangePending = false;
  }
}

async function copyImageToClipboard(url) {
  if (
    !url ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem !== "function"
  ) {
    throw new Error("Chrome could not access the image clipboard.");
  }

  const blobPromise = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error("Chrome could not read the screenshot.");
      return response.blob();
    })
    .then((blob) =>
      blob.type === "image/png"
        ? blob
        : new Blob([blob], { type: "image/png" })
    );

  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blobPromise })
  ]);
}

async function startCapture(mode) {
  setDisabled(true);
  setStatus(statusForMode(mode), "working");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab was found.");

    const response = await chrome.runtime.sendMessage({
      type: "HOLD_STILL_CAPTURE_REQUEST",
      tabId: tab.id,
      mode
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Capture failed.");
    }

    setStatus(
      response.message,
      mode === "selection" ? "working" : "success"
    );

    if (mode === "selection") {
      setTimeout(() => window.close(), 220);
    } else {
      setDisabled(false);
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setDisabled(false);
  }
}

function renderOutput() {
  for (const button of outputButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.output === outputMode)
    );
  }
}

function outputHint(mode) {
  return mode === "copy"
    ? "Captures will be copied as PNG images."
    : "Captures will be saved to Downloads.";
}

function statusForMode(mode) {
  if (mode === "full-page") return "Capturing and stitching the full page...";
  if (mode === "selection") return "Opening the area selector...";
  return "Capturing the current viewport...";
}

function setStatus(message, tone) {
  clearTimeout(statusResetTimer);
  statusResetTimer = null;
  status.textContent = message;
  status.dataset.tone = tone;

  if (tone === "success") {
    statusResetTimer = setTimeout(() => {
      status.textContent = outputHint(outputMode);
      status.dataset.tone = "neutral";
      statusResetTimer = null;
    }, 3000);
  }
}

function setDisabled(disabled) {
  for (const button of [...captureButtons, ...outputButtons]) {
    button.disabled = disabled;
  }
}
