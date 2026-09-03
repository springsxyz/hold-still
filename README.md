# Hold Still

Hold Still is a dependency-free Chrome and Edge extension that captures screenshots locally as PNG files.

## Capture modes

- Full page detects either document scrolling or a large app-style scroll panel, stitches its visible tiles, restores the original position, and produces one PNG.
- Current viewport captures exactly what is visible in the active tab.
- Selected area adds a drag-to-select overlay, crops the visible tab to that rectangle, and produces the result. On pages that refuse an overlay it falls back to dragging the selection on the captured image in a separate window.

Choose the output in the popup. Copy is the default:

- Copy tries the extension popup while it is open, then a hidden extension document, then the page itself, without opening an extra window. If Chrome refuses every route the PNG is saved to Downloads instead of being discarded, and the toast says so.
- Download saves screenshots directly in the browser's Downloads directory, named for the page title, the capture mode, and the time.

Hold Still remembers the output choice, including when keyboard shortcuts are used.

## Install locally

1. Open chrome://extensions in Chrome, or edge://extensions in Edge.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this hold-still folder.
5. Pin Hold Still to the browser toolbar.

No package installation or build step is required.

## Use

Open a normal website, click the Hold Still toolbar button, and choose a capture mode.

After updating the local files, click Reload on Hold Still at chrome://extensions or edge://extensions.

Clipboard access is granted when the extension is installed, so switching between Copy and Download never interrupts a capture with a permission prompt.

Default keyboard shortcuts:

- Full page: Alt+Shift+F
- Current viewport: Alt+Shift+V
- Selected area: Alt+Shift+S

Chrome shortcuts can be changed at chrome://extensions/shortcuts.

## Notes

- Browsers block extensions from running any code inside internal pages such as chrome://settings and inside the Chrome Web Store. Hold Still works around this where it can, and no permission lifts the restriction itself.
  - Current viewport works, because it reads pixels from outside the page. The confirmation arrives as a system notification instead of an in-page toast.
  - Selected area works. The drag overlay cannot be drawn on the page, so Hold Still captures the viewport and opens a window where the selection is dragged on the capture instead.
  - Full page cannot work. Stitching means scrolling the document and measuring its height, and there is no way to do that from outside a page the browser has closed to extensions.
- Extremely large pages can exceed Chromium's maximum canvas size. Hold Still shows an error and recommends selected-area captures in that case.
- Animated or lazy-loaded content can change while a full-page capture is scrolling. Fixed and sticky elements are suppressed after the first tile, and the page is restored afterward.

## Development

Run the dependency-free smoke test:

    npm test

On Windows, regenerate the checked-in PNG icons with:

    powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1

Build the Chrome Web Store upload, which packages only the paths the manifest
loads and leaves out tests, scripts and docs:

    npm run package

## Privacy

All image processing happens locally in the browser. Hold Still does not transmit screenshots or browsing data; the PNG only goes to the selected local output.
