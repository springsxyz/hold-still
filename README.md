# Hold Still

Hold Still is a dependency-free Chrome and Edge extension that captures screenshots locally as PNG files.

## Capture modes

- Full page detects either document scrolling or a large app-style scroll panel, stitches its visible tiles, restores the original position, and produces one PNG.
- Current viewport captures exactly what is visible in the active tab.
- Selected area adds a drag-to-select overlay, crops the visible tab to that rectangle, and produces the result.

Choose the output in the popup:

- Download saves screenshots in a Hold Still folder inside the browser's Downloads directory.
- Copy writes from the focused extension popup when available and uses a hidden extension document as fallback, without opening an extra window.

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

The first time Copy is selected, Chrome asks for optional clipboard-write access. Download does not require clipboard access.

Default keyboard shortcuts:

- Full page: Alt+Shift+F
- Current viewport: Alt+Shift+V
- Selected area: Alt+Shift+S

Chrome shortcuts can be changed at chrome://extensions/shortcuts.

## Notes

- Browsers block extensions on internal pages such as chrome://settings and on the Chrome Web Store.
- Extremely large pages can exceed Chromium's maximum canvas size. Hold Still shows an error and recommends selected-area captures in that case.
- Animated or lazy-loaded content can change while a full-page capture is scrolling. Fixed and sticky elements are suppressed after the first tile, and the page is restored afterward.

## Development

Run the dependency-free smoke test:

    npm test

On Windows, regenerate the checked-in PNG icons with:

    powershell -ExecutionPolicy Bypass -File scripts/generate-icons.ps1

## Privacy

All image processing happens locally in the browser. Hold Still does not transmit screenshots or browsing data; the PNG only goes to the selected local output.
