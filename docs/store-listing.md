# Chrome Web Store submission notes

Reference for filling in the developer dashboard. Nothing here ships in the
package; `npm run package` includes only `manifest.json`, `icons/`, `offscreen/`,
`popup/` and `src/`.

## Single purpose

Capture a screenshot of the current tab, as the full page, the visible viewport,
or a selected area, and save it as a PNG file or place it on the clipboard.

## Permission justifications

- **activeTab** — Reads pixels from the tab the user explicitly acts on, via
  `chrome.tabs.captureVisibleTab`. Granted only by the toolbar button or a
  keyboard shortcut, which is why no host permissions are requested.
- **scripting** — Injects `src/content.js` into the acted-on tab to measure page
  dimensions, drive scrolling for full-page stitching, and draw the drag-to-select
  overlay. Injected on demand, never declared as a persistent content script.
- **downloads** — Writes the finished PNG to the browser's Downloads directory.
  Used only for the file the user just captured.
- **offscreen** — Stitches tiles and crops selections on a canvas, which a
  service worker cannot do. Also holds the clipboard fallback path.
- **storage** — Remembers one value, the Download-or-Copy output preference, in
  `chrome.storage.local`. Nothing else is stored.
- **clipboardWrite** — Places the captured PNG on the clipboard. Copy is the
  default output, so this is granted at install rather than requested at
  runtime. As an optional permission it would silently downgrade the default on
  a fresh profile, because nothing can prompt for it during a keyboard-shortcut
  capture. This permission does carry an install warning, "Modify data you copy
  and paste", which is the price of a working Copy default.

## Category

Tools.

## Short description

Reuse the manifest description, which fits the 132-character limit at 74:

> Capture a full webpage, the current viewport, or a selected area as a PNG.

## Detailed description

> Hold Still takes a clean PNG of any web page — the whole scrollable page, just
> what is on screen, or an area you drag — and puts it straight on your clipboard.
>
> **Three ways to capture**
> - Full page: scrolls the page, captures each screen, and stitches them into one
>   tall image. Works on ordinary pages and on app-style panels that scroll inside
>   the layout.
> - Current viewport: exactly what is visible, nothing more.
> - Selected area: drag a box over anything on the page.
>
> **Copy or save**
> Captures go to your clipboard by default, ready to paste into a document, an
> issue, or a chat. Switch to Download and they land in your downloads folder
> instead, named for the page, the capture mode, and the time. Hold Still
> remembers which you picked, including when you use a keyboard shortcut.
>
> **Keyboard shortcuts**
> Alt+Shift+F for the full page, Alt+Shift+V for the viewport, Alt+Shift+S to
> select an area. Rebind them at chrome://extensions/shortcuts.
>
> **Everything stays local**
> Hold Still has no servers, no accounts, and no analytics, and it makes no
> network requests. Screenshots are produced in your browser and go only where
> you send them. It reads a page only when you ask it to capture that page.
>
> **About the permission notice**
> "Modify data you copy and paste" is Chrome's wording for clipboard write
> access. Hold Still uses it to place your screenshot on the clipboard. It never
> reads your clipboard.

## Screenshots

The store needs at least one, at 1280x800 or 640x400. `scripts/store-screenshot.html`
composes one from the real popup, loaded in an iframe rather than mocked up, so it
cannot drift from the shipped UI.

    npm run preview

Open <http://localhost:5177/scripts/store-screenshot.html>, then capture at exactly
1280x800: DevTools, Ctrl+Shift+M for the device toolbar, set 1280x800, and use
"Capture screenshot" from the toolbar's overflow menu.

## Privacy policy

The dashboard asks for a URL, so this needs hosting somewhere public — a GitHub
Pages page or a gist is enough. Draft:

> **Hold Still privacy policy**
>
> Hold Still does not collect, store, transmit, or sell any user data.
>
> The extension runs entirely in your browser. It has no backend, no accounts,
> and no analytics, and it makes no network requests of any kind.
>
> What it touches, and why:
>
> - **Page content.** When you start a capture, Hold Still reads the visible
>   pixels of the tab you are on in order to produce the screenshot. The image is
>   created in your browser and is never uploaded.
> - **Downloads.** If you choose Download, the PNG is written to your browser's
>   download location.
> - **Clipboard.** If you choose Copy, the PNG is placed on your clipboard. Hold
>   Still never reads your clipboard.
> - **Local settings.** One preference, Copy or Download, is stored with
>   chrome.storage.local on your own machine.
>
> No data leaves your device.
>
> Contact: <your address> — Last updated: <date>

## Data disclosure

Declare no collection in every category. Screenshots are produced and consumed
locally; the extension makes no network requests, has no analytics, no remote
code, and no external endpoints. A privacy policy URL is still required by the
dashboard even when nothing is collected.

## Pre-submission manual checks

Load unpacked, then confirm on a normal website. A fresh profile defaults to
Copy, so start there.

1. Viewport capture. Paste the result.
2. Full-page capture on a long article. Paste the result, then confirm the page
   scrolled back to where it started and sticky headers are not repeated.
3. **Repeat 2 with the popup closed, using Alt+Shift+F.** This is the path that
   depends on the offscreen clipboard fallback, and it is the first thing many
   new users will hit. If the clipboard is refused the toast says the screenshot
   was saved to Downloads instead, which is the intended downgrade rather than a
   failure — but confirm which behaviour you are shipping.
4. Selected area capture. Paste the result, then repeat and press Esc mid-drag
   to confirm the overlay clears.
5. Full-page capture inside an app-style scroll panel (a chat or dashboard pane)
   rather than a document-scrolling page.
6. Switch output to Download and repeat 1, 2 and 4. Files land directly in the
   downloads directory, named for the page title, mode and timestamp.
7. Reopen the popup and confirm the output choice survived.
8. Start a selection, then navigate the tab instead of dragging. The next
   capture on that tab must work rather than reporting a capture in progress.
9. Try a capture on `chrome://extensions` and confirm the error explains that
   browser pages block extensions.
