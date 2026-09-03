const MESSAGE = {
  ready: "HOLD_STILL_CROPPER_READY",
  result: "HOLD_STILL_CROPPER_RESULT",
  cancelled: "HOLD_STILL_CROPPER_CANCELLED"
};
const POPUP_CLIPBOARD_MESSAGE = "HOLD_STILL_POPUP_COPY";

const requestId = new URLSearchParams(location.search).get("request");
const shot = document.querySelector("#shot");
const frame = document.querySelector(".frame");
const stage = document.querySelector(".stage");
const selection = document.querySelector("#selection");
const sizeLabel = document.querySelector("#size");
const hint = document.querySelector("#hint");
const cancelButton = document.querySelector("#cancel");

let settled = false;
let dragging = false;
let startX = 0;
let startY = 0;
let currentRect = null;

// This window is a focused extension page, which makes it the best clipboard
// context available while a crop is being delivered. The service worker asks
// the popup first and lands here when the popup is closed.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== POPUP_CLIPBOARD_MESSAGE) return false;

  copyImageToClipboard(message.url).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) })
  );
  return true;
});

async function copyImageToClipboard(url) {
  if (!url || !navigator.clipboard?.write || typeof ClipboardItem !== "function") {
    throw new Error("Chrome could not access the image clipboard.");
  }

  const blobPromise = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error("Chrome could not read the screenshot.");
      return response.blob();
    })
    .then((blob) =>
      blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" })
    );

  await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
}

initialize();

async function initialize() {
  if (!requestId) {
    fail("This selection request is invalid.");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.ready,
      requestId
    });
    if (!response?.ok || !response.dataUrl) {
      throw new Error(response?.error || "This selection request expired.");
    }
    await showCapture(response.dataUrl);
  } catch (error) {
    fail(error?.message || String(error));
  }
}

function showCapture(dataUrl) {
  return new Promise((resolve, reject) => {
    shot.onload = () => {
      fitToStage();
      resolve();
    };
    shot.onerror = () => reject(new Error("Chrome could not show the capture."));
    shot.src = dataUrl;
  });
}

// Scale down to fit, never up: a capture shown larger than life would make the
// selection look sharper than the pixels behind it.
function fitToStage() {
  const styles = getComputedStyle(stage);
  const availableWidth =
    stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  const availableHeight =
    stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);

  const scale = Math.min(
    1,
    availableWidth / shot.naturalWidth,
    availableHeight / shot.naturalHeight
  );

  shot.style.width = Math.max(1, Math.round(shot.naturalWidth * scale)) + "px";
  shot.style.height = Math.max(1, Math.round(shot.naturalHeight * scale)) + "px";
}

window.addEventListener("resize", () => {
  if (!shot.naturalWidth) return;
  fitToStage();
  clearSelection();
});

frame.addEventListener("pointerdown", (event) => {
  if (settled || event.button !== 0 || !shot.naturalWidth) return;
  event.preventDefault();
  frame.setPointerCapture(event.pointerId);

  const point = pointInImage(event);
  startX = point.x;
  startY = point.y;
  dragging = true;
  currentRect = { left: startX, top: startY, width: 0, height: 0 };
  paint(currentRect);
});

frame.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const point = pointInImage(event);
  currentRect = rectFromPoints(startX, startY, point.x, point.y);
  paint(currentRect);
});

frame.addEventListener("pointerup", (event) => {
  if (!dragging) return;
  dragging = false;
  if (frame.hasPointerCapture(event.pointerId)) {
    frame.releasePointerCapture(event.pointerId);
  }

  if (!currentRect || currentRect.width < 4 || currentRect.height < 4) {
    clearSelection();
    return;
  }

  submit(currentRect);
});

cancelButton.addEventListener("click", () => cancel());

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  cancel();
});

window.addEventListener("beforeunload", () => {
  if (settled) return;
  chrome.runtime
    .sendMessage({ type: MESSAGE.cancelled, requestId })
    .catch(() => {});
});

function pointInImage(event) {
  const bounds = shot.getBoundingClientRect();
  return {
    x: clamp(event.clientX - bounds.left, 0, bounds.width),
    y: clamp(event.clientY - bounds.top, 0, bounds.height)
  };
}

function paint(rect) {
  selection.style.display = "block";
  selection.style.left = rect.left + "px";
  selection.style.top = rect.top + "px";
  selection.style.width = rect.width + "px";
  selection.style.height = rect.height + "px";

  const bounds = shot.getBoundingClientRect();
  const scale = shot.naturalWidth / bounds.width;
  sizeLabel.textContent =
    Math.round(rect.width * scale) + " x " + Math.round(rect.height * scale);
  sizeLabel.style.top = rect.top < 34 ? "6px" : "-30px";
}

function clearSelection() {
  selection.style.display = "none";
  currentRect = null;
}

async function submit(rect) {
  settled = true;
  hint.textContent = "Cropping…";
  cancelButton.disabled = true;

  const bounds = shot.getBoundingClientRect();

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.result,
      requestId,
      selection: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        // The offscreen cropper scales by naturalWidth / viewportWidth, so the
        // displayed size is exactly the reference frame it needs.
        viewportWidth: bounds.width,
        viewportHeight: bounds.height
      }
    });

    if (!response?.ok) throw new Error(response?.error || "The crop failed.");
    window.close();
  } catch (error) {
    settled = false;
    cancelButton.disabled = false;
    clearSelection();
    fail(error?.message || String(error), true);
  }
}

function cancel() {
  if (settled) return;
  settled = true;
  chrome.runtime
    .sendMessage({ type: MESSAGE.cancelled, requestId })
    .catch(() => {})
    .then(() => window.close());
}

function fail(message, recoverable = false) {
  hint.textContent = message;
  hint.dataset.tone = "error";
  if (!recoverable) cancelButton.textContent = "Close";
}

function rectFromPoints(x1, y1, x2, y2) {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
