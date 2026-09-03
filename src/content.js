(() => {
  if (globalThis.__holdStillContentScriptLoaded) return;
  globalThis.__holdStillContentScriptLoaded = true;

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

  let pageState = null;
  let selectionCleanup = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MESSAGE.ping) {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === MESSAGE.beginSelection) {
      beginSelection();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === MESSAGE.copyImage) {
      copyImageToClipboard(message.url).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({
          ok: false,
          error: error?.message || String(error)
        })
      );
      return true;
    }
    if (message?.type === MESSAGE.prepareFullPage) {
      prepareFullPage().then(sendResponse, (error) => sendResponse(failure(error)));
      return true;
    }
    if (message?.type === MESSAGE.scrollTo) {
      scrollAndSettle(message.x, message.y).then(
        sendResponse,
        (error) => sendResponse(failure(error))
      );
      return true;
    }
    if (message?.type === MESSAGE.hideFixed) {
      hideFixedElements();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === MESSAGE.restorePage) {
      restorePage();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === MESSAGE.toast) {
      showToast(message.message, message.tone);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Answering with an error field keeps the message port open. Letting the
  // promise reject instead drops the port, and the service worker then reports
  // a generic validation failure rather than what actually went wrong.
  function failure(error) {
    return {
      error: error?.message || String(error) || "The page could not be prepared."
    };
  }

  async function copyImageToClipboard(url) {
    if (!url) throw new Error("The screenshot image is missing.");

    const response = await fetch(url);
    if (!response.ok) throw new Error("Chrome could not read the screenshot.");
    const sourceBlob = await response.blob();
    const pngBlob = sourceBlob.type === "image/png"
      ? sourceBlob
      : new Blob([sourceBlob], { type: "image/png" });

    if (
      navigator.clipboard?.write &&
      typeof ClipboardItem === "function"
    ) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": pngBlob })
        ]);
        return;
      } catch {
        // The focused-page copy fallback below works without Async Clipboard.
      }
    }

    await copyBlobWithSelection(pngBlob);
  }

  async function copyBlobWithSelection(blob) {
    const imageUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.alt = "";
    image.draggable = false;
    await loadClipboardImage(image, imageUrl);

    const holder = document.createElement("div");
    holder.contentEditable = "true";
    holder.style.cssText = [
      "position:fixed",
      "left:-100000px",
      "top:0",
      "opacity:0",
      "pointer-events:none"
    ].join(";");
    holder.appendChild(image);
    document.documentElement.appendChild(holder);

    const selection = document.getSelection();
    const range = document.createRange();
    let copied = false;
    try {
      range.selectNode(image);
      selection.removeAllRanges();
      selection.addRange(range);
      copied = document.execCommand("copy");
    } finally {
      selection.removeAllRanges();
      holder.remove();
      URL.revokeObjectURL(imageUrl);
    }

    if (!copied) throw new Error("Chrome could not copy the selected area.");
  }

  function loadClipboardImage(image, url) {
    return new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(
        new Error("Chrome could not prepare the clipboard image.")
      );
      image.src = url;
    });
  }

  async function prepareFullPage() {
    if (pageState) restorePage();
    if (selectionCleanup) selectionCleanup(false);

    const html = document.documentElement;
    const body = document.body;
    const documentScroller = document.scrollingElement || html;
    const scrollTarget = findPrimaryScrollContainer(documentScroller);
    const mode = scrollTarget === documentScroller ? "document" : "element";

    pageState = {
      mode,
      scrollTarget,
      scrollX: mode === "document" ? window.scrollX : scrollTarget.scrollLeft,
      scrollY: mode === "document" ? window.scrollY : scrollTarget.scrollTop,
      documentScrollX: window.scrollX,
      documentScrollY: window.scrollY,
      htmlScrollBehavior: readInlineProperty(html, "scroll-behavior"),
      bodyScrollBehavior: body ? readInlineProperty(body, "scroll-behavior") : null,
      fixedElements: [],
      scrollbarStyle: null,
      targetMarker: mode === "element"
        ? scrollTarget.getAttribute("data-hold-still-scroll-target")
        : null
    };

    html.style.setProperty("scroll-behavior", "auto", "important");
    body?.style.setProperty("scroll-behavior", "auto", "important");

    if (mode === "element") {
      scrollTarget.setAttribute("data-hold-still-scroll-target", "active");
    }

    const scrollbarStyle = document.createElement("style");
    scrollbarStyle.dataset.holdStillInternal = "scrollbars";
    scrollbarStyle.textContent = [
      "html { scrollbar-width: none !important; }",
      "html::-webkit-scrollbar, body::-webkit-scrollbar,",
      "[data-hold-still-scroll-target='active']::-webkit-scrollbar {",
      "  width: 0 !important;",
      "  height: 0 !important;",
      "}",
      "[data-hold-still-scroll-target='active'] {",
      "  scrollbar-width: none !important;",
      "}"
    ].join("\n");
    (document.head || html).appendChild(scrollbarStyle);
    pageState.scrollbarStyle = scrollbarStyle;

    for (const element of document.querySelectorAll("body *")) {
      if (!(element instanceof HTMLElement)) continue;
      const position = getComputedStyle(element).position;
      if (position !== "fixed" && position !== "sticky") continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      pageState.fixedElements.push({
        element,
        visibility: readInlineProperty(element, "visibility")
      });
    }

    await nextPaint();

    const captureRect = getCaptureRect();

    return {
      mode,
      totalWidth: mode === "document"
        ? Math.max(
            documentScroller.scrollWidth,
            html.scrollWidth,
            body?.scrollWidth || 0,
            window.innerWidth
          )
        : scrollTarget.scrollWidth,
      totalHeight: mode === "document"
        ? Math.max(
            documentScroller.scrollHeight,
            html.scrollHeight,
            body?.scrollHeight || 0,
            window.innerHeight
          )
        : scrollTarget.scrollHeight,
      // The tile stride has to match what actually lands in the screenshot. A
      // scroll panel can run past the viewport edge, and striding by its full
      // clientWidth would leave unpainted stripes between tiles.
      viewportWidth: mode === "document"
        ? window.innerWidth
        : captureRect.width,
      viewportHeight: mode === "document"
        ? window.innerHeight
        : captureRect.height,
      windowViewportWidth: window.innerWidth,
      windowViewportHeight: window.innerHeight,
      captureRect
    };
  }

  async function scrollAndSettle(x, y) {
    if (!pageState) throw new Error("The page is not prepared for capture.");

    if (pageState.mode === "document") {
      window.scrollTo(x, y);
    } else {
      pageState.scrollTarget.scrollTo({ left: x, top: y, behavior: "auto" });
    }

    await nextPaint();
    await new Promise((resolve) => setTimeout(resolve, 180));

    return {
      x: pageState.mode === "document"
        ? window.scrollX
        : pageState.scrollTarget.scrollLeft,
      y: pageState.mode === "document"
        ? window.scrollY
        : pageState.scrollTarget.scrollTop,
      captureRect: getCaptureRect()
    };
  }

  function getCaptureRect() {
    if (!pageState || pageState.mode === "document") {
      return {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight
      };
    }

    const target = pageState.scrollTarget;
    const rect = target.getBoundingClientRect();
    const left = clamp(rect.left + target.clientLeft, 0, window.innerWidth);
    const top = clamp(rect.top + target.clientTop, 0, window.innerHeight);

    return {
      left,
      top,
      width: Math.max(1, Math.min(target.clientWidth, window.innerWidth - left)),
      height: Math.max(1, Math.min(target.clientHeight, window.innerHeight - top))
    };
  }

  function findPrimaryScrollContainer(documentScroller) {
    const documentHeight = Math.max(
      documentScroller.scrollHeight,
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    );

    if (documentHeight > window.innerHeight + 8) {
      return documentScroller;
    }

    const viewportArea = window.innerWidth * window.innerHeight;
    let best = null;

    for (const element of document.querySelectorAll("body *")) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.scrollHeight <= element.clientHeight + 80) continue;
      if (element.clientWidth < 120 || element.clientHeight < 120) continue;

      const overflowY = getComputedStyle(element).overflowY;
      if (!["auto", "scroll", "overlay"].includes(overflowY)) continue;

      const rect = element.getBoundingClientRect();
      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
      );
      const visibleArea = visibleWidth * visibleHeight;
      if (visibleArea < viewportArea * 0.2) continue;

      const scrollRatio = element.scrollHeight / element.clientHeight;
      const score = visibleArea * Math.min(scrollRatio, 12);
      if (!best || score > best.score) {
        best = { element, score };
      }
    }

    return best?.element || documentScroller;
  }

  function hideFixedElements() {
    if (!pageState) return;
    for (const { element } of pageState.fixedElements) {
      if (element.isConnected) {
        element.style.setProperty("visibility", "hidden", "important");
      }
    }
  }

  function restorePage() {
    if (!pageState) return;
    const state = pageState;
    pageState = null;

    for (const { element, visibility } of state.fixedElements) {
      if (element.isConnected) {
        restoreInlineProperty(element, "visibility", visibility);
      }
    }

    state.scrollbarStyle?.remove();
    if (state.mode === "element" && state.scrollTarget.isConnected) {
      if (state.targetMarker === null) {
        state.scrollTarget.removeAttribute("data-hold-still-scroll-target");
      } else {
        state.scrollTarget.setAttribute(
          "data-hold-still-scroll-target",
          state.targetMarker
        );
      }
      state.scrollTarget.scrollTo({
        left: state.scrollX,
        top: state.scrollY,
        behavior: "auto"
      });
    }

    restoreInlineProperty(
      document.documentElement,
      "scroll-behavior",
      state.htmlScrollBehavior
    );
    if (document.body && state.bodyScrollBehavior) {
      restoreInlineProperty(
        document.body,
        "scroll-behavior",
        state.bodyScrollBehavior
      );
    }
    window.scrollTo(state.documentScrollX, state.documentScrollY);
  }

  function beginSelection() {
    if (selectionCleanup) selectionCleanup(false);

    const host = document.createElement("div");
    host.style.cssText = [
      "all:initial",
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "pointer-events:auto"
    ].join(";");
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = [
      "* { box-sizing: border-box; }",
      ".surface { position: fixed; inset: 0; cursor: crosshair; user-select: none; }",
      ".shade { position: fixed; background: rgba(2, 6, 23, .58); pointer-events: none; }",
      ".selection { position: fixed; display: none; border: 2px solid #60a5fa; background: rgba(96, 165, 250, .10); box-shadow: 0 0 0 1px rgba(255,255,255,.8); pointer-events: none; }",
      ".size { position: absolute; left: 0; top: -32px; padding: 5px 8px; border-radius: 7px; color: white; background: #0f172a; font: 600 12px/1.2 system-ui, sans-serif; white-space: nowrap; box-shadow: 0 5px 18px rgba(0,0,0,.25); }",
      ".hint { position: fixed; left: 50%; top: 24px; transform: translateX(-50%); padding: 10px 14px; border-radius: 999px; color: #f8fafc; background: #0f172a; font: 600 13px/1.2 system-ui, sans-serif; letter-spacing: .01em; box-shadow: 0 10px 30px rgba(0,0,0,.28); pointer-events: none; }",
      "kbd { margin-left: 7px; padding: 2px 6px; border: 1px solid #64748b; border-radius: 5px; font: inherit; }"
    ].join("\n");

    const surface = document.createElement("div");
    surface.className = "surface";
    const shades = Array.from({ length: 4 }, () => {
      const shade = document.createElement("div");
      shade.className = "shade";
      return shade;
    });
    const selection = document.createElement("div");
    selection.className = "selection";
    const size = document.createElement("div");
    size.className = "size";
    selection.appendChild(size);
    const hint = document.createElement("div");
    hint.className = "hint";
    const escapeKey = document.createElement("kbd");
    escapeKey.textContent = "Esc";
    hint.append("Drag to capture an area ", escapeKey, " to cancel");
    surface.append(...shades, selection, hint);
    shadow.append(style, surface);
    document.documentElement.appendChild(host);
    resetShades(shades);

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let currentRect = null;

    const cleanup = (cancelled = true) => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize, true);
      host.remove();
      selectionCleanup = null;
      if (cancelled) {
        chrome.runtime
          .sendMessage({ type: MESSAGE.selectionCancelled })
          .catch(() => {});
      }
    };

    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup(true);
    };

    const onResize = () => cleanup(true);
    selectionCleanup = cleanup;
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize, true);

    surface.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      surface.setPointerCapture(event.pointerId);
      startX = clamp(event.clientX, 0, window.innerWidth);
      startY = clamp(event.clientY, 0, window.innerHeight);
      dragging = true;
      hint.style.display = "none";
      currentRect = rectFromPoints(startX, startY, startX, startY);
      paintSelection(currentRect, selection, shades, size);
    });

    surface.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      currentRect = rectFromPoints(
        startX,
        startY,
        clamp(event.clientX, 0, window.innerWidth),
        clamp(event.clientY, 0, window.innerHeight)
      );
      paintSelection(currentRect, selection, shades, size);
    });

    surface.addEventListener("pointerup", async (event) => {
      if (!dragging) return;
      dragging = false;
      if (surface.hasPointerCapture(event.pointerId)) {
        surface.releasePointerCapture(event.pointerId);
      }

      if (!currentRect || currentRect.width < 4 || currentRect.height < 4) {
        hint.style.display = "block";
        selection.style.display = "none";
        resetShades(shades);
        return;
      }

      const result = {
        ...currentRect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
      cleanup(false);
      await nextPaint();
      chrome.runtime
        .sendMessage({ type: MESSAGE.areaSelected, selection: result })
        .catch(() => {});
    });
  }

  function paintSelection(rect, selection, shades, size) {
    selection.style.display = "block";
    selection.style.left = rect.left + "px";
    selection.style.top = rect.top + "px";
    selection.style.width = rect.width + "px";
    selection.style.height = rect.height + "px";
    size.textContent = Math.round(rect.width) + " x " + Math.round(rect.height);
    size.style.top = rect.top < 42 ? "8px" : "-32px";

    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    setRect(shades[0], 0, 0, window.innerWidth, rect.top);
    setRect(shades[1], 0, rect.top, rect.left, rect.height);
    setRect(shades[2], right, rect.top, window.innerWidth - right, rect.height);
    setRect(shades[3], 0, bottom, window.innerWidth, window.innerHeight - bottom);
  }

  function resetShades(shades) {
    setRect(shades[0], 0, 0, window.innerWidth, window.innerHeight);
    for (let index = 1; index < shades.length; index += 1) {
      setRect(shades[index], 0, 0, 0, 0);
    }
  }

  function setRect(element, left, top, width, height) {
    element.style.left = left + "px";
    element.style.top = top + "px";
    element.style.width = Math.max(0, width) + "px";
    element.style.height = Math.max(0, height) + "px";
  }

  function rectFromPoints(x1, y1, x2, y2) {
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  function showToast(message, tone = "success") {
    const host = document.createElement("div");
    host.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:20px",
      "bottom:20px",
      "z-index:2147483647",
      "pointer-events:none"
    ].join(";");
    const shadow = host.attachShadow({ mode: "closed" });
    const toast = document.createElement("div");
    const accent = tone === "error" ? "#ef4444" : "#22c55e";
    toast.style.cssText = [
      "max-width:340px",
      "padding:12px 14px",
      "border-radius:10px",
      "color:#f8fafc",
      "background:#0f172a",
      "border-left:4px solid " + accent,
      "box-shadow:0 12px 32px rgba(0,0,0,.3)",
      "opacity:1",
      "transition:opacity .22s ease",
      "font:600 13px/1.45 system-ui,sans-serif"
    ].join(";");
    toast.textContent = message;
    shadow.appendChild(toast);
    document.documentElement.appendChild(host);
    const visibleFor = tone === "error" ? 4800 : 2800;
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => host.remove(), 240);
    }, visibleFor);
  }

  function readInlineProperty(element, property) {
    return {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    };
  }

  function restoreInlineProperty(element, property, saved) {
    if (!saved?.value) {
      element.style.removeProperty(property);
    } else {
      element.style.setProperty(property, saved.value, saved.priority);
    }
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }
})();
