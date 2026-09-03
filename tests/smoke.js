const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const packageJson = JSON.parse(read("package.json"));

const shippedSources = [
  "src/background.js",
  "src/content.js",
  "popup/popup.js",
  "offscreen/offscreen.js"
];

const backgroundSource = read("src/background.js");
const contentSource = read("src/content.js");
const offscreenSource = read("offscreen/offscreen.js");
const popupSource = read("popup/popup.js");

/* ------------------------------------------------------------------ manifest */

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, "Hold Still");
assert.equal(
  manifest.version,
  packageJson.version,
  "manifest.json and package.json versions must match"
);

const versionParts = manifest.version.split(".");
assert.equal(versionParts.length, 3, "version must be major.minor.patch");
assert.ok(
  versionParts.every((part) => part.length > 0 && Number.isInteger(Number(part))),
  "version parts must be integers"
);

// clipboardWrite is required rather than optional. Copy is the default output,
// and an optional permission would silently downgrade it on a fresh profile.
assert.ok(
  !("optional_permissions" in manifest),
  "clipboardWrite belongs in permissions now"
);
assert.deepEqual(
  [...manifest.permissions].sort(),
  [
    "activeTab",
    "clipboardWrite",
    "downloads",
    "offscreen",
    "scripting",
    "storage"
  ].sort()
);

// chrome.runtime.getContexts is a Chrome 116 API. The manifest floor and the
// code that depends on it have to move together.
assert.equal(manifest.minimum_chrome_version, "116");
assert.ok(
  backgroundSource.includes("chrome.runtime.getContexts"),
  "the offscreen lookup uses getContexts"
);
// The call form, not the bare name: the comment above it still says why the
// fallback was dropped.
assert.ok(
  !backgroundSource.includes("clients.matchAll("),
  "the pre-116 offscreen lookup fallback is gone"
);

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  "offscreen/offscreen.html",
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon)
];

for (const relativePath of referencedFiles) {
  assert.ok(
    fs.existsSync(path.join(root, relativePath)),
    "Missing manifest file: " + relativePath
  );
}

// The window-based copy flow was removed; its page must not ship with the package.
assert.ok(
  !fs.existsSync(path.join(root, "clipboard")),
  "clipboard/ is unreachable and must not ship"
);

/* -------------------------------------------------------------------- syntax */

for (const relativePath of shippedSources) {
  new vm.Script(read(relativePath), { filename: relativePath });
}

// A stray control character makes tooling treat a source file as binary and
// draws review attention that a screenshot extension does not need.
for (const relativePath of shippedSources) {
  const text = read(relativePath);
  const offenders = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) offenders.push(index);
  }
  assert.equal(
    offenders.length,
    0,
    "Control characters in " + relativePath + " at offset " + offenders.join(", ")
  );
}

/* -------------------------------------------------------- background runtime */

const listeners = {};
const badgeWrites = [];
const storageBacking = {};

const sandbox = {
  chrome: {
    storage: {
      local: {
        get(defaults) {
          const result = { ...defaults };
          for (const key of Object.keys(defaults)) {
            if (key in storageBacking) result[key] = storageBacking[key];
          }
          return Promise.resolve(result);
        },
        set(values) {
          Object.assign(storageBacking, values);
          return Promise.resolve();
        },
        remove(keys) {
          for (const key of [].concat(keys)) delete storageBacking[key];
          return Promise.resolve();
        }
      }
    },
    runtime: {
      onInstalled: {
        addListener(listener) {
          listeners.installed = listener;
        }
      },
      getURL(relativePath) {
        return "chrome-extension://hold-still/" + relativePath;
      },
      onMessage: {
        addListener(listener) {
          listeners.message = listener;
        }
      }
    },
    commands: {
      onCommand: {
        addListener(listener) {
          listeners.command = listener;
        }
      }
    },
    tabs: {
      onRemoved: {
        addListener(listener) {
          listeners.tabRemoved = listener;
        }
      },
      onUpdated: {
        addListener(listener) {
          listeners.tabUpdated = listener;
        }
      },
      sendMessage() {
        return Promise.resolve({ ok: true });
      }
    },
    action: {
      setBadgeText(details) {
        badgeWrites.push(details);
        return Promise.resolve();
      },
      setBadgeBackgroundColor() {
        return Promise.resolve();
      }
    },
    downloads: {
      onChanged: { addListener() {}, removeListener() {} }
    }
  },
  console,
  crypto: {
    randomUUID() {
      return "stitch-job-test";
    }
  },
  setTimeout,
  clearTimeout
};

vm.createContext(sandbox);
vm.runInContext(backgroundSource, sandbox, { filename: "src/background.js" });

assert.equal(typeof listeners.message, "function");
assert.equal(typeof listeners.command, "function");
assert.equal(typeof listeners.tabRemoved, "function", "tab close must be observed");
assert.equal(typeof listeners.tabUpdated, "function", "navigation must be observed");

assert.deepEqual(Array.from(sandbox.tilePositions(800, 1000)), [0]);
assert.deepEqual(Array.from(sandbox.tilePositions(2500, 1000)), [0, 1000, 1500]);

assert.equal(sandbox.completionMessage("copy"), "Screenshot copied to the clipboard.");
assert.equal(sandbox.completionMessage("download"), "Screenshot saved to Downloads.");
assert.equal(
  sandbox.completionMessage("copy", "Selected area"),
  "Selected area copied to the clipboard."
);
assert.match(
  sandbox.completionMessage("copy-fallback"),
  /blocked the clipboard/,
  "a downgraded copy must not claim the clipboard worked"
);

assert.equal(sandbox.safeTitle("Hello / World"), "Hello World");
assert.equal(sandbox.safeTitle("keep-hyphens-intact"), "keep-hyphens-intact");
assert.equal(sandbox.safeTitle(""), "webpage");
assert.equal(sandbox.safeTitle("???"), "webpage");
assert.equal(sandbox.safeTitle("NUL"), "webpage", "Windows device names are not filenames");
assert.equal(sandbox.safeTitle("com1"), "webpage");
assert.equal(sandbox.safeTitle("Quarterly report."), "Quarterly report");
assert.equal(
  sandbox.safeTitle("Bell" + String.fromCharCode(7) + "title"),
  "Bell title",
  "control characters must not reach the filename"
);

const viewportFilename = sandbox.makeFilename({ title: "Example Page" }, "viewport");
assert.ok(
  !viewportFilename.includes("/"),
  "screenshots land in the Downloads directory itself, not a subfolder"
);
assert.ok(viewportFilename.startsWith("Example Page - viewport - "));
assert.ok(viewportFilename.endsWith(".png"));

// A separator in the page title must not put a directory back into the path.
for (const title of ["a/b", "..", "", "C:" + String.fromCharCode(92) + "temp"]) {
  const filename = sandbox.makeFilename({ title }, "full-page");
  assert.ok(
    !filename.includes("/"),
    "title " + JSON.stringify(title) + " produced a path: " + filename
  );
  assert.ok(!filename.startsWith("."), "filename must not start with a dot");
}

async function selectionLifecycle() {
  const first = await sandbox.runMode(7, "selection");
  assert.match(first.message, /Draw a box/);

  await assert.rejects(
    sandbox.runMode(7, "selection"),
    /already in progress/,
    "a live overlay blocks a second capture on the same tab"
  );

  // Regression: navigating away destroys the overlay without the content script
  // reporting it. The tab used to stay blocked until the worker restarted.
  listeners.tabUpdated(7, { status: "loading" });
  const afterNavigation = await sandbox.runMode(7, "selection");
  assert.match(
    afterNavigation.message,
    /Draw a box/,
    "navigation must release a stranded selection"
  );

  listeners.tabRemoved(7);
  const afterClose = await sandbox.runMode(7, "selection");
  assert.match(
    afterClose.message,
    /Draw a box/,
    "closing the tab must release a stranded selection"
  );

  // A same-document update is not a teardown, so the overlay stays live.
  listeners.tabUpdated(7, { status: "complete" });
  await assert.rejects(
    sandbox.runMode(7, "selection"),
    /already in progress/,
    "a non-navigation update must not cancel a live overlay"
  );
}

async function outputDefaults() {
  // Regression: getOutputMode used to reset an ungranted copy preference to
  // download and persist it, which erased the default on the first capture.
  assert.equal(await sandbox.getOutputMode(), "copy", "a fresh profile copies");
  assert.deepEqual(
    storageBacking,
    {},
    "reading the default must not write anything back"
  );

  storageBacking.outputMode = "download";
  assert.equal(await sandbox.getOutputMode(), "download");

  storageBacking.outputMode = "copy";
  assert.equal(await sandbox.getOutputMode(), "copy");

  delete storageBacking.outputMode;
}

async function settingsMigration() {
  // A profile carrying the old auto-downgraded preference lands on the new
  // default rather than keeping residue from a permission check that is gone.
  storageBacking.outputMode = "download";
  await sandbox.migrateSettings();
  assert.ok(
    !("outputMode" in storageBacking),
    "the residual download preference is cleared once"
  );
  assert.equal(storageBacking.settingsVersion, 2);
  assert.equal(await sandbox.getOutputMode(), "copy");

  // A choice made after the migration is real and must survive later updates.
  storageBacking.outputMode = "download";
  await sandbox.migrateSettings();
  assert.equal(
    storageBacking.outputMode,
    "download",
    "the migration runs once, not on every update"
  );
  assert.equal(await sandbox.getOutputMode(), "download");

  delete storageBacking.outputMode;
  delete storageBacking.settingsVersion;
}

/* ---------------------------------------------------------- background shape */

// The canvas guard belongs to the offscreen document, the only context that
// builds a canvas. The service worker must not carry a second, dead copy.
assert.ok(
  !backgroundSource.includes("function validateCanvasSize"),
  "validateCanvasSize was dead code in the service worker"
);
assert.ok(offscreenSource.includes("function validateCanvasSize"));

const copyOrder = backgroundSource.slice(
  backgroundSource.indexOf("async function copyToClipboard"),
  backgroundSource.indexOf("async function copyInPopup")
);
assert.ok(copyOrder.length > 0, "copyToClipboard must precede copyInPopup");
assert.ok(
  copyOrder.indexOf("copyInPopup") < copyOrder.indexOf('action: "copy"'),
  "a focused popup is tried before the offscreen document"
);
assert.ok(
  copyOrder.indexOf('action: "copy"') < copyOrder.indexOf("copyInTab"),
  "the offscreen document is tried before the page"
);
// A content script cannot fetch a blob URL minted on the extension origin.
assert.ok(copyOrder.includes('action: "materialize"'));
assert.ok(copyOrder.includes('startsWith("blob:")'));

assert.ok(
  backgroundSource.includes('return "copy-fallback"'),
  "a blocked clipboard downgrades to a file instead of losing the capture"
);
assert.ok(
  backgroundSource.includes("CAPTURE_QUOTA_PATTERN"),
  "captureVisibleTab is rate limited and needs one retry"
);
assert.ok(backgroundSource.includes("async function sendToPage"));
assert.ok(
  backgroundSource.includes("single offscreen document"),
  "losing the offscreen creation race must not fail the capture"
);
assert.ok(!backgroundSource.includes("chrome.windows.create"));
assert.ok(backgroundSource.includes('reasons: ["BLOBS", "CLIPBOARD"]'));

const viewportCaptureSource = backgroundSource.slice(
  backgroundSource.indexOf("async function captureViewport"),
  backgroundSource.indexOf("async function captureSelectedArea")
);
assert.ok(viewportCaptureSource.includes("await ensureContentScript(tabId)"));
assert.ok(viewportCaptureSource.includes('completionMessage(delivered, "Current viewport")'));
assert.ok(viewportCaptureSource.includes("notifyTab("));

/* ------------------------------------------------------------- content shape */

assert.ok(contentSource.includes("findPrimaryScrollContainer"));
assert.ok(contentSource.includes("HOLD_STILL_COPY_IMAGE"));
assert.ok(contentSource.includes("navigator.clipboard.write"));
assert.ok(contentSource.includes("range.selectNode(image)"));
assert.ok(contentSource.includes("right:20px"));
assert.ok(contentSource.includes("bottom:20px"));

// Failures answer the port instead of rejecting into a dropped channel.
assert.ok(contentSource.includes("function failure("));
assert.ok(
  contentSource.includes("sendResponse(failure(error))"),
  "prepare and scroll must report their own failures"
);

// The tile stride follows what is actually captured, not the panel's full width.
assert.ok(contentSource.includes(": captureRect.width"));
assert.ok(contentSource.includes(": captureRect.height"));

// innerHTML in a content script is a review flag; build nodes instead.
assert.ok(!contentSource.includes("innerHTML"), "content script must not use innerHTML");

/* ----------------------------------------------------------- offscreen logic */

let offscreenMessageListener;
let drawnTile;
const offscreenSandbox = {
  chrome: {
    runtime: {
      onMessage: {
        addListener(listener) {
          offscreenMessageListener = listener;
        }
      }
    }
  },
  console,
  URL,
  Blob,
  Image: function Image() {}
};

vm.createContext(offscreenSandbox);
vm.runInContext(offscreenSource, offscreenSandbox, { filename: "offscreen/offscreen.js" });

assert.equal(typeof offscreenMessageListener, "function");

offscreenSandbox.drawTile(
  {
    scaleX: 2,
    scaleY: 2,
    context: {
      drawImage(...argumentsList) {
        drawnTile = argumentsList;
      }
    }
  },
  { naturalWidth: 2400, naturalHeight: 1600 },
  {
    x: 30,
    y: 400,
    captureRect: { left: 100, top: 50, width: 800, height: 600 }
  }
);
assert.deepEqual(
  Array.from(drawnTile.slice(1)),
  [200, 100, 1600, 1200, 60, 800, 1600, 1200]
);

assert.throws(() => offscreenSandbox.validateCanvasSize(40000, 100), /too large/);
assert.throws(() => offscreenSandbox.validateCanvasSize(0, 100), /too large/);

assert.ok(offscreenSource.includes('case "materialize"'));
assert.ok(offscreenSource.includes("URL.createObjectURL"));
assert.ok(offscreenSource.includes('canvas.toDataURL("image/png")'));
assert.ok(offscreenSource.includes('document.execCommand("copy")'));

const materializeSource = offscreenSource.slice(
  offscreenSource.indexOf("async function materializeImage"),
  offscreenSource.indexOf("async function copyImageToClipboard")
);
assert.ok(
  materializeSource.includes("toDataURL"),
  "materialize must hand the page a URL it is allowed to read"
);
assert.ok(
  !materializeSource.includes("createObjectURL"),
  "a blob URL is exactly what materialize exists to avoid"
);

/* --------------------------------------------------------------- popup shape */

const chooseOutputSource = popupSource.slice(
  popupSource.indexOf("async function chooseOutput"),
  popupSource.indexOf("async function copyImageToClipboard")
);
assert.ok(chooseOutputSource.length > 0);
// The toggle paints before it persists, so the button never lags the click.
assert.ok(
  chooseOutputSource.indexOf("renderOutput()") <
    chooseOutputSource.indexOf("chrome.storage.local.set")
);
assert.ok(chooseOutputSource.includes("previousMode"), "a failed write rolls back");
assert.ok(!chooseOutputSource.includes("setDisabled"));
assert.ok(chooseOutputSource.includes("outputChangePending"));

// Nothing negotiates clipboard access at runtime any more.
assert.ok(
  !popupSource.includes("chrome.permissions"),
  "clipboardWrite is granted at install; the popup must not request it"
);
assert.ok(
  !backgroundSource.includes("chrome.permissions"),
  "output must not be gated on an optional permission"
);

assert.ok(popupSource.includes("statusResetTimer = setTimeout"));
assert.ok(popupSource.includes("HOLD_STILL_POPUP_COPY"));
assert.ok(popupSource.includes("navigator.clipboard.write"));

const popupHtml = read("popup/popup.html");
for (const marker of [
  'data-mode="full-page"',
  'data-mode="viewport"',
  'data-mode="selection"',
  'data-output="download"',
  'data-output="copy"'
]) {
  assert.ok(popupHtml.includes(marker), "popup.html is missing " + marker);
}

assert.ok(
  popupHtml.indexOf('data-output="copy"') < popupHtml.indexOf('data-output="download"'),
  "Copy is the default output and reads first"
);
assert.ok(
  popupHtml.indexOf('data-output="copy"') <
    popupHtml.indexOf('aria-pressed="false"'),
  "Copy carries the pressed state in the served markup"
);

/* --------------------------------------------------------------------- icons */

for (const size of [16, 32, 48, 128]) {
  const png = fs.readFileSync(path.join(root, "icons", "icon" + size + ".png"));
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}

assert.equal(
  typeof listeners.installed,
  "function",
  "the settings migration must run on install and update"
);

selectionLifecycle()
  .then(outputDefaults)
  .then(settingsMigration)
  .then(() => {
    console.log("Hold Still smoke tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
