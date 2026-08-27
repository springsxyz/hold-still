const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, "Hold Still");
assert.equal(manifest.version, "1.1.10");
assert.deepEqual(manifest.optional_permissions, ["clipboardWrite"]);
assert.deepEqual(
  [...manifest.permissions].sort(),
  ["activeTab", "downloads", "offscreen", "scripting", "storage"].sort()
);

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  "offscreen/offscreen.html",
  "clipboard/clipboard.html",
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon)
];

for (const relativePath of referencedFiles) {
  assert.ok(
    fs.existsSync(path.join(root, relativePath)),
    "Missing manifest file: " + relativePath
  );
}

for (const relativePath of [
  "src/background.js",
  "src/content.js",
  "popup/popup.js",
  "offscreen/offscreen.js",
  "clipboard/clipboard.js"
]) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  new vm.Script(source, { filename: relativePath });
}

const listeners = {};
const sandbox = {
  chrome: {
    runtime: {
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
    tabs: {},
    action: {},
    windows: {
      onRemoved: {
        addListener(listener) {
          listeners.windowRemoved = listener;
        }
      },
      create() {
        return Promise.resolve({ id: 99 });
      },
      remove() {
        return Promise.resolve();
      }
    }
  },
  console,
  crypto: {
    randomUUID() {
      return "copy-request-test";
    }
  },
  setTimeout,
  clearTimeout
};

vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(root, "src/background.js"), "utf8"),
  sandbox,
  { filename: "src/background.js" }
);

assert.equal(typeof listeners.message, "function");
assert.equal(typeof listeners.command, "function");
assert.deepEqual(Array.from(sandbox.tilePositions(800, 1000)), [0]);
assert.deepEqual(Array.from(sandbox.tilePositions(2500, 1000)), [0, 1000, 1500]);
assert.throws(() => sandbox.validateCanvasSize(40000, 100), /too large/);
assert.equal(sandbox.completionMessage("copy"), "Screenshot copied to the clipboard.");
assert.equal(sandbox.completionMessage("download"), "Screenshot saved to Downloads.");

const copyPromise = Promise.resolve(); /*
const copyPromise = sandbox.copyInFocusedWindow("blob:hold-still-test");
let clipboardReadyResponse;
listeners.message(
  {
    type: "HOLD_STILL_CLIPBOARD_READY",
    requestId: "copy-request-test"
  },
  {
    url: "chrome-extension://hold-still/clipboard/clipboard.html?request=copy-request-test"
  },
  (response) => {
    clipboardReadyResponse = response;
  }
);
assert.equal(clipboardReadyResponse.ok, true);
assert.equal(clipboardReadyResponse.url, "blob:hold-still-test");
listeners.message(
  {
    type: "HOLD_STILL_CLIPBOARD_RESULT",
    requestId: "copy-request-test",
    ok: true
  },
  {
    url: "chrome-extension://hold-still/clipboard/clipboard.html?request=copy-request-test"
  },
  () => {}
);
*/

const contentSource = fs.readFileSync(path.join(root, "src/content.js"), "utf8");
assert.match(contentSource, /findPrimaryScrollContainer/);
assert.match(contentSource, /captureRect: getCaptureRect\(\)/);
assert.match(contentSource, /HOLD_STILL_COPY_IMAGE/);
assert.match(contentSource, /navigator\.clipboard\.write/);
assert.match(contentSource, /range\.selectNode\(image\)/);
assert.match(contentSource, /document\.execCommand\("copy"\)/);

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
vm.runInContext(
  fs.readFileSync(path.join(root, "offscreen/offscreen.js"), "utf8"),
  offscreenSandbox,
  { filename: "offscreen/offscreen.js" }
);

assert.equal(typeof offscreenMessageListener, "function");
const offscreenSource = fs.readFileSync(
  path.join(root, "offscreen/offscreen.js"),
  "utf8"
);
assert.match(offscreenSource, /case "materialize"/);
assert.match(offscreenSource, /URL\.createObjectURL/);
assert.match(offscreenSource, /canvas\.toDataURL\("image\/png"\)/);
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
assert.throws(
  () => offscreenSandbox.validateCanvasSize(40000, 100),
  /too large/
);

for (const size of [16, 32, 48, 128]) {
  const png = fs.readFileSync(path.join(root, "icons", "icon" + size + ".png"));
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}

const popupScript = fs.readFileSync(
  path.join(root, "popup", "popup.js"),
  "utf8"
);
const chooseOutputSource = popupScript.slice(
  popupScript.indexOf("async function chooseOutput"),
  popupScript.indexOf("async function startCapture")
);
assert.ok(
  chooseOutputSource.indexOf("outputMode = mode") <
    chooseOutputSource.indexOf("chrome.permissions.request")
);
assert.ok(
  chooseOutputSource.indexOf("chrome.storage.local.set") <
    chooseOutputSource.indexOf("chrome.permissions.request")
);
assert.doesNotMatch(chooseOutputSource, /setDisabled/);
assert.match(chooseOutputSource, /needsPermission/);
assert.match(chooseOutputSource, /outputChangePending/);

const popup = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
assert.match(popup, /data-mode="full-page"/);
assert.match(popup, /data-mode="viewport"/);
assert.match(popup, /data-mode="selection"/);
assert.match(popup, /data-output="download"/);
assert.match(popup, /data-output="copy"/);

const clipboardSource = fs.readFileSync(
  path.join(root, "clipboard/clipboard.js"),
  "utf8"
);
assert.match(clipboardSource, /navigator\.clipboard\.write/);
assert.match(clipboardSource, /new ClipboardItem/);
assert.match(clipboardSource, /HOLD_STILL_CLIPBOARD_RESULT/);

const backgroundSource = fs.readFileSync(
  path.join(root, "src/background.js"),
  "utf8"
);
assert.match(backgroundSource, /reasons: \["BLOBS", "CLIPBOARD"\]/);
assert.match(backgroundSource, /action: "copy"/);
assert.doesNotMatch(backgroundSource, /chrome\.windows\.create/);
assert.match(offscreenSource, /document\.execCommand\("copy"\)/);
assert.match(popupScript, /statusResetTimer = setTimeout/);
assert.match(popupScript, /HOLD_STILL_POPUP_COPY/);
assert.match(popupScript, /navigator\.clipboard\.write/);
assert.ok(
  backgroundSource.indexOf("await copyInPopup(url)") < backgroundSource.indexOf('action: "copy"')
);
assert.ok(
  backgroundSource.indexOf("copyInTab(tabId, url)") < backgroundSource.indexOf('action: "copy"')
);
copyPromise
  .then(() => {
    console.log("Hold Still smoke tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
