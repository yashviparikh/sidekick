console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-panel")) {
  let lastSelectedText = "";
  let captureArmed = false;
  let captureOverlay = null;
  let captureStyleEl = null;

  document.addEventListener("selectionchange", () => {
    const text = window.getSelection().toString().trim();
    if (text) {
      lastSelectedText = text;
    }
  });

    // PANEL
    const panel = document.createElement("div");
    panel.id = "sidekick-panel";

    panel.style.position = "fixed";
    panel.style.top = "0";
    panel.style.right = "0";
    panel.style.height = "100vh";
    panel.style.width = "500px";
    panel.style.background = "white";
    panel.style.boxShadow = "-4px 0 10px rgba(0,0,0,0.2)";
    panel.style.transform = "translateX(500px)"; // fully hidden
    panel.style.transition = "transform 0.3s ease";
    panel.style.zIndex = "999998";

    // ARROW
    const arrow = document.createElement("div");
    arrow.id = "sidekick-arrow";

    arrow.style.position = "fixed";
    arrow.style.top = "50%";
    arrow.style.right = "0";
    arrow.style.transform = "translateY(-50%)";
    arrow.style.width = "20px";
    arrow.style.height = "60px";
    arrow.style.background = "black";
    arrow.style.color = "white";
    arrow.style.display = "flex";
    arrow.style.alignItems = "center";
    arrow.style.justifyContent = "center";
    arrow.style.cursor = "pointer";
    arrow.style.zIndex = "999999";

    arrow.innerHTML = "◀";

    let isOpen = false;

    arrow.addEventListener("click", () => {
    isOpen = !isOpen;

    if (isOpen) {
        panel.style.transform = "translateX(0)";
        arrow.style.transition = "right 0.3s ease";
        arrow.style.right = "500px";
        arrow.innerHTML = "▶";
    } else {
        panel.style.transform = "translateX(500px)";
        arrow.style.right = "0";
        arrow.innerHTML = "◀";
    }
});
    // CAPTURE BUTTON
	const captureBtn = document.createElement("button");
captureBtn.innerText = "Capture";
captureBtn.style.margin = "20px";
captureBtn.style.padding = "10px 20px";
captureBtn.style.cursor = "pointer";
captureBtn.style.fontSize = "16px";
captureBtn.style.color = "black";

captureBtn.addEventListener("click", () => {
  const selectedText = window.getSelection().toString().trim() || lastSelectedText;
  if (selectedText.length > 0) {
    saveCapturedData({
      type: "text",
      content: selectedText
    });
    lastSelectedText = "";
    return;
  }
  enableCaptureMode();
});

	panel.appendChild(captureBtn);

  // CAPTURED LIST
  const capturedList = document.createElement("div");
  capturedList.id = "sidekick-captured-list";
  capturedList.style.padding = "0 20px 20px";
  capturedList.style.overflowY = "auto";
  capturedList.style.maxHeight = "calc(100vh - 80px)";
  panel.appendChild(capturedList);

    document.body.appendChild(panel);
    document.body.appendChild(arrow);

function enableCaptureMode() {
  if (captureArmed) return;
  captureArmed = true;
  document.body.style.cursor = "crosshair";
  captureStyleEl = document.createElement("style");
  captureStyleEl.id = "sidekick-capture-style";
  captureStyleEl.textContent = "* { cursor: crosshair !important; }";
  document.head.appendChild(captureStyleEl);
  captureOverlay = document.createElement("div");
  captureOverlay.id = "capture-overlay";
  Object.assign(captureOverlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    background: "rgba(0,0,0,0.05)", // light tint indicator
    pointerEvents: "none",
    zIndex: "999999"
  });
  document.body.appendChild(captureOverlay);
  document.addEventListener("mouseup", onCaptureMouseUp, true);
  document.addEventListener("click", onCaptureClick, true);
  document.addEventListener("mouseover", onCaptureHover, true);
  document.addEventListener("mousemove", onCaptureHover, true);
}

function disableCaptureMode() {
  if (!captureArmed) return;
  captureArmed = false;
  document.body.style.cursor = "";
  if (captureStyleEl) {
    captureStyleEl.remove();
    captureStyleEl = null;
  }
  if (captureOverlay) {
    captureOverlay.remove();
    captureOverlay = null;
  }
  document.removeEventListener("mouseup", onCaptureMouseUp, true);
  document.removeEventListener("click", onCaptureClick, true);
  document.removeEventListener("mouseover", onCaptureHover, true);
  document.removeEventListener("mousemove", onCaptureHover, true);
}

function isSelectionInsidePanel() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!(element && panel.contains(element));
}

function onCaptureMouseUp() {
  if (!captureArmed) return;
  const selectedText = window.getSelection().toString().trim() || lastSelectedText;
  if (selectedText.length > 0 && !isSelectionInsidePanel()) {
    saveCapturedData({
      type: "text",
      content: selectedText
    });
    lastSelectedText = "";
    disableCaptureMode();
  }
}

function onCaptureClick(e) {
  if (!captureArmed) return;
  e.preventDefault();
  e.stopPropagation();
  if (panel.contains(e.target) || arrow.contains(e.target)) return;
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  let element = e.target;
  for (const node of path) {
    if (node && node.tagName === "VIDEO") {
      element = node;
      break;
    }
    if (node && node.tagName === "IMG") {
      element = node;
      break;
    }
    if (node && node.tagName === "IFRAME") {
      element = node;
      break;
    }
  }
  if (element && element.closest) {
    const video = element.closest("video");
    const img = element.closest("img");
    if (video) element = video;
    else if (img) element = img;
  }
  if (element && (element.tagName === "IMG" || element.tagName === "VIDEO" || element.tagName === "IFRAME")) {
    handleCapturedElement(element);
    disableCaptureMode();
  }
}

function onCaptureHover(e) {
  if (!captureArmed) return;
  const element = e.target;
  if (element && element.tagName === "VIDEO") {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

	function handleCapturedElement(element) {
	  if (!element) return;

  // 1️⃣ If image
  if (element.tagName === "IMG") {
    console.log("Captured image:", element.src);
    saveCapturedData({
      type: "image",
      content: element.src
    });
    return;
  }

	  // 2️⃣ If video
	  if (element.tagName === "VIDEO") {
	    console.log("Captured video:", element.currentSrc);
	    saveCapturedData({
	      type: "video",
	      content: element.currentSrc
	    });
	    return;
	  }

  // 2b️⃣ If iframe (e.g., video embeds)
  if (element.tagName === "IFRAME") {
    console.log("Captured iframe:", element.src);
    saveCapturedData({
      type: "iframe",
      content: element.src
    });
    return;
  }

  // 3️⃣ If text selected
  const selectedText = window.getSelection().toString().trim() || lastSelectedText;
  if (selectedText.length > 0) {
    console.log("Captured text:", selectedText);
    saveCapturedData({
      type: "text",
      content: selectedText
    });
    lastSelectedText = "";
    return;
  }

  console.log("Nothing capturable detected.");
}

	function saveCapturedData(data) {
	  const enriched = {
	    ...data,
	    sourceUrl: location.href,
	    capturedAt: new Date().toISOString()
	  };
	  let stored = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
	  stored.push(enriched);
	  sessionStorage.setItem("capturedItems", JSON.stringify(stored));
	  renderCapturedList(stored);
	  console.log("Saved:", enriched);
	}

  function renderCapturedList(items) {
    capturedList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.innerText = "No captures yet.";
      empty.style.color = "#666";
      capturedList.appendChild(empty);
      return;
    }
    for (const item of items.slice().reverse()) {
      const row = document.createElement("div");
      row.style.borderBottom = "1px solid #eee";
      row.style.padding = "10px 0";

      const title = document.createElement("div");
      title.innerText = item.type.toUpperCase();
      title.style.fontWeight = "600";
      title.style.marginBottom = "6px";

      const content = document.createElement("div");
      content.style.marginBottom = "6px";
      if (item.type === "image") {
        const img = document.createElement("img");
        img.src = item.content;
        img.style.maxWidth = "100%";
        img.style.maxHeight = "150px";
        img.style.display = "block";
        content.appendChild(img);
      } else {
        const text = document.createElement("div");
        text.innerText = item.content || "";
        text.style.wordBreak = "break-word";
        text.style.fontSize = "12px";
        content.appendChild(text);
      }

      const source = document.createElement("div");
      source.innerText = `Source: ${item.sourceUrl}`;
      source.style.fontSize = "11px";
      source.style.color = "#ff7c7c";
      source.style.wordBreak = "break-word";

      row.appendChild(title);
      row.appendChild(content);
      row.appendChild(source);
      capturedList.appendChild(row);
    }
  }

  const initialItems = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
  renderCapturedList(initialItems);

}
