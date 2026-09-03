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
const CAPTURE_QUOTA_PATTERN = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i;
const SETTINGS_VERSION = 2;
const RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const RESTRICTED_PAGE_PATTERN = /cannot access|chrome:\/\/|extension manifest/i;
const RESTRICTED_PAGE_MESSAGE =
  "This page cannot be captured. Try a normal website tab; browser settings and store pages block extensions.";
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

chrome.runtime.onInstalled.addListener(() => {
  migrateSettings().catch(() => {});
});

// Builds before 1.2.0 wrote outputMode: "download" on their own whenever
// clipboardWrite was ungranted, so a stored "download" is usually residue from
// that downgrade rather than a choice the user made. Clear it once so the Copy
// default reaches profiles that ran an earlier build; anything chosen after the
// migration is a real preference and survives later updates.
async function migrateSettings() {
  const stored = await chrome.storage.local.get({ settingsVersion: 1 });
  if (stored.settingsVersion >= SETTINGS_VERSION) return;

  await chrome.storage.local.remove("outputMode");
  await chrome.storage.local.set({ settingsVersion: SETTINGS_VERSION });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId, false);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A new document tears down the content script, so a selection overlay or a
  // running job is gone whether or not the page managed to say so. Without
  // this the tab stays marked busy and every later capture on it is refused.
  if (changeInfo.status === "loading") forgetTab(tabId, true);
});

function forgetTab(tabId, resetBadge) {
  const hadJob = activeJobs.delete(tabId);
  const hadSelection = pendingSelections.delete(tabId);
  if (resetBadge && (hadJob || hadSelection)) clearBadge(tabId);
}

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

  try {
    const output = await getOutputMode();
    let delivered;

    if (mode === "viewport") {
      delivered = await captureViewport(tabId, output);
    } else if (mode === "full-page") {
      delivered = await captureFullPage(tabId, output);
    } else {
      throw new Error("Unknown capture mode.");
    }

    await setBadge(tabId, "OK", "#16a34a");
    setTimeout(() => clearBadge(tabId), 1800);
    return { message: completionMessage(delivered) };
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

  // The toast needs a content script; the capture itself does not. Pages that
  // block injection but allow captureVisibleTab, the Chrome Web Store among
  // them, must still be capturable, so a refused injection costs the
  // confirmation rather than the screenshot.
  const canNotify = await tryEnsureContentScript(tabId);

  const dataUrl = await captureVisible(tab.windowId);
  const delivered = await deliverImage(
    dataUrl,
    makeFilename(tab, "viewport"),
    output,
    false,
    canNotify ? tabId : null
  );

  if (canNotify) {
    notifyTab(
      tabId,
      completionMessage(delivered, "Current viewport"),
      "success"
    );
  }
  return delivered;
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

    const delivered = await deliverImage(
      result.url,
      makeFilename(tab, "selection"),
      output,
      output !== "copy",
      tabId
    );

    await setBadge(tabId, "OK", "#16a34a");
    notifyTab(
      tabId,
      completionMessage(delivered, "Selected area"),
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
    const page = await sendToPage(tabId, { type: MESSAGE.prepareFullPage });
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
        const scrollResult = await sendToPage(tabId, {
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

    const delivered = await deliverImage(
      result.url,
      makeFilename(tab, "full-page"),
      output,
      true,
      tabId
    );

    notifyTab(
      tabId,
      completionMessage(delivered, "Full-page screenshot"),
      "success"
    );
    return delivered;
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

async function sendToPage(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  // The content script reports failures in an error field rather than dropping
  // the port, so surface its reason instead of a generic one.
  if (response?.error) throw new Error(response.error);
  return response;
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
    throw new Error(RESTRICTED_PAGE_MESSAGE);
  }
}

// For work that only wants the content script if it happens to be reachable.
async function tryEnsureContentScript(tabId) {
  try {
    await ensureContentScript(tabId);
    return true;
  } catch {
    return false;
  }
}

async function captureVisible(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    // Chromium caps captureVisibleTab at two calls a second. Drifting past the
    // cap should cost one extra wait, not the whole multi-tile capture.
    if (!CAPTURE_QUOTA_PATTERN.test(friendlyError(error))) {
      throw new Error(captureFailureMessage(error));
    }
  }

  await delay(CAPTURE_INTERVAL_MS);

  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw new Error(captureFailureMessage(error));
  }
}

async function ensureOffscreenDocument() {
  // getContexts landed in Chrome 116, which the manifest requires, so there is
  // no clients.matchAll fallback to keep working here.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });

  if (contexts.length > 0) return;
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
  } catch (error) {
    // Chrome allows one offscreen document per extension. Two captures can
    // still race past the getContexts check, and losing that race is not fatal:
    // the document the capture needs exists either way.
    if (!/single offscreen document/i.test(friendlyError(error))) throw error;
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
  if (output !== "copy") {
    await downloadImage(url, filename, revokeAfterUse);
    return "download";
  }

  try {
    await copyToClipboard(url, tabId);
  } catch {
    // A stitched full page costs the user fifteen seconds of scrolling, so a
    // blocked clipboard should downgrade to a file rather than discard it.
    await downloadImage(url, filename, revokeAfterUse);
    return "copy-fallback";
  }

  if (revokeAfterUse) {
    sendOffscreen({ action: "revoke", url }).catch(() => {});
  }
  return "copy";
}

async function downloadImage(url, filename, revokeAfterUse) {
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

async function copyToClipboard(url, tabId) {
  // An open popup is a focused extension page, the most reliable place to
  // reach the async clipboard.
  if (await tryClipboardPath(() => copyInPopup(url))) return;

  // The offscreen document shares the extension origin, so it can read a
  // stitched blob URL directly. Keyboard shortcuts land here.
  if (await tryClipboardPath(() => sendOffscreen({ action: "copy", url }))) return;

  if (Number.isInteger(tabId)) {
    const copiedInTab = await tryClipboardPath(async () => {
      // Blob URLs belong to the extension origin, so a content script cannot
      // fetch one. Hand the page a data URL it is allowed to read.
      const pageUrl = url.startsWith("blob:")
        ? (await sendOffscreen({ action: "materialize", url })).url
        : url;
      await copyInTab(tabId, pageUrl);
    });
    if (copiedInTab) return;
  }

  throw new Error("Chrome would not let Hold Still reach the clipboard.");
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

// clipboardWrite is a required permission, so there is nothing to check at
// runtime and nothing to downgrade. Reading the default must never write it
// back: an earlier version reset the stored mode here, which quietly erased
// the copy default on a profile's very first capture.
async function getOutputMode() {
  const stored = await chrome.storage.local.get({ outputMode: "copy" });
  return stored.outputMode === "download" ? "download" : "copy";
}

function completionMessage(delivery, subject = "Screenshot") {
  if (delivery === "copy") return subject + " copied to the clipboard.";
  if (delivery === "copy-fallback") {
    return subject + " saved to Downloads because Chrome blocked the clipboard.";
  }
  return subject + " saved to Downloads.";
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
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // No directory segment: screenshots land straight in the browser's download
  // directory. safeTitle strips separators so a page title cannot add one back.
  return safeTitle(tab.title) + " - " + kind + " - " + stamp + ".png";
}

function safeTitle(rawTitle) {
  const cleaned = (rawTitle || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    // Windows silently drops a trailing dot or space from a filename.
    .replace(/[. ]+$/, "")
    .trim();

  if (!cleaned || RESERVED_FILENAME.test(cleaned)) return "webpage";
  return cleaned;
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

// A page that blocks capture outright, such as chrome://settings, deserves the
// same explanation the injection path gives rather than Chrome's raw wording.
function captureFailureMessage(error) {
  const detail = friendlyError(error);
  if (RESTRICTED_PAGE_PATTERN.test(detail)) return RESTRICTED_PAGE_MESSAGE;
  return "Chrome could not capture this tab: " + detail;
}

function friendlyError(error) {
  return error?.message || String(error) || "The screenshot could not be captured.";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
