const activeJobs = new Set();
const pendingSelections = new Set();

const MESSAGE = {
  ping: "HOLD_STILL_PING",
  beginSelection: "HOLD_STILL_BEGIN_SELECTION",
  copyImage: "HOLD_STILL_COPY_IMAGE",
  areaSelected: "HOLD_STILL_AREA_SELECTED",
  selectionCancelled: "HOLD_STILL_SELECTION_CANCELLED",
  prepareFullPage: "HOLD_STILL_PREPARE_FULL_PAGE",
  scrollTo: "HOLD_STILL_SCROLL_TO",
  hideFixed: "HOLD_STILL_HIDE_FIXED",
  restorePage: "HOLD_STILL_RESTORE_PAGE",
  toast: "HOLD_STILL_TOAST"
};

const OFFSCREEN_PATH = "offscreen/offscreen.html";
const OFFSCREEN_TARGET = "hold-still-offscreen";
const POPUP_CLIPBOARD_MESSAGE = "HOLD_STILL_POPUP_COPY";
const CAPTURE_INTERVAL_MS = 560;
const MAX_CANVAS_SIDE = 32767;
const MAX_CANVAS_PIXELS = 160000000;
let creatingOffscreenDocument = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "HOLD_STILL_CAPTURE_REQUEST") {
    runMode(message.tabId, message.mode)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message?.type === MESSAGE.areaSelected && sender.tab?.id) {
    captureSelectedArea(sender.tab.id, message.selection).catch((error) => {
      reportFailure(sender.tab.id, error);
    });
  }

  if (message?.type === MESSAGE.selectionCancelled && sender.tab?.id) {
    pendingSelections.delete(sender.tab.id);
    clearBadge(sender.tab.id);
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  const modeByCommand = {
    "capture-full-page": "full-page",
    "capture-viewport": "viewport",
    "capture-selection": "selection"
  };
  const mode = modeByCommand[command];
  if (!mode) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  runMode(tab.id, mode).catch((error) => reportFailure(tab.id, error));
});


async function runMode(tabId, mode) {
  if (!Number.isInteger(tabId)) throw new Error("No active tab was found.");
  if (activeJobs.has(tabId) || pendingSelections.has(tabId)) {
    throw new Error("A capture is already in progress on this tab.");
  }

  if (mode === "selection") {
    pendingSelections.add(tabId);
    try {
      await ensureContentScript(tabId);
      await chrome.tabs.sendMessage(tabId, { type: MESSAGE.beginSelection });
      await setBadge(tabId, "SEL", "#2563eb");
      return { message: "Draw a box over the area you want to capture." };
    } catch (error) {
      pendingSelections.delete(tabId);
      throw error;
    }
  }

  activeJobs.add(tabId);
  await setBadge(tabId, "...", "#2563eb");
  let output = "download";

  try {
    output = await getOutputMode();
    if (mode === "viewport") {
      await captureViewport(tabId, output);
    } else if (mode === "full-page") {
      await captureFullPage(tabId, output);
    } else {
      throw new Error("Unknown capture mode.");
    }

    await setBadge(tabId, "OK", "#16a34a");
    setTimeout(() => clearBadge(tabId), 1800);
    return { message: completionMessage(output) };
  } catch (error) {
    await setBadge(tabId, "!", "#dc2626");
    setTimeout(() => clearBadge(tabId), 3500);
    throw error;
  } finally {
    activeJobs.delete(tabId);
  }
}

async function captureViewport(tabId, output) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await captureVisible(tab.windowId);
  await deliverImage(
    dataUrl,
    makeFilename(tab, "viewport"),
    output,
    false,
    tabId
  );
}

async function captureSelectedArea(tabId, selection) {
  pendingSelections.delete(tabId);
  if (activeJobs.has(tabId)) return;

  activeJobs.add(tabId);
  await setBadge(tabId, "...", "#2563eb");

  try {
    validateSelection(selection);
    const output = await getOutputMode();
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await captureVisible(tab.windowId);
    const result = await sendOffscreen({
      action: "crop",
      dataUrl,
      selection,
      asDataUrl: output === "copy"
    });

    await deliverImage(
      result.url,
      makeFilename(tab, "selection"),
      output,
      output !== "copy",
      tabId
    );

    await setBadge(tabId, "OK", "#16a34a");
    notifyTab(
      tabId,
      completionMessage(output, "Selected area"),
      "success"
    );
    setTimeout(() => clearBadge(tabId), 1800);
  } catch (error) {
    await reportFailure(tabId, error);
  } finally {
    activeJobs.delete(tabId);
  }
}

async function captureFullPage(tabId, output) {
  await ensureContentScript(tabId);

  const stitchJobId = crypto.randomUUID();
  let prepared = false;
  let stitchStarted = false;
  let stitchFinished = false;
  let lastCaptureAt = 0;

  try {
    const page = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE.prepareFullPage
    });
    validatePageMetrics(page);
    prepared = true;

    const tab = await chrome.tabs.get(tabId);
    const xPositions = tilePositions(page.totalWidth, page.viewportWidth);
    const yPositions = tilePositions(page.totalHeight, page.viewportHeight);
    const tileCount = xPositions.length * yPositions.length;
    let tileNumber = 0;
    let firstTile = true;

    for (const y of yPositions) {
      for (const x of xPositions) {
        const scrollResult = await chrome.tabs.sendMessage(tabId, {
          type: MESSAGE.scrollTo,
          x,
          y
        });
        validateScrollResult(scrollResult);

        const remainingDelay = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
        if (remainingDelay > 0) await delay(remainingDelay);

        const dataUrl = await captureVisible(tab.windowId);
        lastCaptureAt = Date.now();

        if (!stitchStarted) {
          await sendOffscreen({
            action: "start-stitch",
            jobId: stitchJobId,
            dataUrl,
            page,
            scroll: scrollResult
          });
          stitchStarted = true;
        } else {
          await sendOffscreen({
            action: "add-tile",
            jobId: stitchJobId,
            dataUrl,
            scroll: scrollResult
          });
        }

        tileNumber += 1;
        const progress = Math.round((tileNumber / tileCount) * 100);
        await setBadge(tabId, progress + "%", "#2563eb");

        if (firstTile) {
          firstTile = false;
          await chrome.tabs.sendMessage(tabId, { type: MESSAGE.hideFixed });
        }
      }
    }

    const result = await sendOffscreen({
      action: "finish-stitch",
      jobId: stitchJobId
    });
    stitchFinished = true;

    await deliverImage(
      result.url,
      makeFilename(tab, "full-page"),
      output,
      true,
      tabId
    );

    notifyTab(
      tabId,
      completionMessage(output, "Full-page screenshot"),
      "success"
    );
  } finally {
    if (stitchStarted && !stitchFinished) {
      sendOffscreen({
        action: "cancel-stitch",
        jobId: stitchJobId
      }).catch(() => {});
    }
    if (prepared) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: MESSAGE.restorePage });
      } catch {
        // The tab may have navigated or closed during capture.
      }
    }
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE.ping });
    return;
  } catch {
    // Inject below when the page does not already have the content script.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE.ping });
  } catch {
    throw new Error(
      "This page cannot be captured. Try a normal website tab; browser settings and store pages block extensions."
    );
  }
}

async function captureVisible(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw new Error("Chrome could not capture this tab: " + friendlyError(error));
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  let exists = false;

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    exists = contexts.length > 0;
  } else {
    const matchedClients = await clients.matchAll();
    exists = matchedClients.some((client) => client.url === offscreenUrl);
  }

  if (exists) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS", "CLIPBOARD"],
    justification: "Process screenshots and copy PNG images without opening a window."
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function sendOffscreen(payload) {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    ...payload
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Chrome could not process the screenshot.");
  }

  return result;
}

async function downloadUrl(url, filename) {
  return chrome.downloads.download({ url, filename, saveAs: false });
}

async function deliverImage(url, filename, output, revokeAfterUse, tabId = null) {
  if (output === "copy") {
    try {
      let copied = await tryClipboardPath(() => copyInPopup(url));
      if (!copied && Number.isInteger(tabId)) {
        copied = await tryClipboardPath(() => copyInTab(tabId, url));
      }
      if (!copied) {
        await sendOffscreen({
          action: "copy",
          url
        });
      }
    } finally {
      if (revokeAfterUse) {
        sendOffscreen({ action: "revoke", url }).catch(() => {});
      }
    }
    return;
  }

  try {
    const downloadId = await downloadUrl(url, filename);
    if (revokeAfterUse) {
      releaseUrlAfterDownload(downloadId, url);
    }
  } catch (error) {
    if (revokeAfterUse) {
      sendOffscreen({ action: "revoke", url }).catch(() => {});
    }
    throw error;
  }
}


async function copyInPopup(url) {
  const response = await chrome.runtime.sendMessage({
    type: POPUP_CLIPBOARD_MESSAGE,
    url
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The extension popup is not available.");
  }
}

async function copyInTab(tabId, url) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: MESSAGE.copyImage,
    url
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The webpage clipboard is unavailable.");
  }
}

async function tryClipboardPath(action) {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

async function getOutputMode() {
  const stored = await chrome.storage.local.get({ outputMode: "download" });
  if (stored.outputMode !== "copy") return "download";

  const granted = await chrome.permissions.contains({
    permissions: ["clipboardWrite"]
  });
  if (granted) return "copy";

  await chrome.storage.local.set({ outputMode: "download" });
  return "download";
}

function completionMessage(output, subject = "Screenshot") {
  return output === "copy"
    ? subject + " copied to the clipboard."
    : subject + " saved to Downloads.";
}

function releaseUrlAfterDownload(downloadId, url) {
  let released = false;
  let timeoutId;

  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timeoutId);
    chrome.downloads.onChanged.removeListener(onChanged);
    sendOffscreen({ action: "revoke", url }).catch(() => {});
  };

  const onChanged = (delta) => {
    if (
      delta.id === downloadId &&
      ["complete", "interrupted"].includes(delta.state?.current)
    ) {
      release();
    }
  };

  chrome.downloads.onChanged.addListener(onChanged);
  timeoutId = setTimeout(release, 120000);
}

function makeFilename(tab, kind) {
  const title = (tab.title || "webpage")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "webpage";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return "Hold Still/" + title + " - " + kind + " - " + stamp + ".png";
}

function tilePositions(total, viewport) {
  if (total <= viewport) return [0];
  const positions = [];
  const finalPosition = total - viewport;
  for (let position = 0; position < finalPosition; position += viewport) {
    positions.push(position);
  }
  positions.push(finalPosition);
  return [...new Set(positions)];
}

function validateSelection(selection) {
  const values = [
    selection?.left,
    selection?.top,
    selection?.width,
    selection?.height,
    selection?.viewportWidth,
    selection?.viewportHeight
  ];
  if (!values.every(Number.isFinite) || selection.width < 2 || selection.height < 2) {
    throw new Error("The selected area was too small to capture.");
  }
}

function validatePageMetrics(page) {
  const values = [
    page?.totalWidth,
    page?.totalHeight,
    page?.viewportWidth,
    page?.viewportHeight,
    page?.windowViewportWidth,
    page?.windowViewportHeight
  ];
  if (!values.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Could not measure this page.");
  }
  validateCaptureRect(page.captureRect);
}

function validateScrollResult(scrollResult) {
  if (
    !Number.isFinite(scrollResult?.x) ||
    !Number.isFinite(scrollResult?.y)
  ) {
    throw new Error("The page did not scroll to the requested position.");
  }
  validateCaptureRect(scrollResult.captureRect);
}

function validateCaptureRect(rect) {
  const values = [rect?.left, rect?.top, rect?.width, rect?.height];
  if (
    !values.every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error("Could not locate the visible page area.");
  }
}

function validateCanvasSize(width, height) {
  if (
    width > MAX_CANVAS_SIDE ||
    height > MAX_CANVAS_SIDE ||
    width * height > MAX_CANVAS_PIXELS
  ) {
    throw new Error(
      "This page is too large for one PNG. Zoom out or capture it in selected sections."
    );
  }
}

async function reportFailure(tabId, error) {
  pendingSelections.delete(tabId);
  const message = friendlyError(error);
  await setBadge(tabId, "!", "#dc2626");
  notifyTab(tabId, message, "error");
  setTimeout(() => clearBadge(tabId), 3500);
}

function notifyTab(tabId, message, tone) {
  chrome.tabs.sendMessage(tabId, { type: MESSAGE.toast, message, tone }).catch(() => {});
}

async function setBadge(tabId, text, color) {
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color })
  ]);
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

function friendlyError(error) {
  return error?.message || String(error) || "The screenshot could not be captured.";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
