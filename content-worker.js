console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-panel")) {
  let lastSelectedText = "";
  let captureArmed = false;
  let captureOverlay = null;
  let captureStyleEl = null;

  // ── Undo/Redo stack ──────────────────────────────────────────────────────────
  // undoStack: items removed by undo (can be re-added by redo)
  let undoStack = [];

  document.addEventListener("selectionchange", () => {
    const text = window.getSelection().toString().trim();
    if (text) lastSelectedText = text;
  });

  // ── PANEL ────────────────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.id = "sidekick-panel";
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0",
    height: "100vh", width: "500px",
    background: "white", color: "#111",
    boxShadow: "-4px 0 10px rgba(0,0,0,0.2)",
    transform: "translateX(500px)",
    transition: "transform 0.3s ease",
    zIndex: "999998"
  });

  // ── ARROW ────────────────────────────────────────────────────────────────────
  const arrow = document.createElement("div");
  arrow.id = "sidekick-arrow";
  Object.assign(arrow.style, {
    position: "fixed", top: "50%", right: "0",
    transform: "translateY(-50%)",
    width: "20px", height: "60px",
    background: "black", color: "white",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", zIndex: "999999"
  });
  arrow.innerHTML = "◀";

  let isOpen = false;

  function openPanel() {
    isOpen = true;
    panel.style.transform = "translateX(0)";
    arrow.style.transition = "right 0.3s ease";
    arrow.style.right = "500px";
    arrow.innerHTML = "▶";
  }
  function closePanel() {
    isOpen = false;
    panel.style.transform = "translateX(500px)";
    arrow.style.right = "0";
    arrow.innerHTML = "◀";
  }
  arrow.addEventListener("click", () => isOpen ? closePanel() : openPanel());

  // ── BUTTON ROW ───────────────────────────────────────────────────────────────
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, { display: "flex", gap: "10px", padding: "20px" });

  const captureBtn = document.createElement("button");
  captureBtn.innerText = "Capture";
  Object.assign(captureBtn.style, {
    padding: "10px 20px", cursor: "pointer", fontSize: "16px", color: "black"
  });

  const clearBtn = document.createElement("button");
  clearBtn.innerText = "Clear All";
  Object.assign(clearBtn.style, {
    padding: "10px 20px", cursor: "pointer", fontSize: "16px",
    color: "white", background: "#c0392b", border: "none", borderRadius: "4px"
  });
  clearBtn.addEventListener("click", () => {
    sessionStorage.removeItem("capturedItems");
    undoStack = [];
    renderCapturedList([]);
  });

  buttonRow.appendChild(captureBtn);
  buttonRow.appendChild(clearBtn);
  panel.appendChild(buttonRow);

  // ── CAPTURED LIST ────────────────────────────────────────────────────────────
  const capturedList = document.createElement("div");
  capturedList.id = "sidekick-captured-list";
  Object.assign(capturedList.style, {
    padding: "0 20px 20px", overflowY: "auto",
    maxHeight: "calc(100vh - 80px)", color: "#111"
  });
  panel.appendChild(capturedList);

  document.body.appendChild(panel);
  document.body.appendChild(arrow);

  // ── CAPTURE BAR ──────────────────────────────────────────────────────────────
  // States: "armed" | "captured" | "undone"
  const captureBar = document.createElement("div");
  captureBar.id = "sidekick-capture-bar";
  Object.assign(captureBar.style, {
    position: "fixed", bottom: "0", left: "0", right: "0",
    height: "56px",
    background: "#1a1a2e",
    color: "white",
    display: "none",          // hidden until capture mode
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 20px",
    zIndex: "9999999",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    boxShadow: "0 -2px 12px rgba(0,0,0,0.3)"
  });
  document.body.appendChild(captureBar);

  function barBtn(label, bg) {
    const b = document.createElement("button");
    b.innerText = label;
    Object.assign(b.style, {
      padding: "6px 14px", cursor: "pointer", fontSize: "13px",
      background: bg || "#333", color: "white",
      border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px",
      marginLeft: "8px"
    });
    return b;
  }

  function showBarArmed() {
    captureBar.style.display = "flex";
    captureBar.innerHTML = "";

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "10px";

    const dot = document.createElement("span");
    dot.textContent = "🎯";

    const msg = document.createElement("span");
    msg.style.color = "#aaa";
    msg.textContent = "Capture mode — click an element or select text";

    left.appendChild(dot);
    left.appendChild(msg);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";

    const kbHint = document.createElement("span");
    kbHint.style.color = "#666";
    kbHint.style.fontSize = "12px";
    kbHint.textContent = "Esc to cancel";

    const cancelBtn = barBtn("✕ Cancel", "#444");
    cancelBtn.addEventListener("click", () => {
      disableCaptureMode();
      hideBar();
    });

    right.appendChild(kbHint);
    right.appendChild(cancelBtn);
    captureBar.appendChild(left);
    captureBar.appendChild(right);
  }

  function showBarCaptured(item) {
    captureBar.style.display = "flex";
    captureBar.innerHTML = "";

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "10px";

    // Modality-aware preview
    const typeTag = document.createElement("span");
    typeTag.style.cssText = `
      background: #2ecc71; color: #000; font-weight: 700;
      font-size: 11px; padding: 2px 7px; border-radius: 3px; text-transform: uppercase;
    `;
    typeTag.textContent = item.type;

    const preview = document.createElement("span");
    preview.style.color = "#ddd";
    preview.style.maxWidth = "400px";
    preview.style.overflow = "hidden";
    preview.style.textOverflow = "ellipsis";
    preview.style.whiteSpace = "nowrap";

    if (item.type === "image") {
      const thumb = document.createElement("img");
      thumb.src = item.content;
      Object.assign(thumb.style, {
        height: "32px", width: "32px", objectFit: "cover",
        borderRadius: "3px", verticalAlign: "middle", marginRight: "6px"
      });
      preview.appendChild(thumb);
      const urlSpan = document.createElement("span");
      urlSpan.textContent = item.content.split("/").pop().slice(0, 40) || item.content.slice(0, 40);
      preview.appendChild(urlSpan);
    } else if (item.type === "video") {
      preview.textContent = "🎬 " + (item.content.split("/").pop().slice(0, 60) || item.content.slice(0, 60));
    } else if (item.type === "iframe") {
      preview.textContent = "🖼 " + item.content.slice(0, 60);
    } else {
      preview.textContent = item.content.slice(0, 80) + (item.content.length > 80 ? "…" : "");
    }

    left.appendChild(typeTag);
    left.appendChild(preview);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";

    const undoBtn = barBtn("↩ Undo", "#555");
    undoBtn.addEventListener("click", () => {
      undoLastCapture();
      showBarUndone();
    });

    const moreBtn = barBtn("＋ Capture More", "#2980b9");
    moreBtn.addEventListener("click", () => {
      showBarArmed();
      enableCaptureMode();
    });

    const doneBtn = barBtn("✓ Done", "#27ae60");
    doneBtn.addEventListener("click", () => hideBar());

    right.appendChild(undoBtn);
    right.appendChild(moreBtn);
    right.appendChild(doneBtn);
    captureBar.appendChild(left);
    captureBar.appendChild(right);
  }

  function showBarUndone() {
    captureBar.style.display = "flex";
    captureBar.innerHTML = "";

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "10px";

    const msg = document.createElement("span");
    msg.style.color = "#e0c97f";
    msg.textContent = "↩ Capture undone";
    left.appendChild(msg);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";

    const redoBtn = barBtn("⟳ Redo", "#8e44ad");
    redoBtn.addEventListener("click", () => {
      const item = redoLastCapture();
      if (item) showBarCaptured(item);
    });

    const captureAgainBtn = barBtn("＋ Capture Again", "#2980b9");
    captureAgainBtn.addEventListener("click", () => {
      showBarArmed();
      enableCaptureMode();
    });

    const cancelBtn = barBtn("✕ Cancel", "#444");
    cancelBtn.addEventListener("click", () => hideBar());

    right.appendChild(redoBtn);
    right.appendChild(captureAgainBtn);
    right.appendChild(cancelBtn);
    captureBar.appendChild(left);
    captureBar.appendChild(right);
  }

  function hideBar() {
    captureBar.style.display = "none";
    captureBar.innerHTML = "";
  }

  // ── CAPTURE MODE ─────────────────────────────────────────────────────────────
  captureBtn.addEventListener("click", () => {
    const selectedText = window.getSelection().toString().trim() || lastSelectedText;
    if (selectedText.length > 0) {
      const item = saveCapturedData({ type: "text", content: selectedText });
      lastSelectedText = "";
      showBarCaptured(item);
      closePanel();
      return;
    }
    closePanel();
    showBarArmed();
    enableCaptureMode();
  });

  function enableCaptureMode() {
    if (captureArmed) return;
    captureArmed = true;
    captureStyleEl = document.createElement("style");
    captureStyleEl.textContent = "* { cursor: crosshair !important; }";
    document.head.appendChild(captureStyleEl);
    captureOverlay = document.createElement("div");
    Object.assign(captureOverlay.style, {
      position: "fixed", top: "0", left: "0",
      width: "100vw", height: "100vh",
      background: "rgba(0,0,0,0.04)",
      pointerEvents: "none", zIndex: "999997"  // below bar
    });
    document.body.appendChild(captureOverlay);
    document.addEventListener("mouseup", onCaptureMouseUp, true);
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("mouseover", onCaptureHover, true);
    document.addEventListener("mousemove", onCaptureHover, true);
    document.addEventListener("keydown", onCaptureKeyDown, true);
  }

  function disableCaptureMode() {
    if (!captureArmed) return;
    captureArmed = false;
    document.body.style.cursor = "";
    if (captureStyleEl) { captureStyleEl.remove(); captureStyleEl = null; }
    if (captureOverlay) { captureOverlay.remove(); captureOverlay = null; }
    document.removeEventListener("mouseup", onCaptureMouseUp, true);
    document.removeEventListener("click", onCaptureClick, true);
    document.removeEventListener("mouseover", onCaptureHover, true);
    document.removeEventListener("mousemove", onCaptureHover, true);
    document.removeEventListener("keydown", onCaptureKeyDown, true);
  }

  function onCaptureKeyDown(e) {
    if (e.key === "Escape") {
      disableCaptureMode();
      hideBar();
    }
  }

  function isSelectionInsidePanel() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!(el && panel.contains(el));
  }

  function onCaptureMouseUp() {
    if (!captureArmed) return;
    const selectedText = window.getSelection().toString().trim() || lastSelectedText;
    if (selectedText.length > 0 && !isSelectionInsidePanel()) {
      const item = saveCapturedData({ type: "text", content: selectedText });
      lastSelectedText = "";
      disableCaptureMode();
      showBarCaptured(item);
    }
  }

  function onCaptureClick(e) {
    if (!captureArmed) return;
    // Allow clicks inside the capture bar itself
    if (captureBar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (panel.contains(e.target) || arrow.contains(e.target)) return;

    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    let element = e.target;
    for (const node of path) {
      if (node.tagName === "VIDEO" || node.tagName === "IMG" || node.tagName === "IFRAME") {
        element = node; break;
      }
    }
    if (element && element.closest) {
      const video = element.closest("video");
      const img = element.closest("img");
      if (video) element = video;
      else if (img) element = img;
    }
    if (element && (element.tagName === "IMG" || element.tagName === "VIDEO" || element.tagName === "IFRAME")) {
      const item = handleCapturedElement(element);
      disableCaptureMode();
      if (item) showBarCaptured(item);
    }
  }

  function onCaptureHover(e) {
    if (!captureArmed) return;
    if (e.target && e.target.tagName === "VIDEO") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function handleCapturedElement(element) {
    if (!element) return null;
    if (element.tagName === "IMG")
      return saveCapturedData({ type: "image", content: element.src });
    if (element.tagName === "VIDEO")
      return saveCapturedData({ type: "video", content: element.currentSrc });
    if (element.tagName === "IFRAME")
      return saveCapturedData({ type: "iframe", content: element.src });
    const selectedText = window.getSelection().toString().trim() || lastSelectedText;
    if (selectedText.length > 0) {
      lastSelectedText = "";
      return saveCapturedData({ type: "text", content: selectedText });
    }
    return null;
  }

  // ── STORAGE + UNDO/REDO ──────────────────────────────────────────────────────
  function saveCapturedData(data) {
    const enriched = { ...data, sourceUrl: location.href, capturedAt: new Date().toISOString() };
    const stored = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
    stored.push(enriched);
    sessionStorage.setItem("capturedItems", JSON.stringify(stored));
    undoStack = []; // new capture clears redo stack
    renderCapturedList(stored);
    return enriched;
  }

  function undoLastCapture() {
    const stored = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
    if (!stored.length) return;
    const removed = stored.pop();
    undoStack.push(removed);
    sessionStorage.setItem("capturedItems", JSON.stringify(stored));
    renderCapturedList(stored);
  }

  function redoLastCapture() {
    if (!undoStack.length) return null;
    const item = undoStack.pop();
    const stored = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
    stored.push(item);
    sessionStorage.setItem("capturedItems", JSON.stringify(stored));
    renderCapturedList(stored);
    return item;
  }

  // ── RENDER LIST ──────────────────────────────────────────────────────────────
  function renderCapturedList(items) {
    capturedList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.innerText = "No captures yet.";
      empty.style.color = "#885151";
      capturedList.appendChild(empty);
      return;
    }
    for (const item of items.slice().reverse()) {
      const row = document.createElement("div");
      row.style.cssText = "border-bottom: 1px solid #eee; padding: 10px 0;";

      const title = document.createElement("div");
      title.innerText = item.type.toUpperCase();
      title.style.cssText = "font-weight: 600; margin-bottom: 6px;";

      const content = document.createElement("div");
      content.style.cssText = "margin-bottom: 6px; color: #111;";

      if (item.type === "image") {
        const img = document.createElement("img");
        img.src = item.content;
        img.style.cssText = "max-width: 100%; max-height: 150px; display: block;";
        content.appendChild(img);
      } else {
        const text = document.createElement("div");
        text.innerText = item.content || "";
        text.style.cssText = "word-break: break-word; font-size: 12px; color: #111;";
        content.appendChild(text);
      }

      const source = document.createElement("div");
      source.style.cssText = "font-size: 11px; color: #555; word-break: break-word;";
      const sourceLabel = document.createElement("span");
      sourceLabel.innerText = "Source: ";
      const sourceLink = document.createElement("a");
      sourceLink.href = item.sourceUrl;
      sourceLink.innerText = item.sourceUrl;
      sourceLink.target = "_blank";
      sourceLink.rel = "noopener noreferrer";
      sourceLink.style.cssText = "color: #1a0dab; text-decoration: underline;";
      source.appendChild(sourceLabel);
      source.appendChild(sourceLink);

      row.appendChild(title);
      row.appendChild(content);
      row.appendChild(source);
      capturedList.appendChild(row);
    }
  }

  const initialItems = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
  renderCapturedList(initialItems);
}