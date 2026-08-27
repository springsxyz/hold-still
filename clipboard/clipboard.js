const requestId = new URLSearchParams(location.search).get("request");
const title = document.querySelector("#title");
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
let sourceUrl = null;
let copying = false;

retry.addEventListener("click", () => attemptCopy());

initialize();

async function initialize() {
  if (!requestId) {
    showFatal("This copy request is invalid.");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "HOLD_STILL_CLIPBOARD_READY",
      requestId
    });
    if (!response?.ok || !response.url) {
      throw new Error(response?.error || "This copy request expired.");
    }

    sourceUrl = response.url;
    window.focus();
    requestAnimationFrame(() => attemptCopy());
  } catch (error) {
    showFatal(error.message || String(error));
  }
}

async function attemptCopy() {
  if (copying || !sourceUrl) return;
  copying = true;
  retry.disabled = true;
  retry.hidden = true;
  title.textContent = "Copying screenshot…";
  status.textContent = "Hold Still is placing the PNG on your clipboard.";

  try {
    if (
      !navigator.clipboard?.write ||
      typeof ClipboardItem !== "function"
    ) {
      throw new Error("This Chrome version cannot copy PNG images.");
    }

    const blobPromise = fetch(sourceUrl)
      .then((response) => response.blob())
      .then((blob) => blob.type === "image/png"
        ? blob
        : new Blob([blob], { type: "image/png" }));

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blobPromise })
    ]);

    title.textContent = "Copied!";
    status.textContent = "Paste the PNG anywhere with Ctrl+V.";
    await chrome.runtime.sendMessage({
      type: "HOLD_STILL_CLIPBOARD_RESULT",
      requestId,
      ok: true
    });
    setTimeout(() => window.close(), 500);
  } catch (error) {
    title.textContent = "One click needed";
    status.textContent = error?.message
      ? "Chrome blocked the automatic copy. Click below to finish."
      : "Click below to finish copying the PNG.";
    retry.textContent = "Copy image";
    retry.hidden = false;
    retry.disabled = false;
  } finally {
    copying = false;
  }
}

function showFatal(message) {
  title.textContent = "Could not copy";
  status.textContent = message;
  retry.hidden = true;
}
