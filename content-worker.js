console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-overlay")) {

    const overlay = document.createElement("div");
    overlay.id = "sidekick-overlay";

    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.right = "0";
    overlay.style.height = "100vh";
    overlay.style.width = "20px";
    overlay.style.zIndex = "999999";
    overlay.style.overflow = "hidden";


    // PANEL
    const panel = document.createElement("div");
    panel.id = "sidekick-panel";

    panel.style.position = "absolute";
    panel.style.top = "0";
    panel.style.right = "0";
    panel.style.height = "100%";
    panel.style.width = "900px";
    panel.style.background = "white";
    panel.style.boxShadow = "-4px 0 10px rgba(0,0,0,0.2)";
    panel.style.transform = "translateX(280px)"; // CLOSED state
    panel.style.transition = "transform 0.3s ease";
    panel.style.border = "none";
    panel.style.padding = "0";


    // TOGGLE (Arrow)
    const toggle = document.createElement("div");
    toggle.id = "sidekick-toggle";

    toggle.style.position = "absolute";
    toggle.style.left = "0";
    toggle.style.top = "50%";
    toggle.style.transform = "translateY(-50%)";
    toggle.style.width = "20px";
    toggle.style.height = "60px";
    toggle.style.background = "black";
    toggle.style.color = "white";
    toggle.style.display = "flex";
    toggle.style.alignItems = "center";
    toggle.style.justifyContent = "center";
    toggle.style.cursor = "pointer";

    toggle.innerHTML = "◀";
    
    let isOpen = false;

    toggle.addEventListener("click", () => {
        isOpen = !isOpen;

        if (isOpen) {
            panel.style.transform = "translateX(0)";
            toggle.innerHTML = "▶";
        } else {
            panel.style.transform = "translateX(280px)";
            toggle.innerHTML = "◀";
        }
    });

    panel.appendChild(toggle);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
}
