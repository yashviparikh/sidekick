if (!document.getElementById("sidekick-panel")) {

  let sidekickActive = true;

  function teardownSidekick() {
    if (!sidekickActive) return;
    sidekickActive = false;
    disableCaptureMode();
    hideBar();
    panel.remove();
    arrow.remove();
    captureBar.remove();
    styleEl.remove();
  }

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.type === "SIDEKICK_DISABLE") teardownSidekick();
    });
  }


  const STORAGE_KEY = "sidekick_data";
  let _cache = null;
  let _contextAlive = true;
  let noteSearchQuery = "";
  let notebookSearchQuery = "";

  function contextOk() {
    if (!_contextAlive) return false;
    try {
      void chrome.runtime.id;
      return true;
    } catch (_) {
      _contextAlive = false;
      console.warn("[Sidekick] Extension context invalidated — storage sync disabled until page reload.");
      return false;
    }
  }

  function getData() {
    return _cache;
  }

  function setData(d) {
    _cache = d;
    if (!contextOk()) return;
    chrome.storage.local.set({ [STORAGE_KEY]: d }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Sidekick] storage write failed:", chrome.runtime.lastError);
      }
    });
  }

  function initData() {
    const nb = { id: uid(), name: "My First Notebook", createdAt: now(), labels: [] };
    return { notebooks: [nb], capturedItems: [], activeNotebookId: nb.id, recycleBin: [] };
  }

  if (contextOk()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      const incoming = changes[STORAGE_KEY].newValue;
      if (!incoming) return;
      if (JSON.stringify(incoming) !== JSON.stringify(_cache)) {
        _cache = incoming;
        renderView(currentView);
      }
    });
  }

  function boot(storedData) {
    if (storedData) {
      _cache = storedData;
    } else {
      _cache = initData();
      if (contextOk()) {
        chrome.storage.local.set({ [STORAGE_KEY]: _cache }, () => {
          if (chrome.runtime.lastError) console.warn("[Sidekick] boot write failed:", chrome.runtime.lastError);
        });
      }
    }
    purgeBin();
    finishBoot();
  }

  if (contextOk()) {
    chrome.storage.local.get(STORAGE_KEY, result => {
      boot(result[STORAGE_KEY] || null);
    });
  } else {
    boot(null);
  }

  function uid() { return "id_" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function now() { return new Date().toISOString(); }
  function clearSelection() {
    try { window.getSelection().removeAllRanges(); } catch (_) {}
  }

  function purgeBin() {
    const d = getData();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    d.recycleBin = (d.recycleBin || []).filter(e => new Date(e.deletedAt).getTime() > cutoff);
    setData(d);
  }

  let undoStack = [];
  let lastSelectedText = "";
  let captureArmed = false;
  let captureOverlay = null;
  let captureStyleEl = null;
  let currentView = "main";
  let panelW = 480;
  let captureBarMode = "hidden"; // "hidden" | "armed" | "captured" | "undone"

  document.addEventListener("selectionchange", () => {
    if (!sidekickActive) return;
    const t = window.getSelection().toString().trim();
    if (t) lastSelectedText = t;
  });

  // ── PALETTE ──────────────────────────────────────────────────────────────
  // olive:      #2f8fcf  (dark)   #1f6fac  (darker)   #164971  (arrow)
  // butter:     #eaf6fd  (bg wash)  #d7edfb  (hover)
  // white:      #ffffff  (cards/inputs)
  // sky blue:   #cfeeff  (active/highlight)  #eaf6fd  (header/pinned tint)  #7ec4ea  (accent border)
  // text dark:  #1e293b
  // border:     #bfe0fa  (normal)  #5b7a90  (hover)
  // ─────────────────────────────────────────────────────────────────────────

  const styleEl = document.createElement("style");
  styleEl.id = "sidekick-styles";
  styleEl.textContent = `
    #sidekick-panel, #sidekick-panel * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; margin: 0; }
    #sidekick-panel, #sidekick-panel *,
    #sidekick-arrow,
    #sidekick-capture-bar, #sidekick-capture-bar *,
    .sk-label-popover, .sk-label-popover *,
    .sk-dropdown, .sk-dropdown * {
      user-select: none; -webkit-user-select: none; -moz-user-select: none;
    }
    #sidekick-panel input, #sidekick-panel textarea,
    .sk-label-popover input, .sk-label-popover textarea {
      user-select: text; -webkit-user-select: text; -moz-user-select: text;
    }
    .sk-label-popover, .sk-label-popover *,
    .sk-dropdown, .sk-dropdown * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; margin: 0; }
    #sidekick-panel { scrollbar-width: thin; scrollbar-color: #7ec4ea transparent; }
    #sidekick-body::-webkit-scrollbar { width: 6px; }
    #sidekick-body::-webkit-scrollbar-track { background: transparent; }
    #sidekick-body::-webkit-scrollbar-thumb { background: #7ec4ea; border-radius: 3px; }

    .sk-btn { padding: 6px 13px; cursor: pointer; font-size: 13px; border-radius: 6px; border: 1px solid #bfe0fa; background: #eaf6fd; color: #1e293b; transition: all 0.12s; white-space: nowrap; line-height: 1.4; }
    .sk-btn:hover { background: #d7edfb; border-color: #5b7a90; }
    .sk-btn.primary { background: #2f8fcf; color: #ffffff; border-color: #2f8fcf; }
    .sk-btn.primary:hover { background: #1f6fac; border-color: #1f6fac; }
    .sk-btn.danger { color: #8b2e2e; border-color: #d4a5a5; background: #fdf6f6; }
    .sk-btn.danger:hover { background: #f9eded; }

    .sk-icon-btn { width: 28px; height: 28px; border-radius: 6px; border: none; background: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; color: #1e293b; transition: background 0.12s; flex-shrink: 0; padding: 0; }
    .sk-icon-btn:hover { background: #d7edfb; }

    .sk-note-card { border: 1px solid #bfe0fa; border-radius: 8px; padding: 10px 12px 10px 32px; margin-bottom: 12px; background: #ffffff; position: relative; transition: border-color 0.12s, background 0.12s; }
    .sk-note-card:hover { border-color: #5b7a90; }
    .sk-note-card:hover .sk-note-del { opacity: 1; }
    .sk-note-card:hover .sk-note-menu-btn { opacity: 1; }
    .sk-note-card.pinned { border-color: #7ec4ea; background: #eaf6fd; }
    .sk-note-card.sk-dragging { opacity: 0.6; box-shadow: 0 6px 18px rgba(30,41,59,0.2); border-color: #2f8fcf; z-index: 5; }

    .sk-drag-handle { position: absolute; left: 4px; top: 50%; transform: translateY(-50%); width: 22px; height: 30px; display: flex; align-items: center; justify-content: center; color: #9fb8ca; cursor: grab; touch-action: none; }
    .sk-drag-handle:hover { color: #2f8fcf; }
    .sk-drag-handle:active { cursor: grabbing; }
    .sk-drag-handle.disabled { opacity: 0.3; cursor: default; pointer-events: none; }
    .sk-note-del { position: absolute; top: 7px; right: 7px; opacity: 0; transition: opacity 0.12s; width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; cursor: pointer; font-size: 12px; color: #5b7a90; display: inline-flex; align-items: center; justify-content: center; }
    .sk-note-del:hover { background: #f4dada; color: #8b2e2e; }

    .sk-note-menu-wrap { position: absolute; top: 7px; right: 33px; }
    .sk-note-menu-btn { opacity: 0; transition: opacity 0.12s; width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; cursor: pointer; font-size: 15px; line-height: 1; color: #5b7a90; display: inline-flex; align-items: center; justify-content: center; }
    .sk-note-menu-btn:hover { background: #d7edfb; color: #1e293b; }
    .sk-note-menu-btn.open { opacity: 1; background: #d7edfb; color: #1e293b; }

    .sk-pin-badge { display: inline-flex; align-items: center; margin-right: 2px; color: #2f8fcf; }
    .sk-pin-badge svg { width: 13px; height: 13px; display: block; }

    .sk-read-more { font-size: 12px; color: #2f8fcf; cursor: pointer; font-weight: 600; margin-top: 4px; display: inline-block; }
    .sk-read-more:hover { text-decoration: underline; }
    .sk-highlight { background: #a8d8f5; color: #1e293b; border-radius: 2px; padding: 0 1px; font-weight: 700; }

    .sk-nb-card { border: 1px solid #bfe0fa; border-radius: 8px; padding: 11px 13px; margin-bottom: 12px; background: #ffffff; cursor: pointer; transition: border-color 0.12s, box-shadow 0.12s; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .sk-nb-card:hover { border-color: #7ec4ea; box-shadow: 0 0 0 3px rgba(126,196,234,0.35); }
    .sk-nb-card.active { border-color: #2f8fcf; background: #cfeeff; }

    .sk-tag { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
    .sk-tag.text  { background: #dceefc; color: #0c4a6e; }
    .sk-tag.image { background: #cfe8fb; color: #0a4a75; }
    .sk-tag.video { background: #b3daf7; color: #08395c; }
    .sk-tag.iframe{ background: #eaf6fd; color: #14587d; }

    .sk-input { border: 1px solid #bfe0fa; border-radius: 6px; padding: 6px 10px; font-size: 13px; width: 100%; outline: none; background: #ffffff; color: #1e293b; }
    .sk-input:focus { border-color: #2f8fcf; box-shadow: 0 0 0 2px rgba(126,196,234,0.4); }

    .sk-section-lbl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; color: #5b7a90; margin-bottom: 8px; display: block; }
    .sk-empty { color: #5b7a90; font-size: 13px; text-align: center; padding: 40px 16px; line-height: 1.6; }

    .sk-bin-card { border: 1px solid #bfe0fa; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; background: #eaf6fd; }
    .sk-bin-meta { font-size: 11px; color: #5b7a90; margin-top: 3px; }

    .sk-dropdown { position: absolute; top: calc(100% + 4px); right: 0; background: #ffffff; border: 1px solid #bfe0fa; border-radius: 8px; box-shadow: 0 4px 16px rgba(46,46,31,0.12); z-index: 10000; min-width: 150px; overflow: hidden; }
    .sk-dd-item { padding: 9px 14px; cursor: pointer; font-size: 13px; color: #1e293b; display: flex; align-items: center; gap: 8px; }
    .sk-dd-item:hover { background: #d7edfb; }
    .sk-dd-item.disabled { color: #9fb8ca; cursor: default; }
    .sk-dd-item.disabled:hover { background: transparent; }

    .sk-resize-h { position: absolute; left: 0; top: 0; width: 5px; height: 100%; cursor: ew-resize; z-index: 10; background: transparent; }
    .sk-resize-h:hover, .sk-resize-h.dragging { background: rgba(90,97,50,0.3); }
    .sk-resize-v { position: absolute; left: 0; bottom: 0; width: 100%; height: 5px; cursor: ns-resize; z-index: 10; background: transparent; }
    .sk-resize-v:hover, .sk-resize-v.dragging { background: rgba(90,97,50,0.3); }

    .sk-header { padding: 13px 14px 10px; border-bottom: 1px solid #bfe0fa; background: #eaf6fd; flex-shrink: 0; }
    .sk-header-row { display: flex; align-items: center; gap: 6px; margin-bottom: 9px; }
    .sk-action-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

    .sk-nb-name { font-size: 15px; font-weight: 700; color: #1e293b; flex: 1; min-width: 0; cursor: pointer; padding: 3px 5px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sk-nb-name:hover { background: #d7edfb; }
    .sk-view-title { font-size: 15px; font-weight: 700; color: #1e293b; flex: 1; }

    .sk-sync-dot { width: 6px; height: 6px; border-radius: 50%; background: #2f8fcf; display: inline-block; margin-left: 4px; opacity: 0; transition: opacity 0.3s; }
    .sk-sync-dot.active { opacity: 1; }

    .sk-label-chip { display:inline-block; font-size:10px; font-weight:600; padding:1px 6px; border-radius:8px; background:#dceefc; color:#0c4a6e; margin-right:4px; margin-top:3px; border:1px solid #9fd0f3; }
    .sk-label-popover { position: fixed; z-index: 1000000; background: #ffffff; border: 1px solid #bfe0fa; border-radius: 8px; box-shadow: 0 4px 16px rgba(46,46,31,0.18); padding: 12px; width: 230px; }
    .sk-label-popover .sk-input { margin-top: 2px; }
    .sk-label-group-hdr { font-size: 11px; font-weight: 700; color: #1f6fac; margin: 18px 0 10px; text-transform: uppercase; letter-spacing: 0.6px; display: flex; align-items: center; gap: 5px; }
    .sk-label-group-hdr:first-child { margin-top: 0; }
  `;
  document.head.appendChild(styleEl);

  const panel = document.createElement("div");
  panel.id = "sidekick-panel";
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0",
    height: "100vh", width: panelW + "px",
    background: "#eaf6fd", color: "#1e293b",
    boxShadow: "-4px 0 24px rgba(46,46,31,0.12)",
    transform: `translateX(${panelW}px)`,
    transition: "transform 0.25s ease",
    zIndex: "999998",
    display: "flex", flexDirection: "column",
    overflow: "hidden"
  });

  const resizeH = document.createElement("div");
  resizeH.className = "sk-resize-h";
  panel.appendChild(resizeH);

  const resizeV = document.createElement("div");
  resizeV.className = "sk-resize-v";
  panel.appendChild(resizeV);

  const headerSlot = document.createElement("div");
  headerSlot.id = "sidekick-header";
  headerSlot.style.flexShrink = "0";
  panel.appendChild(headerSlot);

  const bodySlot = document.createElement("div");
  bodySlot.id = "sidekick-body";
  Object.assign(bodySlot.style, {
    flex: "1", overflowY: "auto", overflowX: "hidden",
    padding: "14px 14px 20px",
    minHeight: "0"
  });
  panel.appendChild(bodySlot);

  const arrow = document.createElement("div");
  arrow.id = "sidekick-arrow";
  Object.assign(arrow.style, {
    position: "fixed", top: "50%", right: "0",
    transform: "translateY(-50%)",
    width: "20px", height: "60px",
    background: "#164971", color: "#bfe6ff",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", zIndex: "999999",
    borderRadius: "6px 0 0 6px", fontSize: "11px",
    userSelect: "none"
  });
  arrow.innerHTML = "❮";

  document.body.appendChild(panel);
  document.body.appendChild(arrow);

  const loadingMsg = document.createElement("div");
  loadingMsg.className = "sk-empty";
  loadingMsg.textContent = "Loading…";
  bodySlot.appendChild(loadingMsg);

  let isOpen = false;
  function openPanel() {
    isOpen = true;
    panel.style.transform = "translateX(0)";
    arrow.style.right = panelW + "px";
    arrow.innerHTML = "❯";
  }
  function closePanel() {
    isOpen = false;
    panel.style.transform = `translateX(${panelW}px)`;
    arrow.style.right = "0";
    arrow.innerHTML = "❮";
  }
  arrow.addEventListener("click", () => isOpen ? closePanel() : openPanel());

  let panelH = null;

  resizeH.addEventListener("mousedown", e => {
    e.preventDefault();
    resizeH.classList.add("dragging");
    const startX = e.clientX, startW = panel.offsetWidth;
    const onMove = e2 => {
      const newW = Math.max(300, Math.min(900, startW + (startX - e2.clientX)));
      panelW = newW;
      panel.style.width = newW + "px";
      if (isOpen) arrow.style.right = newW + "px";
      if (!isOpen) panel.style.transform = `translateX(${newW}px)`;
    };
    const onUp = () => { resizeH.classList.remove("dragging"); document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  resizeV.addEventListener("mousedown", e => {
    e.preventDefault();
    resizeV.classList.add("dragging");
    const startY = e.clientY, startH = panel.offsetHeight;
    const onMove = e2 => {
      const newH = Math.max(200, Math.min(window.innerHeight, startH + (e2.clientY - startY)));
      panelH = newH;
      panel.style.height = newH + "px";
      panel.style.top = (window.innerHeight - newH) + "px";
    };
    const onUp = () => { resizeV.classList.remove("dragging"); document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  function renderView(view) {
    currentView = view;
    headerSlot.innerHTML = "";
    bodySlot.innerHTML = "";
    bodySlot.scrollTop = 0;
    if (view === "main") renderMain();
    else if (view === "explore") renderExplore();
    else if (view === "bin") renderBin();
  }

  function renderMain() {
    const d = getData();
    if (!d.notebooks.length) { renderExplore(); return; }
    const nb = d.notebooks.find(n => n.id === d.activeNotebookId) || d.notebooks[0];

    const hdr = document.createElement("div");
    hdr.className = "sk-header";

    const row1 = document.createElement("div");
    row1.className = "sk-header-row";

    const nbName = document.createElement("div");
    nbName.className = "sk-nb-name";
    nbName.title = "Click to rename";
    nbName.textContent = nb.name;
    nbName.addEventListener("click", () => inlineRename(nb, nbName));

    const syncDot = document.createElement("span");
    syncDot.className = "sk-sync-dot";
    syncDot.title = "Synced across tabs";

    const labelsBtn = svgIconBtn("tag", "Edit labels");
    labelsBtn.addEventListener("click", e => { e.stopPropagation(); openLabelPopover(nb, labelsBtn); });

    const exploreBtn = svgIconBtn("grid", "Browse notebooks");
    exploreBtn.addEventListener("click", () => renderView("explore"));

    const binCount = (d.recycleBin || []).length;
    const binBtn = svgIconBtn("trash", `Recycle bin${binCount ? " (" + binCount + ")" : ""}`);
    if (binCount) {
      binBtn.style.position = "relative";
      const dot = mk("span");
      Object.assign(dot.style, { position: "absolute", top: "3px", right: "3px", width: "7px", height: "7px", background: "#ef4444", borderRadius: "50%", display: "block" });
      binBtn.appendChild(dot);
    }
    binBtn.addEventListener("click", () => renderView("bin"));

    row1.append(nbName, syncDot, labelsBtn, exploreBtn, binBtn);

    const row2 = document.createElement("div");
    row2.className = "sk-action-row";

    const capBtn = mk("button", "sk-btn primary");
    capBtn.title = "Capture (Alt+Shift+C)";
    capBtn.innerHTML = "";
    // capBtn.append(svgIcon("camera"), " Capture");
    capBtn.append(svgIcon("camera"));
    capBtn.addEventListener("click", startCapture);

    const saveBtn = mk("button", "sk-btn");
    saveBtn.title = "Save (Ctrl+S)";
    saveBtn.innerHTML = "";
    saveBtn.append(svgIcon("save"));
    saveBtn.addEventListener("click", () => performSave());
    saveBtnEl = saveBtn;

    const dlWrap = mk("div"); dlWrap.style.position = "relative";
    const dlBtn = mk("button", "sk-btn"); dlBtn.innerHTML = "";
    dlBtn.title = "Download (Alt+Shift+D for .txt)";
    // dlBtn.append(svgIcon("download"), " Download ▾");
    dlBtn.append(svgIcon("download"), " ▾");
    const dlDrop = mk("div", "sk-dropdown");
    dlDrop.style.display = "none";

    [["txt", "txt", " .txt"], ["docx", "docx", " .doc (Word)"]].forEach(([iconName, fmt, label]) => {
      const it = mk("div", "sk-dd-item");
      it.append(svgIcon(iconName), label);
      it.addEventListener("click", () => { downloadNotebook(nb, fmt); dlDrop.style.display = "none"; });
      dlDrop.appendChild(it);
    });
    dlBtn.addEventListener("click", e => { e.stopPropagation(); dlDrop.style.display = dlDrop.style.display === "none" ? "block" : "none"; });
    document.addEventListener("click", () => { dlDrop.style.display = "none"; }, { once: false });
    dlWrap.append(dlBtn, dlDrop);

    const row3 = document.createElement("div");
    row3.className = "sk-action-row";
    row3.style.marginTop = "8px";
    const searchWrap = mk("div"); searchWrap.style.cssText = "position:relative;flex:1;";
    const searchInput = mk("input", "sk-input");
    searchInput.type = "search";
    searchInput.placeholder = "Search notes…";
    searchInput.value = noteSearchQuery;
    searchInput.style.paddingLeft = "30px";
    const searchIconEl = svgIcon("search");
    searchIconEl.style.cssText = "position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#5b7a90;pointer-events:none;";
    searchInput.addEventListener("input", () => {
      noteSearchQuery = searchInput.value;
      renderNotesBody(nb);
    });
    searchWrap.append(searchIconEl, searchInput);
    row3.appendChild(searchWrap);

    row2.append(capBtn, saveBtn, dlWrap);
    hdr.append(row1, row2, row3);
    headerSlot.appendChild(hdr);

    renderNotesBody(nb);
  }

  function renderNotesBody(nb) {
    const d = getData();
    bodySlot.innerHTML = "";

    const allNotes = d.capturedItems.filter(n => n.notebookId === nb.id);
    if (!allNotes.length) {
      const empty = mk("div", "sk-empty");
      empty.innerHTML = "No notes yet.<br>Click <b>Capture</b> to start.";
      bodySlot.appendChild(empty);
      return;
    }

    const q = noteSearchQuery.trim().toLowerCase();
    const notes = q
      ? allNotes.filter(n => (n.content || "").toLowerCase().includes(q) || n.type.toLowerCase().includes(q))
      : allNotes;

    if (!notes.length) {
      const empty = mk("div", "sk-empty");
      empty.textContent = `No notes match "${noteSearchQuery}".`;
      bodySlot.appendChild(empty);
      return;
    }

    const lbl = mk("span", "sk-section-lbl");
    lbl.textContent = q
      ? `${notes.length} of ${allNotes.length} note${allNotes.length !== 1 ? "s" : ""}`
      : `${notes.length} note${notes.length !== 1 ? "s" : ""}`;
    bodySlot.appendChild(lbl);

    const canDrag = !q; // reordering only makes sense against the full, unfiltered list
    const ordered = notes.slice().sort((a, b) => {
      const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      return noteOrderValue(a) - noteOrderValue(b);
    });
    ordered.forEach(note => bodySlot.appendChild(noteCard(note, nb, canDrag)));
  }

  function noteOrderValue(n) {
    return typeof n.order === "number" ? n.order : -new Date(n.capturedAt).getTime();
  }

  function highlightText(el, text, query) {
    text = text == null ? "" : String(text);
    el.textContent = "";
    const q = (query || "").trim();
    if (!q) { el.textContent = text; return; }
    const escQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escQ})`, "gi");
    let lastIndex = 0, match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      const mark = mk("mark", "sk-highlight");
      mark.textContent = match[0];
      el.appendChild(mark);
      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) re.lastIndex++;
    }
    if (lastIndex < text.length) el.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  function noteCard(note, nb, canDrag) {
    const card = mk("div", "sk-note-card" + (note.pinned ? " pinned" : ""));
    card.dataset.noteId = note.id;
    card.dataset.pinned = String(!!note.pinned);

    const handle = mk("div", "sk-drag-handle" + (canDrag ? "" : " disabled"));
    handle.title = canDrag ? "Drag to reorder" : "Clear search to reorder";
    handle.appendChild(svgIcon("grip"));
    if (canDrag) {
      handle.addEventListener("pointerdown", e => startNoteDrag(e, card, note, nb));
    }
    card.appendChild(handle);

    const top = mk("div"); Object.assign(top.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", paddingRight: "58px" });
    if (note.pinned) {
      const pinBadge = mk("span", "sk-pin-badge"); pinBadge.title = "Pinned";
      pinBadge.appendChild(svgIcon("pin"));
      top.appendChild(pinBadge);
    }
    const tag = mk("span", `sk-tag ${note.type}`); tag.textContent = note.type;
    const ts = mk("span"); Object.assign(ts.style, { fontSize: "11px", color: "#5b7a90", flex: "1" });
    ts.textContent = new Date(note.capturedAt).toLocaleString();
    top.append(tag, ts);

    // Hover three-dot menu: Pin / Copy / Share
    const menuWrap = mk("div", "sk-note-menu-wrap");
    const menuBtn = mk("button", "sk-note-menu-btn"); menuBtn.title = "More options"; menuBtn.textContent = "⋯";
    const menuDrop = mk("div", "sk-dropdown"); menuDrop.style.display = "none";

    const closeMenu = () => { menuDrop.style.display = "none"; menuBtn.classList.remove("open"); };

    const pinItem = mk("div", "sk-dd-item");
    const pinLabel = mk("span"); pinLabel.textContent = note.pinned ? "Unpin" : "Pin";
    pinItem.append(svgIcon("pin"), pinLabel);
    pinItem.addEventListener("click", e => { e.stopPropagation(); closeMenu(); toggleNotePin(note); });

    const copyItem = mk("div", "sk-dd-item");
    const copyLabel = mk("span"); copyLabel.textContent = "Copy";
    copyItem.append(svgIcon("copy"), copyLabel);
    copyItem.addEventListener("click", e => {
      e.stopPropagation();
      copyNoteContent(note, copyItem);
    });

    const shareItem = mk("div", "sk-dd-item");
    const shareLabel = mk("span"); shareLabel.textContent = "Share";
    shareItem.append(svgIcon("share"), shareLabel);
    shareItem.title = "Coming soon";
    shareItem.addEventListener("click", e => { e.stopPropagation(); closeMenu(); shareNote(note); });

    menuDrop.append(pinItem, copyItem, shareItem);
    menuBtn.addEventListener("click", e => {
      e.stopPropagation();
      const willOpen = menuDrop.style.display === "none";
      document.querySelectorAll(".sk-dropdown").forEach(dd => { dd.style.display = "none"; });
      document.querySelectorAll(".sk-note-menu-btn.open").forEach(b => b.classList.remove("open"));
      if (willOpen) { menuDrop.style.display = "block"; menuBtn.classList.add("open"); }
    });
    document.addEventListener("click", closeMenu);
    menuWrap.append(menuBtn, menuDrop);
    card.appendChild(menuWrap);

    const delBtn = mk("button", "sk-note-del"); delBtn.title = "Delete note"; delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => { deleteNote(note, nb); });
    card.appendChild(delBtn);

    const body = mk("div"); Object.assign(body.style, { fontSize: "13px", color: "#1e293b", marginBottom: "6px", lineHeight: "1.5" });

    if (note.type === "image") {
      const img = mk("img"); img.src = note.content;
      Object.assign(img.style, { maxWidth: "100%", maxHeight: "130px", borderRadius: "4px", display: "block" });
      body.appendChild(img);
    } else if (note.type === "video") {
      console.log("[Sidekick] Rendering video note card:", { id: note.id, content: note.content, thumb: note.thumb, platform: note.platform });

      const watchUrl = note.content || note.pageUrl || "";
      const wrap = mk("a"); wrap.href = watchUrl; wrap.target = "_blank"; wrap.rel = "noopener noreferrer";
      wrap.style.cssText = "display:block;position:relative;text-decoration:none;";

      if (note.thumb) {
        console.log("[Sidekick] Rendering video thumbnail:", note.thumb);
        const thumb = mk("img"); thumb.src = note.thumb;
        Object.assign(thumb.style, { maxWidth: "100%", maxHeight: "130px", borderRadius: "6px", display: "block", objectFit: "cover" });
        thumb.addEventListener("error", () => {
          console.warn("[Sidekick] Video thumbnail failed to load:", note.thumb);
        });
        const play = mk("div");
        play.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40px;height:40px;background:rgba(0,0,0,0.65);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;pointer-events:none;";
        play.textContent = "\u25b6";
        wrap.append(thumb, play);
      } else {
        console.log("[Sidekick] No thumbnail available, rendering fallback pill for:", watchUrl);
        const pill = mk("div");
        pill.style.cssText = "background:#eaf6fd;color:#14587d;border-radius:6px;padding:10px 12px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;border:1px solid #bfe0fa;";
        const short = watchUrl.slice(0, 60) + (watchUrl.length > 60 ? "\u2026" : "");
        pill.innerHTML = `<span style="font-size:20px">\ud83c\udfa6</span><span>${esc(short)}</span>`;
        wrap.appendChild(pill);
      }

      body.appendChild(wrap);
    } else {
      const full = note.content || "";
      const isLong = full.length > 180;
      const textSpan = mk("span");
      highlightText(textSpan, isLong ? full.slice(0, 180) + "…" : full, noteSearchQuery);
      body.appendChild(textSpan);

      if (isLong) {
        const readMore = mk("span", "sk-read-more");
        readMore.textContent = "Read more";
        let expanded = false;
        readMore.addEventListener("click", () => {
          expanded = !expanded;
          highlightText(textSpan, expanded ? full : full.slice(0, 180) + "…", noteSearchQuery);
          readMore.textContent = expanded ? "Read less" : "Read more";
        });
        body.appendChild(mk("br"));
        body.appendChild(readMore);
      }
    }

    const src = mk("a"); src.href = note.sourceUrl; src.target = "_blank"; src.rel = "noopener noreferrer";
    Object.assign(src.style, { fontSize: "11px", color: "#5b7a90", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" });
    src.textContent = note.sourceUrl;
    src.onmouseover = () => src.style.textDecoration = "underline";
    src.onmouseout = () => src.style.textDecoration = "none";

    card.append(top, body, src);
    return card;
  }

  function startNoteDrag(e, card, note, nb) {
    e.preventDefault();
    const pinnedGroup = !!note.pinned;
    const container = bodySlot;
    const allCards = [...container.querySelectorAll(".sk-note-card")];
    const groupCards = allCards.filter(c => c !== card && c.dataset.pinned === String(pinnedGroup));
    const firstOtherIdx = allCards.findIndex(c => c.dataset.pinned !== String(pinnedGroup));
    const boundaryEl = firstOtherIdx !== -1 ? allCards[firstOtherIdx] : null;

    card.classList.add("sk-dragging");
    try { card.setPointerCapture(e.pointerId); } catch (_) {}

    const onMove = ev => {
      const y = ev.clientY;
      let referenceCard = null;
      for (const c of groupCards) {
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height / 2) { referenceCard = c; break; }
      }
      if (referenceCard) {
        if (referenceCard !== card.nextSibling) container.insertBefore(card, referenceCard);
      } else if (boundaryEl) {
        if (boundaryEl !== card.nextSibling) container.insertBefore(card, boundaryEl);
      } else if (container.lastElementChild !== card) {
        container.appendChild(card);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      try { card.releasePointerCapture(e.pointerId); } catch (_) {}
      card.classList.remove("sk-dragging");
      commitNoteOrder(nb);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  function commitNoteOrder(nb) {
    const d = getData();
    const cardEls = [...bodySlot.querySelectorAll(".sk-note-card")];
    cardEls.forEach((c, idx) => {
      const note = d.capturedItems.find(n => n.id === c.dataset.noteId);
      if (note) note.order = idx * 10;
    });
    setData(d);
    renderNotesBody(nb);
  }

  function toggleNotePin(note) {
    const d = getData();
    const t = d.capturedItems.find(n => n.id === note.id);
    if (!t) return;
    t.pinned = !t.pinned;
    setData(d);
    if (currentView === "main") renderView("main");
  }

  function copyNoteContent(note, itemEl) {
    const text = note.content || "";
    const done = ok => {
      if (!itemEl) return;
      const orig = itemEl.textContent;
      itemEl.textContent = ok ? "✓ Copied!" : "⚠ Copy failed";
      setTimeout(() => { itemEl.textContent = orig; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true)).catch(err => {
        console.warn("[Sidekick] clipboard write failed:", err);
        done(false);
      });
    } else {
      try {
        const ta = mk("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done(true);
      } catch (err) {
        console.warn("[Sidekick] fallback copy failed:", err);
        done(false);
      }
    }
  }

  function shareNote(note) {
    // Placeholder — sharing isn't wired up yet.
    console.log("[Sidekick] Share requested for note:", note.id);
    alert("Share is coming soon!");
  }

  function inlineRename(nb, el) {
    const input = mk("input", "sk-input");
    input.value = nb.name;
    Object.assign(input.style, { fontSize: "15px", fontWeight: "700", flex: "1", minWidth: "0" });
    el.replaceWith(input);
    input.focus(); input.select();
    const commit = () => {
      const val = input.value.trim() || nb.name;
      const d = getData();
      const t = d.notebooks.find(n => n.id === nb.id);
      if (t) { t.name = val; setData(d); }
      renderView("main");
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") renderView("main"); });
  }

  function openLabelPopover(nb, anchorEl) {
    document.querySelectorAll(".sk-label-popover").forEach(p => p.remove());

    const pop = mk("div", "sk-label-popover");
    const title = mk("div");
    title.style.cssText = "font-size:11px;font-weight:700;color:#5b7a90;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;";
    title.textContent = "Labels";

    const input = mk("input", "sk-input");
    input.placeholder = "e.g. Work, Research";
    input.value = (nb.labels || []).join(", ");

    const hint = mk("div");
    hint.style.cssText = "font-size:11px;color:#5b7a90;margin-top:6px;";
    hint.textContent = "Comma-separated · Enter to save · Esc to cancel";

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const labels = [...new Set(input.value.split(",").map(s => s.trim()).filter(Boolean))];
      const d = getData();
      const t = d.notebooks.find(n => n.id === nb.id);
      if (t) { t.labels = labels; setData(d); }
      pop.remove();
      document.removeEventListener("mousedown", outsideClick, true);
      if (currentView === "main" || currentView === "explore") renderView(currentView);
    };
    const cancel = () => {
      committed = true;
      pop.remove();
      document.removeEventListener("mousedown", outsideClick, true);
    };

    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });

    function outsideClick(ev) {
      if (!pop.contains(ev.target)) commit();
    }

    pop.append(title, input, hint);
    document.body.appendChild(pop);

    const r = anchorEl.getBoundingClientRect();
    const popW = 230;
    let right = window.innerWidth - r.right;
    right = Math.max(8, Math.min(right, window.innerWidth - popW - 8));
    pop.style.top = (r.bottom + 4) + "px";
    pop.style.right = right + "px";
    pop.style.left = "auto";

    input.focus(); input.select();
    setTimeout(() => document.addEventListener("mousedown", outsideClick, true), 0);
  }

  function renderExplore() {
    const d = getData();

    const hdr = mk("div", "sk-header");
    const row = mk("div", "sk-header-row");
    const back = svgIconBtn("back", "Back"); back.addEventListener("click", () => renderView("main"));
    const title = mk("div", "sk-view-title"); title.textContent = "Notebooks";
    const addBtn = mk("button", "sk-btn primary"); addBtn.textContent = "＋ New";
    addBtn.addEventListener("click", createNotebook);
    row.append(back, title, addBtn);

    const searchRow = mk("div", "sk-action-row"); searchRow.style.marginTop = "8px";
    const searchWrap = mk("div"); searchWrap.style.cssText = "position:relative;flex:1;";
    const searchInput = mk("input", "sk-input");
    searchInput.type = "search";
    searchInput.placeholder = "Search notebooks…";
    searchInput.value = notebookSearchQuery;
    searchInput.style.paddingLeft = "30px";
    const searchIconEl = svgIcon("search");
    searchIconEl.style.cssText = "position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#5b7a90;pointer-events:none;";
    searchInput.addEventListener("input", () => {
      notebookSearchQuery = searchInput.value;
      renderNotebooksList();
    });
    searchWrap.append(searchIconEl, searchInput);
    searchRow.appendChild(searchWrap);

    hdr.append(row, searchRow);
    headerSlot.appendChild(hdr);

    if (!d.notebooks.length) {
      bodySlot.innerHTML = `<div class="sk-empty">No notebooks yet.</div>`;
      return;
    }

    renderNotebooksList();
  }

  function buildNbCard(nb, d) {
    const cnt = d.capturedItems.filter(n => n.notebookId === nb.id).length;
    const card = mk("div", "sk-nb-card" + (nb.id === d.activeNotebookId ? " active" : ""));

    const left = mk("div"); Object.assign(left.style, { display: "flex", alignItems: "center", gap: "10px", flex: "1", minWidth: "0" });
    const ico = mk("span"); ico.appendChild(svgIcon("notebook")); ico.style.fontSize = "18px";
    const info = mk("div"); info.style.cssText = "flex:1;min-width:0;";
    const name = mk("div"); Object.assign(name.style, { fontSize: "14px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#1e293b" });
    highlightText(name, nb.name, notebookSearchQuery);
    const meta = mk("div"); meta.style.cssText = "font-size:11px;color:#5b7a90;margin-top:2px;";
    meta.textContent = `${cnt} note${cnt !== 1 ? "s" : ""} · ${new Date(nb.createdAt).toLocaleDateString()}`;
    info.append(name, meta);

    if ((nb.labels || []).length) {
      const chipRow = mk("div");
      chipRow.style.cssText = "margin-top:4px;";
      nb.labels.forEach(l => {
        const chip = mk("span", "sk-label-chip");
        chip.textContent = l;
        chipRow.appendChild(chip);
      });
      info.appendChild(chipRow);
    }

    left.append(ico, info);

    const right = mk("div"); right.style.cssText = "display:flex;align-items:center;gap:4px;flex-shrink:0;";
    if (nb.id === d.activeNotebookId) {
      const pill = mk("span"); pill.style.cssText = "font-size:11px;color:#164971;font-weight:600;padding:2px 8px;background:#cfeeff;border-radius:10px;border:1px solid #7ec4ea;";
      pill.textContent = "Active"; right.appendChild(pill);
    }
    const del = svgIconBtn("trash", "Delete");
    del.addEventListener("click", e => { e.stopPropagation(); deleteNotebook(nb); });
    right.appendChild(del);

    card.append(left, right);
    card.addEventListener("click", () => {
      const d2 = getData(); d2.activeNotebookId = nb.id; setData(d2);
      noteSearchQuery = "";
      renderView("main");
    });

    card.addEventListener("contextmenu", e => {
      e.preventDefault();
      document.querySelectorAll(".sk-dropdown").forEach(dd => dd.remove());
      document.querySelectorAll(".sk-label-popover").forEach(p => p.remove());

      const menu = mk("div", "sk-dropdown");
      Object.assign(menu.style, { position: "fixed", top: e.clientY + "px", left: e.clientX + "px", display: "block" });

      const editLabelsItem = mk("div", "sk-dd-item");
      const lblText = mk("span"); lblText.textContent = "Edit Labels";
      editLabelsItem.append(svgIcon("tag"), lblText);
      editLabelsItem.addEventListener("click", ev => {
        ev.stopPropagation();
        menu.remove();
        openLabelPopover(nb, card);
      });

      menu.appendChild(editLabelsItem);
      document.body.appendChild(menu);

      const closeMenu = ev => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener("mousedown", closeMenu, true);
        }
      };
      setTimeout(() => document.addEventListener("mousedown", closeMenu, true), 0);
    });

    return card;
  }

  function renderNotebooksList() {
    const d = getData();
    bodySlot.innerHTML = "";

    const q = notebookSearchQuery.trim().toLowerCase();
    const list = q ? d.notebooks.filter(nb => nb.name.toLowerCase().includes(q)) : d.notebooks;

    if (!list.length) {
      bodySlot.innerHTML = `<div class="sk-empty">No notebooks match "${esc(notebookSearchQuery)}".</div>`;
      return;
    }

    const groups = new Map();
    const unlabeled = [];
    list.forEach(nb => {
      const labels = nb.labels || [];
      if (!labels.length) { unlabeled.push(nb); return; }
      labels.forEach(l => {
        if (!groups.has(l)) groups.set(l, []);
        groups.get(l).push(nb);
      });
    });

    const sortedLabels = [...groups.keys()].sort((a, b) => a.localeCompare(b));

    sortedLabels.forEach(lblName => {
      const hdr = mk("div", "sk-label-group-hdr");
      hdr.append(svgIcon("tag"), document.createTextNode(" " + lblName));
      bodySlot.appendChild(hdr);
      groups.get(lblName).forEach(nb => bodySlot.appendChild(buildNbCard(nb, d)));
    });

    if (unlabeled.length) {
      const hdr = mk("div", "sk-label-group-hdr");
      hdr.textContent = "Unlabeled";
      bodySlot.appendChild(hdr);
      unlabeled.forEach(nb => bodySlot.appendChild(buildNbCard(nb, d)));
    }
  }

  function createNotebook() {
    const d = getData();
    const nb = { id: uid(), name: "New Notebook", createdAt: now(), labels: [] };
    d.notebooks.push(nb); d.activeNotebookId = nb.id; setData(d);
    renderView("main");
    setTimeout(() => {
      const el = headerSlot.querySelector(".sk-nb-name");
      if (el) el.click();
    }, 30);
  }

  function renderBin() {
    const d = getData();

    const hdr = mk("div", "sk-header");
    const row = mk("div", "sk-header-row");
    const back = svgIconBtn("back", "Back"); back.addEventListener("click", () => renderView("main"));
    const title = mk("div", "sk-view-title"); title.append(svgIcon("trash"), document.createTextNode(" Recycle Bin"));
    row.append(back, title);
    hdr.appendChild(row);
    headerSlot.appendChild(hdr);

    const bin = d.recycleBin || [];
    if (!bin.length) {
      bodySlot.innerHTML = `<div class="sk-empty">Recycle bin is empty.</div>`;
      return;
    }

    const info = mk("p"); info.style.cssText = "font-size:12px;color:#5b7a90;margin-bottom:12px;";
    info.textContent = "Items are permanently deleted after 30 days.";
    bodySlot.appendChild(info);

    const nbs = bin.filter(e => e.type === "notebook");
    const nts = bin.filter(e => e.type === "note");

    if (nbs.length) {
      const lbl = mk("span", "sk-section-lbl"); lbl.textContent = "Deleted Notebooks";
      bodySlot.appendChild(lbl);
      nbs.forEach(e => bodySlot.appendChild(binCard(e, d)));
    }
    if (nts.length) {
      const lbl = mk("span", "sk-section-lbl"); lbl.style.marginTop = "12px"; lbl.textContent = "Deleted Notes";
      bodySlot.appendChild(lbl);
      nts.forEach(e => bodySlot.appendChild(binCard(e, d)));
    }
  }

  function binCard(entry, d) {
    const card = mk("div", "sk-bin-card");
    const top = mk("div"); Object.assign(top.style, { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" });

    const info = mk("div"); info.style.flex = "1";
    const name = mk("div"); name.style.cssText = "font-size:13px;font-weight:600;color:#1e293b;";
    const meta = mk("div"); meta.className = "sk-bin-meta";

    if (entry.type === "notebook") {
      name.appendChild(svgIcon("notebook"));
      name.append(" " + entry.notebook.name);
      const cnt = (entry.notes || []).length;
      meta.textContent = `${cnt} note${cnt !== 1 ? "s" : ""} · `;
      meta.appendChild(daysLeft(entry.deletedAt));
    } else {
      const note = entry.note;
      const tag = mk("span", `sk-tag ${note.type}`); tag.textContent = note.type; tag.style.marginRight = "6px";
      name.appendChild(tag);
      name.append(note.content ? note.content.slice(0, 55) + (note.content.length > 55 ? "…" : "") : "(media)");
      const origNb = d.notebooks.find(n => n.id === entry.originalNotebookId);
      meta.textContent = `From: ${origNb ? origNb.name : "deleted notebook"} · `;
      meta.appendChild(daysLeft(entry.deletedAt));
    }

    info.append(name, meta);

    const btns = mk("div"); btns.style.cssText = "display:flex;gap:5px;flex-shrink:0;";
    const restoreBtn = mk("button", "sk-btn"); restoreBtn.style.fontSize = "12px"; restoreBtn.textContent = "↩ Restore";
    restoreBtn.addEventListener("click", () => restoreEntry(entry));
    const permDel = mk("button", "sk-btn danger"); permDel.style.fontSize = "12px"; permDel.textContent = "✕ Delete";
    permDel.addEventListener("click", () => permDelete(entry));
    btns.append(restoreBtn, permDel);

    top.append(info, btns);
    card.appendChild(top);
    return card;
  }

  function daysLeft(deletedAt) {
    const span = mk("span");
    const ms = 30 * 24 * 60 * 60 * 1000 - (Date.now() - new Date(deletedAt).getTime());
    const days = Math.max(1, Math.ceil(ms / 86400000));
    span.textContent = `${days}d remaining`;
    return span;
  }

  function saveCapturedData(payload) {
    const d = getData();
    const item = { ...payload, id: uid(), notebookId: d.activeNotebookId, sourceUrl: location.href, capturedAt: now() };
    console.log("[Sidekick] Saving captured item:", item);
    d.capturedItems.push(item);
    setData(d);
    undoStack = [];
    if (currentView === "main") renderView("main");
    return item;
  }

  function deleteNote(note, nb) {
    const d = getData();
    d.capturedItems = d.capturedItems.filter(n => n.id !== note.id);
    d.recycleBin = d.recycleBin || [];
    d.recycleBin.push({ id: uid(), type: "note", note, originalNotebookId: nb.id, deletedAt: now() });
    setData(d);
    renderView("main");
  }

  function deleteNotebook(nb) {
    if (!confirm(`Delete "${nb.name}"?\n\nMoved to Recycle Bin — permanently deleted after 30 days.`)) return;
    const d = getData();
    const notes = d.capturedItems.filter(n => n.notebookId === nb.id);
    d.capturedItems = d.capturedItems.filter(n => n.notebookId !== nb.id);
    d.notebooks = d.notebooks.filter(n => n.id !== nb.id);
    d.recycleBin = d.recycleBin || [];
    d.recycleBin.push({ id: uid(), type: "notebook", notebook: nb, notes, deletedAt: now() });
    if (d.activeNotebookId === nb.id) d.activeNotebookId = d.notebooks[0]?.id || null;
    if (!d.notebooks.length) {
      const newNb = { id: uid(), name: "My Notebook", createdAt: now(), labels: [] };
      d.notebooks.push(newNb); d.activeNotebookId = newNb.id;
    }
    setData(d);
    renderView("explore");
  }

  function restoreEntry(entry) {
    const d = getData();
    d.recycleBin = (d.recycleBin || []).filter(e => e.id !== entry.id);
    if (entry.type === "notebook") {
      d.notebooks.push(entry.notebook);
      d.capturedItems.push(...(entry.notes || []));
      d.activeNotebookId = entry.notebook.id;
    } else {
      const note = { ...entry.note };
      if (!d.notebooks.find(n => n.id === entry.originalNotebookId)) note.notebookId = d.activeNotebookId;
      d.capturedItems.push(note);
    }
    setData(d);
    renderView("bin");
  }

  function permDelete(entry) {
    if (!confirm("Permanently delete? This cannot be undone.")) return;
    const d = getData();
    d.recycleBin = (d.recycleBin || []).filter(e => e.id !== entry.id);
    setData(d);
    renderView("bin");
  }

  function undoLastCapture() {
    const d = getData();
    if (!d.capturedItems.length) return;
    const removed = d.capturedItems.pop();
    d.recycleBin = d.recycleBin || [];
    d.recycleBin.push({ id: uid(), type: "note", note: removed, originalNotebookId: removed.notebookId, deletedAt: now() });
    undoStack.push(removed);
    setData(d);
    if (currentView === "main") renderView("main");
  }

  function redoLastCapture() {
    if (!undoStack.length) return null;
    const item = undoStack.pop();
    const d = getData();
    d.recycleBin = (d.recycleBin || []).filter(e => !(e.type === "note" && e.note.id === item.id));
    d.capturedItems.push(item);
    setData(d);
    if (currentView === "main") renderView("main");
    return item;
  }

  let saveBtnEl = null;

  function flashButton(btn, text, ms) {
    if (!btn) return;
    btn.textContent = text;
    setTimeout(() => {
      btn.innerHTML = "";
      btn.appendChild(svgIcon("save"));
    }, ms);
  }

  function performSave() {
    if (!contextOk()) {
      flashButton(saveBtnEl, "⚠ Reload tab", 2000);
      return;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: getData() }, () => {
      if (chrome.runtime.lastError) { console.error(chrome.runtime.lastError); return; }
      flashButton(saveBtnEl, "✓ Saved!", 1400);
    });
  }

  // ── KEYBOARD SHORTCUTS ──────────────────────────────────────────────────
  // Capture: Alt+Shift+C   Download (.txt): Alt+Shift+D
  // Save: Ctrl/Cmd+S   Undo: Ctrl/Cmd+Z   Redo: Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z
  // Save/Undo/Redo only act while the panel is open, and none of these fire
  // while focus is in an editable field (so normal typing/undo is untouched).
  document.addEventListener("keydown", e => {
    if (!sidekickActive) return;
    const ae = document.activeElement;
    const isEditable = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
    if (isEditable) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.altKey && e.shiftKey && !mod && key === "c") {
      e.preventDefault();
      startCapture();
      return;
    }
    if (e.altKey && e.shiftKey && !mod && key === "d") {
      e.preventDefault();
      const d = getData();
      const nb = d.notebooks.find(n => n.id === d.activeNotebookId) || d.notebooks[0];
      if (nb) downloadNotebook(nb, "txt");
      return;
    }

    // Complete/done a capture from the quick-access bar (Alt+Enter or Shift+Enter),
    // available whenever the "captured" row is showing — including with the panel closed.
    if (!mod && key === "enter" && (e.altKey || e.shiftKey) && captureBarMode === "captured") {
      e.preventDefault();
      hideBar();
      openPanel();
      return;
    }

    if (!isOpen) return;

    if (mod && !e.altKey && !e.shiftKey && key === "s") {
      e.preventDefault();
      performSave();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === "z") {
      e.preventDefault();
      undoLastCapture();
      return;
    }
    if (mod && !e.altKey && ((key === "y" && !e.shiftKey) || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      redoLastCapture();
      return;
    }
  }, true);

  function downloadNotebook(nb, fmt) {
    const d = getData();
    const notes = d.capturedItems.filter(n => n.notebookId === nb.id);
    if (fmt === "txt") {
      let txt = `${nb.name}\nExported: ${new Date().toLocaleString()}\n${"─".repeat(50)}\n\n`;
      notes.forEach((n, i) => {
        txt += `[${i+1}] ${n.type.toUpperCase()} · ${new Date(n.capturedAt).toLocaleString()}\n`;
        txt += `${n.content}\nSource: ${n.sourceUrl}\n\n`;
      });
      triggerDL(new Blob([txt], { type: "text/plain" }), nb.name + ".txt");
    } else {
      let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(nb.name)}</title>
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#1e293b}
h1{font-size:22px;border-bottom:2px solid #2f8fcf;padding-bottom:8px}
.note{border:1px solid #bfe0fa;border-radius:8px;padding:14px;margin-bottom:16px;background:#ffffff}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 6px;border-radius:3px;text-transform:uppercase;margin-bottom:6px}
.text{background:#dceefc;color:#0c4a6e}.image{background:#cfe8fb;color:#0a4a75}
.video{background:#b3daf7;color:#08395c}.iframe{background:#eaf6fd;color:#14587d}
.meta{font-size:12px;color:#5b7a90;margin-bottom:6px}.content{font-size:14px;line-height:1.6;word-break:break-word}
img{max-width:100%;max-height:200px;border-radius:4px;display:block;margin-top:8px}a{color:#2f8fcf}
</style></head><body><h1>📓 ${esc(nb.name)}</h1>
<p style="color:#5b7a90;font-size:13px">Exported ${new Date().toLocaleString()} · ${notes.length} note${notes.length!==1?"s":""}</p>`;
      notes.forEach((n, i) => {
        html += `<div class="note"><span class="tag ${n.type}">${n.type}</span>
<div class="meta">#${i+1} · ${new Date(n.capturedAt).toLocaleString()}</div>
<div class="content">${n.type==="image"?`<img src="${esc(n.content)}" alt="captured image">`:esc(n.content)}</div>
<div style="margin-top:8px;font-size:11px;color:#5b7a90">Source: <a href="${esc(n.sourceUrl)}" target="_blank">${esc(n.sourceUrl)}</a></div></div>`;
      });
      html += "</body></html>";
      triggerDL(new Blob([html], { type: "application/vnd.ms-word" }), nb.name + ".doc");
    }
  }

  function triggerDL(blob, name) {
    const a = mk("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  const captureBar = document.createElement("div");
  captureBar.id = "sidekick-capture-bar";
  Object.assign(captureBar.style, {
    position: "fixed", bottom: "0", left: "0", right: "0", height: "54px",
    background: "#1e293b", color: "#bfe6ff",
    boxShadow: "0 -2px 16px rgba(46,46,31,0.35)",
    display: "none",
    alignItems: "center", justifyContent: "space-between",
    padding: "0 18px", zIndex: "9999999",
    fontFamily: "system-ui,sans-serif", fontSize: "13px",
  });
  document.body.appendChild(captureBar);

  function cbBtn(txt, bg) {
    const b = mk("button");
    Object.assign(b.style, { padding: "5px 12px", cursor: "pointer", fontSize: "12px", background: bg || "#164971", color: "#bfe6ff", border: "1px solid rgba(126,196,234,0.3)", borderRadius: "5px", marginLeft: "7px", whiteSpace: "nowrap" });
    b.textContent = txt; return b;
  }
  function cbl(html, color) {
    const s = mk("span"); s.style.color = color || "#8fc4de"; s.innerHTML = html; return s;
  }

  function showBarArmed() {
    captureBarMode = "armed";
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const L = row();
    L.append(svgIcon("camera", "margin-right:6px"), cbl(" Capture mode — click an element or select text", "#bfe6ff"));
    const R = row();
    R.append(cbl("Esc to cancel", "#8fc4de"));
    const c = cbBtn("✕");
    c.addEventListener("click", () => { disableCaptureMode(); hideBar(); });
    R.appendChild(c);
    captureBar.append(L, R);
  }

  function showBarCaptured(item) {
    captureBarMode = "captured";
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const colors = { text:"#2f8fcf", image:"#0d5c8c", video:"#1479b0", iframe:"#0a4a75" };
    const L = row(); L.style.gap = "8px"; L.style.overflow = "hidden";
    const tag = mk("span"); tag.style.cssText = `background:${colors[item.type]||"#2f8fcf"};color:#ffffff;font-weight:700;font-size:10px;padding:2px 7px;border-radius:3px;text-transform:uppercase;flex-shrink:0;`;
    tag.textContent = item.type;
    const prev = mk("span"); Object.assign(prev.style, { color:"#bfe6ff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"340px" });
    if (item.type==="image") {
      const th = mk("img"); Object.assign(th.style, { height:"26px", width:"26px", objectFit:"cover", borderRadius:"3px", verticalAlign:"middle", marginRight:"5px" }); th.src = item.content;
      prev.appendChild(th); prev.append(item.content.split("/").pop().slice(0,40));
    } else if (item.type==="video") {
      prev.textContent = "🎬 " + (item.content.split("/").pop().slice(0,55)||item.content.slice(0,55));
    } else if (item.type==="iframe") {
      prev.textContent = "🖼 " + item.content.slice(0,55);
    } else {
      prev.textContent = item.content.slice(0,80)+(item.content.length>80?"…":"");
    }
    L.append(tag, prev);
    const R = row();
    const u = cbBtn("↩"); u.addEventListener("click", () => { undoLastCapture(); showBarUndone(); }); R.appendChild(u);
    const m = cbBtn("＋"); m.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); }); R.appendChild(m);
    const d2 = cbBtn("✓"); d2.title = "Done (Alt+Enter / Shift+Enter)"; d2.addEventListener("click", () => { hideBar(); openPanel(); }); R.appendChild(d2);
    captureBar.append(L, R);
  }

  function showBarUndone() {
    captureBarMode = "undone";
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const L = row(); L.append(cbl("↩ Note moved to Recycle Bin", "#eaf6fd"));
    const R = row();
    const re = cbBtn("⟳"); re.addEventListener("click", () => { const it = redoLastCapture(); if(it) showBarCaptured(it); }); R.appendChild(re);
    const m = cbBtn("＋"); m.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); }); R.appendChild(m);
    const c = cbBtn("✕"); c.addEventListener("click", () => hideBar()); R.appendChild(c);
    captureBar.append(L, R);
  }

  function hideBar() {
    captureBarMode = "hidden";
    captureBar.style.display = "none"; captureBar.innerHTML = "";
    clearSelection();
    if (currentView === "main") renderView("main");
  }

  function startCapture() {
    const sel = window.getSelection().toString().trim() || lastSelectedText;
    if (sel) {
      console.log("[Sidekick] startCapture: capturing selected text, length:", sel.length);
      const item = saveCapturedData({ type:"text", content:sel }); lastSelectedText = "";
      clearSelection();
      showBarCaptured(item); closePanel(); return;
    }
    console.log("[Sidekick] startCapture: no selection, entering capture mode");
    closePanel(); showBarArmed(); enableCaptureMode();
  }

  let _lastDownX = 0, _lastDownY = 0;

  function onCaptureMouseDown(e) {
    if (!captureArmed) return;
    _lastDownX = e.clientX;
    _lastDownY = e.clientY;
    const link = e.target.closest && e.target.closest("a[href]");
    if (link) e.preventDefault();
  }

  function enableCaptureMode() {
    if (captureArmed) return; captureArmed = true;
    console.log("[Sidekick] Capture mode enabled");
    captureStyleEl = mk("style");
    captureStyleEl.textContent = "#sidekick-capture-bar,#sidekick-capture-bar *{cursor:default!important}*{cursor:crosshair!important}";
    document.head.appendChild(captureStyleEl);
    captureOverlay = mk("div");
    Object.assign(captureOverlay.style, { position:"fixed", top:"0", left:"0", width:"100vw", height:"100vh", background:"rgba(0,0,0,0.03)", pointerEvents:"none", zIndex:"999997" });
    document.body.appendChild(captureOverlay);
    document.addEventListener("mousedown", onCaptureMouseDown, true);
    document.addEventListener("mouseup", onCaptureMouseUp, true);
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("mouseover", onCaptureHover, true);
    document.addEventListener("keydown", onCaptureKeyDown, true);
  }

  function disableCaptureMode() {
    if (!captureArmed) return; captureArmed = false;
    console.log("[Sidekick] Capture mode disabled");
    if (captureStyleEl) { captureStyleEl.remove(); captureStyleEl = null; }
    if (captureOverlay) { captureOverlay.remove(); captureOverlay = null; }
    document.removeEventListener("mousedown", onCaptureMouseDown, true);
    document.removeEventListener("mouseup", onCaptureMouseUp, true);
    document.removeEventListener("click", onCaptureClick, true);
    document.removeEventListener("mouseover", onCaptureHover, true);
    document.removeEventListener("keydown", onCaptureKeyDown, true);
  }

  function onCaptureKeyDown(e) { if (e.key==="Escape") { disableCaptureMode(); hideBar(); } }

  function isInsidePanel() {
    const sel = window.getSelection(); if (!sel||sel.rangeCount===0) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;
    return !!(el&&panel.contains(el));
  }

  function onCaptureMouseUp(e) {
    if (!captureArmed) return;

    const txt = window.getSelection().toString().trim() || lastSelectedText;
    if (txt && !isInsidePanel()) {
      console.log("[Sidekick] mouseup: captured text selection, length:", txt.length);
      const item = saveCapturedData({ type:"text", content:txt }); lastSelectedText = "";
      clearSelection();
      disableCaptureMode(); showBarCaptured(item);
      return;
    }

    const x = (e && e.clientX) || _lastDownX;
    const y = (e && e.clientY) || _lastDownY;
    console.log("[Sidekick] mouseup: no text selection, checking elements at (%d, %d)", x, y);

    const elAtPoint = document.elementFromPoint(x, y);
    if (elAtPoint) {
      const nearestLink = elAtPoint.closest && elAtPoint.closest("a[href]");
      if (nearestLink && !panel.contains(nearestLink) && !captureBar.contains(nearestLink)) {
        console.log("[Sidekick] mouseup: found link under pointer:", nearestLink.href);
        const info = parseVideoUrl(nearestLink.href);
        if (info) {
          console.log("[Sidekick] mouseup: link is a video URL, parsed info:", info);
          const imgEl = nearestLink.querySelector("img") ||
                        (elAtPoint.tagName === "IMG" ? elAtPoint : null);
          const thumb = info.thumb || (imgEl ? imgEl.src : null);
          console.log("[Sidekick] mouseup: thumbnail source:", thumb ? (imgEl && !info.thumb ? "link img element" : "parsed from URL") : "none");
          const item = saveCapturedData({
            type: "video", content: info.pageUrl, thumb,
            platform: info.platform, pageUrl: location.href
          });
          disableCaptureMode();
          if (item) showBarCaptured(item);
          return;
        } else {
          console.log("[Sidekick] mouseup: link is not a recognised video URL");
        }
      }
    }

    const hit = iframeAtPoint(x, y);
    if (hit && !panel.contains(hit) && !captureBar.contains(hit)) {
      console.log("[Sidekick] mouseup: iframe hit at (%d, %d), src:", x, y, hit.src);
      const item = handleEl(hit, x, y);
      disableCaptureMode();
      if (item) showBarCaptured(item);
    }
  }

  function onCaptureClick(e) {
    if (!captureArmed) return;
    if (captureBar.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (panel.contains(e.target) || arrow.contains(e.target)) return;

    console.log("[Sidekick] click: target tag=%s, id=%s, classes=%s", e.target.tagName, e.target.id, e.target.className);

    const cardWithUrl = findGoogleVideoCard(e.target);
    if (cardWithUrl) {
      const item = saveCapturedData(cardWithUrl);
      disableCaptureMode();
      if (item) showBarCaptured(item);
      return;
    }

    const nearestLink = e.target.closest && e.target.closest("a[href]");
    if (nearestLink) {
      console.log("[Sidekick] click: nearest link href:", nearestLink.href);
      const info = parseVideoUrl(nearestLink.href);
      if (info) {
        console.log("[Sidekick] click: recognised video link, platform=%s videoId=%s", info.platform, info.videoId);
        const imgEl = nearestLink.querySelector("img") ||
                      (e.target.tagName === "IMG" ? e.target : null);
        const thumb = info.thumb || (imgEl ? imgEl.src : null);
        console.log("[Sidekick] click: thumbnail:", thumb || "none");
        const item = saveCapturedData({
          type: "video",
          content: info.pageUrl,
          thumb,
          platform: info.platform,
          pageUrl: location.href
        });
        disableCaptureMode();
        if (item) showBarCaptured(item);
        return;
      } else {
        console.log("[Sidekick] click: link is not a recognised video URL, falling through");
      }
    }

    const composedPath = typeof e.composedPath === "function" ? e.composedPath() : [];
    let el = e.target;
    for (const n of composedPath) {
      if (n.tagName === "VIDEO" || n.tagName === "IMG" || n.tagName === "IFRAME") { el = n; break; }
    }
    if (el?.closest) { const v = el.closest("video"), i = el.closest("img"); if (v) el = v; else if (i) el = i; }

    if (el && (el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "IFRAME")) {
      console.log("[Sidekick] click: matched media element tag=%s", el.tagName);
      const item = handleEl(el, e.clientX, e.clientY);
      disableCaptureMode(); if (item) showBarCaptured(item);
      return;
    }

    console.log("[Sidekick] click: no media element matched, trying iframe hit-test at (%d, %d)", e.clientX, e.clientY);
    const hit = iframeAtPoint(e.clientX, e.clientY);
    if (hit) {
      console.log("[Sidekick] click: iframe hit-test matched, src:", hit.src);
      const item = handleEl(hit, e.clientX, e.clientY);
      disableCaptureMode(); if (item) showBarCaptured(item);
    } else {
      console.log("[Sidekick] click: no element matched. Ancestor chain:");
        let dbgNode = e.target;
        for (let i = 0; i < 10 && dbgNode; i++) {
          console.log("  [%d] <%s> id=%s class=%s data=%s", i, dbgNode.tagName,
            dbgNode.id, dbgNode.className,
            JSON.stringify(Object.fromEntries(
              [...(dbgNode.dataset ? Object.entries(dbgNode.dataset) : [])].slice(0, 4)
            ))
          );
          dbgNode = dbgNode.parentElement;
        }
    }
  }

  function onCaptureHover(e) {
    if (!captureArmed) return;
    if (e.target?.tagName === "VIDEO") e.preventDefault();
  }

  function unwrapRedirect(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      if (/google\./.test(u.hostname) && u.pathname === "/url") {
        const q = u.searchParams.get("q") || u.searchParams.get("url");
        if (q) return q;
      }
      if (/duckduckgo\.com/.test(u.hostname) && u.pathname === "/l/") {
        const uddg = u.searchParams.get("uddg");
        if (uddg) return decodeURIComponent(uddg);
      }
    } catch(_) {}
    return url;
  }

  function findGoogleVideoCard(el) {
    let node = el;
    for (let i = 0; i < 12 && node; i++) {
      const dataUrl = node.dataset && (node.dataset.url || node.dataset.href || node.dataset.pUrl);
      if (dataUrl) {
        console.log("[Sidekick] findGoogleVideoCard: found data-url:", dataUrl);
        const info = parseVideoUrl(dataUrl);
        if (info) {
          const thumb = findThumbInCard(node) || info.thumb;
          return { type: "video", content: info.pageUrl, thumb, platform: info.platform, pageUrl: location.href };
        }
      }
      const anchor = node.querySelector && node.querySelector("a[href*='youtube.com'], a[href*='youtu.be'], a[href*='vimeo.com'], a[href*='dailymotion.com']");
      if (anchor) {
        console.log("[Sidekick] findGoogleVideoCard: found anchor inside card:", anchor.href);
        const info = parseVideoUrl(anchor.href);
        if (info) {
          const thumb = findThumbInCard(node) || info.thumb;
          return { type: "video", content: info.pageUrl, thumb, platform: info.platform, pageUrl: location.href };
        }
      }
      if (node.tagName === "A" && node.href) {
        const info = parseVideoUrl(node.href);
        if (info) {
          const thumb = findThumbInCard(node) || info.thumb;
          return { type: "video", content: info.pageUrl, thumb, platform: info.platform, pageUrl: location.href };
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function findThumbInCard(cardEl) {
    const img = cardEl.querySelector && (
      cardEl.querySelector("img[src*='ytimg'], img[src*='youtube'], img[src*='vi/'], img[data-src]") ||
      cardEl.querySelector("img")
    );
    if (!img) return null;
    const src = img.src || img.dataset.src || "";
    if (img.naturalWidth > 0 && img.naturalWidth < 60) return null;
    console.log("[Sidekick] findThumbInCard: found img src:", src.slice(0, 80));
    return src || null;
  }

  function parseVideoUrl(url) {
    if (!url) return null;
    const unwrapped = unwrapRedirect(url);
    if (unwrapped !== url) {
      console.log("[Sidekick] parseVideoUrl: unwrapped redirect", url, "→", unwrapped);
    }
    url = unwrapped;
    try {
      const u = new URL(url);
      let m;

      if (/youtube\.com|youtube-nocookie\.com/.test(u.hostname)) {
        const id = u.searchParams.get("v") ||
                   (m = u.pathname.match(/\/(?:embed|shorts|v)\/([^/?&#]+)/)) && m[1];
        if (id) {
          console.log("[Sidekick] parseVideoUrl: matched YouTube, videoId=%s", id);
          return {
            platform: "youtube", videoId: id,
            pageUrl: `https://www.youtube.com/watch?v=${id}`,
            thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
          };
        }
      }

      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1).split(/[?&#]/)[0];
        if (id) {
          console.log("[Sidekick] parseVideoUrl: matched youtu.be, videoId=%s", id);
          return {
            platform: "youtube", videoId: id,
            pageUrl: `https://www.youtube.com/watch?v=${id}`,
            thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
          };
        }
      }

      if (/vimeo\.com/.test(u.hostname)) {
        const id = (m = u.pathname.match(/\/(?:video\/)?(\d+)/)) && m[1];
        if (id) {
          console.log("[Sidekick] parseVideoUrl: matched Vimeo, videoId=%s", id);
          return {
            platform: "vimeo", videoId: id,
            pageUrl: `https://vimeo.com/${id}`,
            thumb: null
          };
        }
      }

      if (/dailymotion\.com/.test(u.hostname)) {
        const id = (m = u.pathname.match(/\/(?:embed\/video\/|video\/)([^/?&#]+)/)) && m[1];
        if (id) {
          console.log("[Sidekick] parseVideoUrl: matched Dailymotion, videoId=%s", id);
          return {
            platform: "dailymotion", videoId: id,
            pageUrl: `https://www.dailymotion.com/video/${id}`,
            thumb: `https://www.dailymotion.com/thumbnail/video/${id}`
          };
        }
      }

      console.log("[Sidekick] parseVideoUrl: no platform matched for", url);
    } catch(_) {}
    return null;
  }

  function iframeAtPoint(x, y) {
    for (const f of document.querySelectorAll("iframe")) {
      const r = f.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        console.log("[Sidekick] iframeAtPoint: hit iframe src=%s at (%d,%d)", f.src, x, y);
        return f;
      }
    }
    return null;
  }

  function handleEl(el, clickX, clickY) {
    if (!el) return null;
    console.log("[Sidekick] handleEl: processing element tag=%s", el.tagName);

    if (el.tagName === "IMG") {
      console.log("[Sidekick] handleEl: capturing image src=%s", el.src);
      return saveCapturedData({ type: "image", content: el.src });
    }

    if (el.tagName === "VIDEO") {
      const src = el.currentSrc || el.src || "";
      console.log("[Sidekick] handleEl: capturing video src=%s, hasPoster=%s, videoWidth=%d", src, !!el.poster, el.videoWidth);
      let thumb = el.poster || null;
      if (!thumb && el.videoWidth > 0) {
        try {
          const c = document.createElement("canvas");
          c.width = el.videoWidth; c.height = el.videoHeight;
          c.getContext("2d").drawImage(el, 0, 0);
          thumb = c.toDataURL("image/jpeg", 0.8);
          console.log("[Sidekick] handleEl: canvas snapshot taken for video thumbnail");
        } catch(_) {
          console.warn("[Sidekick] handleEl: canvas snapshot failed (likely cross-origin)");
        }
      } else if (!thumb) {
        console.log("[Sidekick] handleEl: no poster and video not ready, no thumbnail");
      } else {
        console.log("[Sidekick] handleEl: using poster as thumbnail");
      }
      return saveCapturedData({ type: "video", content: src, thumb, pageUrl: location.href });
    }

    if (el.tagName === "IFRAME") {
      console.log("[Sidekick] handleEl: processing iframe src=%s", el.src);
      const info = parseVideoUrl(el.src);
      if (info) {
        console.log("[Sidekick] handleEl: iframe is a known video embed, platform=%s videoId=%s", info.platform, info.videoId);
        return saveCapturedData({
          type: "video",
          content: info.pageUrl,
          thumb: info.thumb,
          platform: info.platform,
          embedSrc: el.src,
          pageUrl: location.href
        });
      }
      console.log("[Sidekick] handleEl: iframe is not a recognised video embed, saving as iframe type");
      return saveCapturedData({ type: "iframe", content: el.src });
    }

    if (clickX !== undefined) {
      const hit = iframeAtPoint(clickX, clickY);
      if (hit) {
        console.log("[Sidekick] handleEl: fallback iframe hit at (%d,%d) src=%s", clickX, clickY, hit.src);
        const info = parseVideoUrl(hit.src);
        if (info) {
          console.log("[Sidekick] handleEl: fallback iframe is a video embed, platform=%s", info.platform);
          return saveCapturedData({
            type: "video",
            content: info.pageUrl,
            thumb: info.thumb,
            platform: info.platform,
            embedSrc: hit.src,
            pageUrl: location.href
          });
        }
        return saveCapturedData({ type: "iframe", content: hit.src });
      }
    }

    const txt = window.getSelection().toString().trim() || lastSelectedText;
    if (txt) {
      console.log("[Sidekick] handleEl: falling back to text selection, length:", txt.length);
      lastSelectedText = "";
      return saveCapturedData({ type: "text", content: txt });
    }

    console.warn("[Sidekick] handleEl: nothing captured from element or selection");
    return null;
  }

  const ICONS = {
    camera: `<svg fill="#0f172a" width="16px" height="16px" viewBox="0 0 36 36" version="1.1"  preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <title>camera-line</title>
        <path d="M32,8H24.7L23.64,5.28A2,2,0,0,0,21.78,4H14.22a2,2,0,0,0-1.87,1.28L11.3,8H4a2,2,0,0,0-2,2V30a2,2,0,0,0,2,2H32a2,2,0,0,0,2-2V10A2,2,0,0,0,32,8Zm0,22H4V10h8.67l1.55-4h7.56l1.55,4H32Z" class="clr-i-outline clr-i-outline-path-1"></path><path d="M9,19a9,9,0,1,0,9-9A9,9,0,0,0,9,19Zm16.4,0A7.4,7.4,0,1,1,18,11.6,7.41,7.41,0,0,1,25.4,19Z" class="clr-i-outline clr-i-outline-path-2"></path><path d="M9.37,12.83a.8.8,0,0,0-.8-.8H6.17a.8.8,0,0,0,0,1.6h2.4A.8.8,0,0,0,9.37,12.83Z" class="clr-i-outline clr-i-outline-path-3"></path><path d="M12.34,19a5.57,5.57,0,0,0,3.24,5l.85-1.37a4,4,0,1,1,4.11-6.61l.86-1.38A5.56,5.56,0,0,0,12.34,19Z" class="clr-i-outline clr-i-outline-path-4"></path>
        <rect x="0" y="0" width="36" height="36" fill-opacity="0"/>
    </svg>`,
    download: `<svg width="16px" height="16px" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M7 9.35801V1H8V9.29289L10.1464 7.14645L10.8536 7.85355L7.51386 11.1932L3.91086 7.8674L4.58914 7.1326L7 9.35801ZM2 13V7H1V14H14V7H13V13H2Z" fill="#000000"/>
    </svg>`,
    save: `<svg width="16px" height="16px" viewBox="0 0 17 17" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <path d="M14.164 0h-12.664c-0.827 0-1.5 0.673-1.5 1.5v14c0 0.827 0.673 1.5 1.5 1.5h14c0.827 0 1.5-0.673 1.5-1.5v-12.724l-2.836-2.776zM8 1v4h3v-4h1v5h-8v-5h4zM3 16v-6h11v6h-11zM16 15.5c0 0.275-0.225 0.5-0.5 0.5h-0.5v-7h-13v7h-0.5c-0.276 0-0.5-0.225-0.5-0.5v-14c0-0.275 0.224-0.5 0.5-0.5h1.5v6h10v-6h0.756l2.244 2.196v12.304z" fill="#000000" />
    </svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M9 4v6l-2 4v2h10v-2l-2 -4v-6"/><path d="M12 16l0 5"/><path d="M8 4l8 0"/></svg>`,
    share: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-share" viewBox="0 0 16 16"><path d="M13.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M11 2.5a2.5 2.5 0 1 1 .603 1.628l-6.718 3.12a2.5 2.5 0 0 1 0 1.504l6.718 3.12a2.5 2.5 0 1 1-.488.876l-6.718-3.12a2.5 2.5 0 1 1 0-3.256l6.718-3.12A2.5 2.5 0 0 1 11 2.5m-8.5 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m11 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3"/</svg>`,
    copy:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-copy" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z"/></svg>`,
    docx: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4"/><path d="M5 21v-6h14v6"/><text x="12" y="19.5" font-size="6" font-family="Arial, Helvetica, sans-serif" font-weight="700" stroke="none" fill="currentColor" text-anchor="middle">W</text></svg>`,    txt: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4"/><path d="M5 15h3"/><path d="M5 18h3"/><path d="M13 15h6"/><path d="M13 18h6"/></svg>`,
    search: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><circle cx="10" cy="10" r="7"/><path d="M21 21l-6 -6"/></svg>`,
    back: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M5 12l14 0"/><path d="M5 12l6 6"/><path d="M5 12l6 -6"/></svg>`,
    grid: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>`,
    tag: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7.859 6h-2.834a2.025 2.025 0 0 0 -2.025 2.025v2.834c0 .537 .213 1.052 .593 1.432l6.116 6.116a2.025 2.025 0 0 0 2.864 0l4.834 -4.834a2.025 2.025 0 0 0 0 -2.864l-6.117 -6.116a2.025 2.025 0 0 0 -1.431 -.593z"/><path d="M6 9h-.01"/></svg>`,
    grip: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`,
    notebook:`<svg width="16px" height="16px" viewBox="0 0 1024 1024" class="icon"  version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M889.4 322.1h-131c-1.4 0-2.5-1.1-2.5-2.5V169.7c0-1.4 1.1-2.5 2.5-2.5h131c13.7 0 24.8 11.1 24.8 24.8v105.4c0 13.6-11.1 24.7-24.8 24.7z" fill="#7ec4ea" /><path d="M889.4 335.1h-131c-8.6 0-15.5-7-15.5-15.5V169.7c0-8.6 7-15.5 15.5-15.5h131c20.8 0 37.8 16.9 37.8 37.8v105.4c0 20.7-17 37.7-37.8 37.7z m-120.5-26h120.5c6.5 0 11.8-5.3 11.8-11.8V191.9c0-6.5-5.3-11.8-11.8-11.8H768.9v129z" fill="#191919" /><path d="M864.2 479.6h-131c-1.4 0-2.5-1.1-2.5-2.5V327.2c0-1.4 1.1-2.5 2.5-2.5h131c13.7 0 24.8 11.1 24.8 24.8v105.4c0 13.6-11.1 24.7-24.8 24.7z" fill="#2f8fcf" /><path d="M864.2 492.6h-131c-8.6 0-15.5-7-15.5-15.5V327.2c0-8.6 7-15.5 15.5-15.5h131c20.8 0 37.8 16.9 37.8 37.8v105.4c0 20.8-17 37.7-37.8 37.7z m-120.5-26h120.5c6.5 0 11.8-5.3 11.8-11.8V349.5c0-6.5-5.3-11.8-11.8-11.8H743.7v128.9z" fill="#111111" /><path d="M864.2 628.4h-131c-1.4 0-2.5-1.1-2.5-2.5V476c0-1.4 1.1-2.5 2.5-2.5h138.2c9.7 0 17.6 7.9 17.6 17.6v112.6c0 13.6-11.1 24.7-24.8 24.7z" fill="#164971" /><path d="M864.2 641.4h-131c-8.6 0-15.5-7-15.5-15.5V476c0-8.6 7-15.5 15.5-15.5h138.2c16.9 0 30.6 13.7 30.6 30.6v112.6c0 20.7-17 37.7-37.8 37.7z m-120.5-26h120.5c6.5 0 11.8-5.3 11.8-11.8V491c0-2.5-2.1-4.6-4.6-4.6H743.7v129z" fill="#141414" /><path d="M747.7 961.1H255.5c-52.2 0-94.5-42.3-94.5-94.5V102.3c0-27.3 22.2-49.5 49.5-49.5h582.2c27.3 0 49.5 22.2 49.5 49.5v764.2c0 52.2-42.3 94.6-94.5 94.6z" fill="#7ec4ea" /><path d="M747.7 974.1H255.5c-59.3 0-107.5-48.2-107.5-107.5V102.3c0-34.5 28-62.5 62.5-62.5h582.2c34.5 0 62.5 28 62.5 62.5v764.2c0 59.3-48.2 107.6-107.5 107.6zM210.5 65.8c-20.1 0-36.5 16.4-36.5 36.5v764.2c0 45 36.6 81.5 81.5 81.5h492.1c45 0 81.5-36.6 81.5-81.5V102.3c0-20.1-16.4-36.5-36.5-36.5H210.5z" fill="#191919" /><path d="M791.4 877.5H211.8c-28.1 0-50.8-22.7-50.8-50.8V103.6c0-28.1 22.7-50.8 50.8-50.8h579.6c28.1 0 50.8 22.7 50.8 50.8v723.1c0 28.1-22.7 50.8-50.8 50.8z" fill="#FAFCFB" /><path d="M791.4 890.5H211.8c-35.2 0-63.8-28.6-63.8-63.8V103.6c0-35.2 28.6-63.8 63.8-63.8h579.6c35.2 0 63.8 28.6 63.8 63.8v723.1c0 35.2-28.6 63.8-63.8 63.8zM211.8 65.8c-20.8 0-37.8 17-37.8 37.8v723.1c0 20.8 17 37.8 37.8 37.8h579.6c20.8 0 37.8-17 37.8-37.8V103.6c0-20.8-17-37.8-37.8-37.8H211.8z" fill="#0F0F0F" /><path d="M357.8 367.2m-32.6 0a32.6 32.6 0 1 0 65.2 0 32.6 32.6 0 1 0-65.2 0Z" fill="#0F0F0F" /><path d="M652.6 367.2m-32.6 0a32.6 32.6 0 1 0 65.2 0 32.6 32.6 0 1 0-65.2 0Z" fill="#0F0F0F" /><path d="M505.2 492.6c-38.7 0-70.2-30.6-70.2-68.3v-22.1c0-7.2 5.8-13 13-13s13 5.8 13 13v22.1c0 23.3 19.8 42.3 44.2 42.3 24.4 0 44.2-19 44.2-42.3v-22.1c0-7.2 5.8-13 13-13s13 5.8 13 13v22.1c0 37.6-31.5 68.3-70.2 68.3z" fill="#0F0F0F" /><path d="M198.2 184.1h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17zM198.2 278.1h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17zM198.2 372h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17zM198.2 466h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17zM198.2 559.9h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17zM198.2 653.8h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17zM198.2 747.8h-86.4c-9.4 0-17-7.6-17-17s7.6-17 17-17h86.4c9.4 0 17 7.6 17 17s-7.6 17-17 17z" fill="#0F0F0F" /></svg>`,
  };

  function svgIcon(name, style = "") {
    const wrap = mk("span");
    wrap.innerHTML = ICONS[name] || "";
    wrap.setAttribute("aria-hidden", "true");
    if (style) wrap.style.cssText = style;
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.verticalAlign = "middle";
    return wrap;
  }

  function mk(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function iconBtn(icon, title) {
    const b = mk("button", "sk-icon-btn"); b.title = title||""; b.textContent = icon; return b;
  }
  function svgIconBtn(iconName, title) {
    const b = mk("button", "sk-icon-btn"); b.title = title||"";
    b.appendChild(svgIcon(iconName));
    return b;
  }
  function row() {
    const d = mk("div"); d.style.cssText = "display:flex;align-items:center;gap:4px;"; return d;
  }

  function finishBoot() {
    console.log("[Sidekick] Boot complete, rendering main view. Notebooks:", getData().notebooks.length, "Items:", getData().capturedItems.length);
    renderView("main");
  }

}