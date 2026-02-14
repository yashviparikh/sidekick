console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-panel")) {

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
  enableCaptureMode();
  
});

panel.appendChild(captureBtn);

    document.body.appendChild(panel);
    document.body.appendChild(arrow);

function enableCaptureMode() {
  const overlay = document.createElement("div");
  overlay.id = "capture-overlay";

  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    background: "rgba(0,0,0,0.05)", // very light tint so user knows it's active
    cursor: "crosshair",
    zIndex: "999999"
  });

  document.body.appendChild(overlay);

 overlay.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  // Temporarily disable overlay so we can detect element underneath
  overlay.style.pointerEvents = "none";

  const element = document.elementFromPoint(e.clientX, e.clientY);

  // Restore pointer events (optional, since we remove it)
  overlay.style.pointerEvents = "auto";

  overlay.remove();

  handleCapturedElement(element);
});

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

  // 3️⃣ If text selected
  const selectedText = window.getSelection().toString().trim();
  if (selectedText.length > 0) {
    console.log("Captured text:", selectedText);
    saveCapturedData({
      type: "text",
      content: selectedText
    });
    return;
  }

  console.log("Nothing capturable detected.");
}

function saveCapturedData(data) {
  let stored = JSON.parse(sessionStorage.getItem("capturedItems") || "[]");
  stored.push(data);
  sessionStorage.setItem("capturedItems", JSON.stringify(stored));

  console.log("Saved:", data);
}

}
