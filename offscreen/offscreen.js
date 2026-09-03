const stitchJobs = new Map();
const OFFSCREEN_TARGET = "hold-still-offscreen";
const MAX_CANVAS_SIDE = 32767;
const MAX_CANVAS_PIXELS = 160000000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== OFFSCREEN_TARGET) return false;

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error) || "Image processing failed."
      });
    });
  return true;
});

async function handleMessage(message) {
  switch (message.action) {
    case "start-stitch":
      return startStitch(message);
    case "add-tile":
      return addTile(message);
    case "finish-stitch":
      return finishStitch(message.jobId);
    case "cancel-stitch":
      stitchJobs.delete(message.jobId);
      return {};
    case "crop":
      return cropSelection(
        message.dataUrl,
        message.selection,
        message.asDataUrl
      );
    case "materialize":
      return materializeImage(message.url);
    case "copy":
      return copyImageToClipboard(message.url);
    case "revoke":
      if (message.url) URL.revokeObjectURL(message.url);
      return {};
    default:
      throw new Error("Unknown image-processing action.");
  }
}

async function startStitch({ jobId, dataUrl, page, scroll }) {
  if (!jobId || stitchJobs.has(jobId)) {
    throw new Error("The screenshot stitch job is invalid.");
  }

  const image = await loadImage(dataUrl);
  const scaleX = image.naturalWidth / page.windowViewportWidth;
  const scaleY = image.naturalHeight / page.windowViewportHeight;
  const outputWidth = Math.round(page.totalWidth * scaleX);
  const outputHeight = Math.round(page.totalHeight * scaleY);
  validateCanvasSize(outputWidth, outputHeight);

  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Chrome could not create an image canvas.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputWidth, outputHeight);

  const job = { canvas, context, scaleX, scaleY };
  stitchJobs.set(jobId, job);

  try {
    drawTile(job, image, scroll);
  } catch (error) {
    stitchJobs.delete(jobId);
    throw error;
  }

  return { width: outputWidth, height: outputHeight };
}

async function addTile({ jobId, dataUrl, scroll }) {
  const job = stitchJobs.get(jobId);
  if (!job) throw new Error("The screenshot stitch job expired.");

  const image = await loadImage(dataUrl);
  drawTile(job, image, scroll);
  return {};
}

function drawTile(job, image, scroll) {
  const rect = scroll.captureRect;
  const sourceX = clamp(
    Math.round(rect.left * job.scaleX),
    0,
    image.naturalWidth - 1
  );
  const sourceY = clamp(
    Math.round(rect.top * job.scaleY),
    0,
    image.naturalHeight - 1
  );
  const sourceWidth = clamp(
    Math.round(rect.width * job.scaleX),
    1,
    image.naturalWidth - sourceX
  );
  const sourceHeight = clamp(
    Math.round(rect.height * job.scaleY),
    1,
    image.naturalHeight - sourceY
  );

  job.context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    Math.round(scroll.x * job.scaleX),
    Math.round(scroll.y * job.scaleY),
    sourceWidth,
    sourceHeight
  );
}

async function finishStitch(jobId) {
  const job = stitchJobs.get(jobId);
  if (!job) throw new Error("The screenshot stitch job expired.");

  try {
    const blob = await canvasToBlob(job.canvas);
    return {
      url: URL.createObjectURL(blob),
      width: job.canvas.width,
      height: job.canvas.height
    };
  } finally {
    stitchJobs.delete(jobId);
  }
}

async function cropSelection(dataUrl, selection, asDataUrl = false) {
  const image = await loadImage(dataUrl);
  const scaleX = image.naturalWidth / selection.viewportWidth;
  const scaleY = image.naturalHeight / selection.viewportHeight;
  const sourceX = clamp(
    Math.round(selection.left * scaleX),
    0,
    image.naturalWidth - 1
  );
  const sourceY = clamp(
    Math.round(selection.top * scaleY),
    0,
    image.naturalHeight - 1
  );
  const sourceWidth = clamp(
    Math.round(selection.width * scaleX),
    1,
    image.naturalWidth - sourceX
  );
  const sourceHeight = clamp(
    Math.round(selection.height * scaleY),
    1,
    image.naturalHeight - sourceY
  );

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Chrome could not create an image canvas.");

  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight
  );

  if (asDataUrl) {
    return {
      url: canvas.toDataURL("image/png"),
      width: sourceWidth,
      height: sourceHeight
    };
  }

  const blob = await canvasToBlob(canvas);
  return {
    url: URL.createObjectURL(blob),
    width: sourceWidth,
    height: sourceHeight
  };
}

// A blob URL minted here belongs to the extension origin, so a content script
// cannot fetch it. Re-encode the image as a data URL the page is allowed to read.
async function materializeImage(url) {
  if (!url) throw new Error("The screenshot image is missing.");

  const image = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  validateCanvasSize(canvas.width, canvas.height);

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Chrome could not create an image canvas.");
  context.drawImage(image, 0, 0);

  return {
    url: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height
  };
}

async function copyImageToClipboard(url) {
  if (!url) throw new Error("The screenshot image is missing.");

  const image = await loadImage(url);
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = [
    "position:fixed",
    "left:-100000px",
    "top:0",
    "width:" + image.naturalWidth + "px",
    "height:" + image.naturalHeight + "px",
    "overflow:hidden",
    "opacity:0",
    "pointer-events:none"
  ].join(";");
  image.alt = "";
  image.draggable = false;
  holder.appendChild(image);
  document.body.appendChild(holder);

  const selection = window.getSelection();
  const range = document.createRange();

  try {
    range.selectNode(image);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand("copy")) {
      throw new Error("Chrome could not copy the PNG.");
    }
  } finally {
    selection.removeAllRanges();
    holder.remove();
  }

  return {};
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Chrome could not decode a captured tile."));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Chrome could not encode the screenshot as PNG."));
      }
    }, "image/png");
  });
}

function validateCanvasSize(width, height) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_CANVAS_SIDE ||
    height > MAX_CANVAS_SIDE ||
    width * height > MAX_CANVAS_PIXELS
  ) {
    throw new Error(
      "This page is too large for one PNG. Zoom out or capture it in selected sections."
    );
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
