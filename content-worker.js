if (!document.getElementById("sidekick-panel")) {

  const STORAGE_KEY = "sidekick_data";
  let _cache = null;
  let _contextAlive = true;

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
    const nb = { id: uid(), name: "My First Notebook", createdAt: now() };
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

  document.addEventListener("selectionchange", () => {
    const t = window.getSelection().toString().trim();
    if (t) lastSelectedText = t;
  });

  // ── PALETTE ──────────────────────────────────────────────────────────────
  // olive:        #5a6132  (dark)   #484f28  (darker)   #3d5228  (arrow)
  // butter:       #f5f0c0  (bg wash)  #ede8a8  (hover)
  // light green:  #d1ffbd  (active/highlight)  #edf5d0  (header tint)
  // text dark:    #2e2e1f
  // border:       #c8cda8  (normal)  #8a8c6a  (hover)
  // ─────────────────────────────────────────────────────────────────────────

  const styleEl = document.createElement("style");
  styleEl.id = "sidekick-styles";
  styleEl.textContent = `
    #sidekick-panel, #sidekick-panel * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; margin: 0; }
    #sidekick-panel { scrollbar-width: thin; scrollbar-color: #8fbd6a transparent; }
    #sidekick-body::-webkit-scrollbar { width: 6px; }
    #sidekick-body::-webkit-scrollbar-track { background: transparent; }
    #sidekick-body::-webkit-scrollbar-thumb { background: #8fbd6a; border-radius: 3px; }

    .sk-btn { padding: 6px 13px; cursor: pointer; font-size: 13px; border-radius: 6px; border: 1px solid #c8cda8; background: #f5f0c0; color: #2e2e1f; transition: all 0.12s; white-space: nowrap; line-height: 1.4; }
    .sk-btn:hover { background: #ede8a8; border-color: #8a8c6a; }
    .sk-btn.primary { background: #5a6132; color: #f7f5e8; border-color: #5a6132; }
    .sk-btn.primary:hover { background: #484f28; border-color: #484f28; }
    .sk-btn.danger { color: #8b2e2e; border-color: #d4a5a5; background: #fdf6f6; }
    .sk-btn.danger:hover { background: #f9eded; }

    .sk-icon-btn { width: 28px; height: 28px; border-radius: 6px; border: none; background: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; transition: background 0.12s; flex-shrink: 0; padding: 0; }
    .sk-icon-btn:hover { background: #ede8a8; }

    .sk-note-card { border: 1px solid #c8cda8; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: #fafff5; position: relative; transition: border-color 0.12s, background 0.12s; }
    .sk-note-card:hover { border-color: #8a8c6a; }
    .sk-note-card:hover .sk-note-del { opacity: 1; }
    .sk-note-card:hover .sk-note-menu-btn { opacity: 1; }
    .sk-note-card.pinned { border-color: #8fbd6a; background: #f7ffe9; }
    .sk-note-del { position: absolute; top: 7px; right: 7px; opacity: 0; transition: opacity 0.12s; width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; cursor: pointer; font-size: 12px; color: #8a8c6a; display: inline-flex; align-items: center; justify-content: center; }
    .sk-note-del:hover { background: #f4dada; color: #8b2e2e; }

    .sk-note-menu-wrap { position: absolute; top: 7px; right: 33px; }
    .sk-note-menu-btn { opacity: 0; transition: opacity 0.12s; width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; cursor: pointer; font-size: 15px; line-height: 1; color: #8a8c6a; display: inline-flex; align-items: center; justify-content: center; }
    .sk-note-menu-btn:hover { background: #ede8a8; color: #2e2e1f; }
    .sk-note-menu-btn.open { opacity: 1; background: #ede8a8; color: #2e2e1f; }

    .sk-pin-badge { display: inline-flex; align-items: center; margin-right: 2px; color: #5a6132; }
    .sk-pin-badge svg { width: 13px; height: 13px; display: block; }

    .sk-read-more { font-size: 12px; color: #5a6132; cursor: pointer; font-weight: 600; margin-top: 4px; display: inline-block; }
    .sk-read-more:hover { text-decoration: underline; }

    .sk-nb-card { border: 1px solid #c8cda8; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; background: #fafff5; cursor: pointer; transition: border-color 0.12s, box-shadow 0.12s; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .sk-nb-card:hover { border-color: #8a8c6a; box-shadow: 0 0 0 3px rgba(209,255,189,0.45); }
    .sk-nb-card.active { border-color: #5a6132; background: #d1ffbd; }

    .sk-tag { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
    .sk-tag.text  { background: #e8f5d0; color: #2e3d0a; }
    .sk-tag.image { background: #d1fae5; color: #065f46; }
    .sk-tag.video { background: #fce7f3; color: #9d174d; }
    .sk-tag.iframe{ background: #f5f0c0; color: #5c4a0a; }

    .sk-input { border: 1px solid #c8cda8; border-radius: 6px; padding: 6px 10px; font-size: 13px; width: 100%; outline: none; background: #fafff5; color: #2e2e1f; }
    .sk-input:focus { border-color: #5a6132; box-shadow: 0 0 0 2px rgba(209,255,189,0.5); }

    .sk-section-lbl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; color: #8a8c6a; margin-bottom: 8px; display: block; }
    .sk-empty { color: #8a8c6a; font-size: 13px; text-align: center; padding: 40px 16px; line-height: 1.6; }

    .sk-bin-card { border: 1px solid #d4b8a5; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; background: #fdf6f0; }
    .sk-bin-meta { font-size: 11px; color: #8b4a2e; margin-top: 3px; }

    .sk-dropdown { position: absolute; top: calc(100% + 4px); right: 0; background: #fafff5; border: 1px solid #c8cda8; border-radius: 8px; box-shadow: 0 4px 16px rgba(46,46,31,0.12); z-index: 10000; min-width: 150px; overflow: hidden; }
    .sk-dd-item { padding: 9px 14px; cursor: pointer; font-size: 13px; color: #2e2e1f; display: flex; align-items: center; gap: 8px; }
    .sk-dd-item:hover { background: #ede8a8; }
    .sk-dd-item.disabled { color: #b5b89a; cursor: default; }
    .sk-dd-item.disabled:hover { background: transparent; }

    .sk-resize-h { position: absolute; left: 0; top: 0; width: 5px; height: 100%; cursor: ew-resize; z-index: 10; background: transparent; }
    .sk-resize-h:hover, .sk-resize-h.dragging { background: rgba(90,97,50,0.3); }
    .sk-resize-v { position: absolute; left: 0; bottom: 0; width: 100%; height: 5px; cursor: ns-resize; z-index: 10; background: transparent; }
    .sk-resize-v:hover, .sk-resize-v.dragging { background: rgba(90,97,50,0.3); }

    .sk-header { padding: 13px 14px 10px; border-bottom: 1px solid #c8cda8; background: #edf5d0; flex-shrink: 0; }
    .sk-header-row { display: flex; align-items: center; gap: 6px; margin-bottom: 9px; }
    .sk-action-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

    .sk-nb-name { font-size: 15px; font-weight: 700; color: #2e2e1f; flex: 1; min-width: 0; cursor: pointer; padding: 3px 5px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sk-nb-name:hover { background: #ede8a8; }
    .sk-view-title { font-size: 15px; font-weight: 700; color: #2e2e1f; flex: 1; }

    .sk-sync-dot { width: 6px; height: 6px; border-radius: 50%; background: #5a6132; display: inline-block; margin-left: 4px; opacity: 0; transition: opacity 0.3s; }
    .sk-sync-dot.active { opacity: 1; }
  `;
  document.head.appendChild(styleEl);

  const panel = document.createElement("div");
  panel.id = "sidekick-panel";
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0",
    height: "100vh", width: panelW + "px",
    background: "#f5f0c0", color: "#2e2e1f",
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
    background: "#3d5228", color: "#d1ffbd",
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

    const exploreBtn = iconBtn("⊞", "Browse notebooks");
    exploreBtn.addEventListener("click", () => renderView("explore"));

    const binCount = (d.recycleBin || []).length;
    const binBtn = iconBtn("🗑", `Recycle bin${binCount ? " (" + binCount + ")" : ""}`);
    if (binCount) {
      binBtn.style.position = "relative";
      const dot = mk("span");
      Object.assign(dot.style, { position: "absolute", top: "3px", right: "3px", width: "7px", height: "7px", background: "#ef4444", borderRadius: "50%", display: "block" });
      binBtn.appendChild(dot);
    }
    binBtn.addEventListener("click", () => renderView("bin"));

    row1.append(nbName, syncDot, exploreBtn, binBtn);

    const row2 = document.createElement("div");
    row2.className = "sk-action-row";

    const capBtn = mk("button", "sk-btn primary");
    capBtn.innerHTML = "";
    capBtn.append(svgIcon("camera"), " Capture");
    capBtn.addEventListener("click", startCapture);

    const saveBtn = mk("button", "sk-btn");
    saveBtn.innerHTML = "";
    saveBtn.append(svgIcon("save"), " Save");
    saveBtn.addEventListener("click", () => {
      if (!contextOk()) {
        saveBtn.textContent = "⚠ Reload tab";
        setTimeout(() => { saveBtn.innerHTML = "";
        saveBtn.append(svgIcon("save"), " Save"); }, 2000);
        return;
      }
      chrome.storage.local.set({ [STORAGE_KEY]: getData() }, () => {
        if (chrome.runtime.lastError) { console.error(chrome.runtime.lastError); return; }
        saveBtn.textContent = "✓ Saved!";
        setTimeout(() => { saveBtn.innerHTML = "";
        saveBtn.append(svgIcon("save"), " Save"); }, 1400);
      });
    });

    const dlWrap = mk("div"); dlWrap.style.position = "relative";
    const dlBtn = mk("button", "sk-btn"); dlBtn.innerHTML = "";
    dlBtn.append(svgIcon("download"), " Download ▾");
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

    row2.append(capBtn, saveBtn, dlWrap);
    hdr.append(row1, row2);
    headerSlot.appendChild(hdr);

    const notes = d.capturedItems.filter(n => n.notebookId === nb.id);
    if (!notes.length) {
      const empty = mk("div", "sk-empty");
      empty.innerHTML = "No notes yet.<br>Click <b>Capture</b> to start.";
      bodySlot.appendChild(empty);
      return;
    }

    const lbl = mk("span", "sk-section-lbl");
    lbl.textContent = `${notes.length} note${notes.length !== 1 ? "s" : ""}`;
    bodySlot.appendChild(lbl);

    // Most recent first, then float pinned notes to the top (stable sort
    // preserves recency order within each group).
    const ordered = notes.slice().reverse().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    ordered.forEach(note => bodySlot.appendChild(noteCard(note, nb)));
  }

  function noteCard(note, nb) {
    const card = mk("div", "sk-note-card" + (note.pinned ? " pinned" : ""));

    const top = mk("div"); Object.assign(top.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", paddingRight: "58px" });
    if (note.pinned) {
      const pinBadge = mk("span", "sk-pin-badge"); pinBadge.title = "Pinned";
      pinBadge.appendChild(svgIcon("pin"));
      top.appendChild(pinBadge);
    }
    const tag = mk("span", `sk-tag ${note.type}`); tag.textContent = note.type;
    const ts = mk("span"); Object.assign(ts.style, { fontSize: "11px", color: "#8a8c6a", flex: "1" });
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

    const body = mk("div"); Object.assign(body.style, { fontSize: "13px", color: "#2e2e1f", marginBottom: "6px", lineHeight: "1.5" });

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
        pill.style.cssText = "background:#f5f0c0;color:#5c4a0a;border-radius:6px;padding:10px 12px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;border:1px solid #c8cda8;";
        const short = watchUrl.slice(0, 60) + (watchUrl.length > 60 ? "\u2026" : "");
        pill.innerHTML = `<span style="font-size:20px">\ud83c\udfa6</span><span>${esc(short)}</span>`;
        wrap.appendChild(pill);
      }

      body.appendChild(wrap);
    } else {
      const full = note.content || "";
      const isLong = full.length > 180;
      const textSpan = mk("span");
      textSpan.textContent = isLong ? full.slice(0, 180) + "…" : full;
      body.appendChild(textSpan);

      if (isLong) {
        const readMore = mk("span", "sk-read-more");
        readMore.textContent = "Read more";
        let expanded = false;
        readMore.addEventListener("click", () => {
          expanded = !expanded;
          textSpan.textContent = expanded ? full : full.slice(0, 180) + "…";
          readMore.textContent = expanded ? "Read less" : "Read more";
        });
        body.appendChild(mk("br"));
        body.appendChild(readMore);
      }
    }

    const src = mk("a"); src.href = note.sourceUrl; src.target = "_blank"; src.rel = "noopener noreferrer";
    Object.assign(src.style, { fontSize: "11px", color: "#8a8c6a", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" });
    src.textContent = note.sourceUrl;
    src.onmouseover = () => src.style.textDecoration = "underline";
    src.onmouseout = () => src.style.textDecoration = "none";

    card.append(top, body, src);
    return card;
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

  function renderExplore() {
    const d = getData();

    const hdr = mk("div", "sk-header");
    const row = mk("div", "sk-header-row");
    const back = iconBtn("←", "Back"); back.addEventListener("click", () => renderView("main"));
    const title = mk("div", "sk-view-title"); title.textContent = "Notebooks";
    const addBtn = mk("button", "sk-btn primary"); addBtn.textContent = "＋ New";
    addBtn.addEventListener("click", createNotebook);
    row.append(back, title, addBtn);
    hdr.appendChild(row);
    headerSlot.appendChild(hdr);

    if (!d.notebooks.length) {
      bodySlot.innerHTML = `<div class="sk-empty">No notebooks yet.</div>`;
      return;
    }

    d.notebooks.forEach(nb => {
      const cnt = d.capturedItems.filter(n => n.notebookId === nb.id).length;
      const card = mk("div", "sk-nb-card" + (nb.id === d.activeNotebookId ? " active" : ""));

      const left = mk("div"); Object.assign(left.style, { display: "flex", alignItems: "center", gap: "10px", flex: "1", minWidth: "0" });
      const ico = mk("span"); ico.textContent = "📓"; ico.style.fontSize = "18px";
      const info = mk("div"); info.style.cssText = "flex:1;min-width:0;";
      const name = mk("div"); Object.assign(name.style, { fontSize: "14px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e2e1f" });
      name.textContent = nb.name;
      const meta = mk("div"); meta.style.cssText = "font-size:11px;color:#8a8c6a;margin-top:2px;";
      meta.textContent = `${cnt} note${cnt !== 1 ? "s" : ""} · ${new Date(nb.createdAt).toLocaleDateString()}`;
      info.append(name, meta);
      left.append(ico, info);

      const right = mk("div"); right.style.cssText = "display:flex;align-items:center;gap:4px;flex-shrink:0;";
      if (nb.id === d.activeNotebookId) {
        const pill = mk("span"); pill.style.cssText = "font-size:11px;color:#484f28;font-weight:600;padding:2px 8px;background:#d1ffbd;border-radius:10px;border:1px solid #8fbd6a;";
        pill.textContent = "Active"; right.appendChild(pill);
      }
      const del = iconBtn("🗑", "Delete"); del.style.fontSize = "13px";
      del.addEventListener("click", e => { e.stopPropagation(); deleteNotebook(nb); });
      right.appendChild(del);

      card.append(left, right);
      card.addEventListener("click", () => {
        const d2 = getData(); d2.activeNotebookId = nb.id; setData(d2);
        renderView("main");
      });
      bodySlot.appendChild(card);
    });
  }

  function createNotebook() {
    const d = getData();
    const nb = { id: uid(), name: "New Notebook", createdAt: now() };
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
    const back = iconBtn("←", "Back"); back.addEventListener("click", () => renderView("main"));
    const title = mk("div", "sk-view-title"); title.textContent = "🗑 Recycle Bin";
    row.append(back, title);
    hdr.appendChild(row);
    headerSlot.appendChild(hdr);

    const bin = d.recycleBin || [];
    if (!bin.length) {
      bodySlot.innerHTML = `<div class="sk-empty">Recycle bin is empty.</div>`;
      return;
    }

    const info = mk("p"); info.style.cssText = "font-size:12px;color:#8a8c6a;margin-bottom:12px;";
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
    const name = mk("div"); name.style.cssText = "font-size:13px;font-weight:600;color:#2e2e1f;";
    const meta = mk("div"); meta.className = "sk-bin-meta";

    if (entry.type === "notebook") {
      name.textContent = "📓 " + entry.notebook.name;
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
      const newNb = { id: uid(), name: "My Notebook", createdAt: now() };
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
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#2e2e1f}
h1{font-size:22px;border-bottom:2px solid #5a6132;padding-bottom:8px}
.note{border:1px solid #c8cda8;border-radius:8px;padding:14px;margin-bottom:16px;background:#fafff5}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 6px;border-radius:3px;text-transform:uppercase;margin-bottom:6px}
.text{background:#e8f5d0;color:#2e3d0a}.image{background:#d1fae5;color:#065f46}
.video{background:#fce7f3;color:#9d174d}.iframe{background:#f5f0c0;color:#5c4a0a}
.meta{font-size:12px;color:#8a8c6a;margin-bottom:6px}.content{font-size:14px;line-height:1.6;word-break:break-word}
img{max-width:100%;max-height:200px;border-radius:4px;display:block;margin-top:8px}a{color:#5a6132}
</style></head><body><h1>📓 ${esc(nb.name)}</h1>
<p style="color:#8a8c6a;font-size:13px">Exported ${new Date().toLocaleString()} · ${notes.length} note${notes.length!==1?"s":""}</p>`;
      notes.forEach((n, i) => {
        html += `<div class="note"><span class="tag ${n.type}">${n.type}</span>
<div class="meta">#${i+1} · ${new Date(n.capturedAt).toLocaleString()}</div>
<div class="content">${n.type==="image"?`<img src="${esc(n.content)}" alt="captured image">`:esc(n.content)}</div>
<div style="margin-top:8px;font-size:11px;color:#8a8c6a">Source: <a href="${esc(n.sourceUrl)}" target="_blank">${esc(n.sourceUrl)}</a></div></div>`;
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
    background: "#2e2e1f", color: "#d1ffbd",
    boxShadow: "0 -2px 16px rgba(46,46,31,0.35)",
    display: "none",
    alignItems: "center", justifyContent: "space-between",
    padding: "0 18px", zIndex: "9999999",
    fontFamily: "system-ui,sans-serif", fontSize: "13px",
  });
  document.body.appendChild(captureBar);

  function cbBtn(txt, bg) {
    const b = mk("button");
    Object.assign(b.style, { padding: "5px 12px", cursor: "pointer", fontSize: "12px", background: bg || "#3d5228", color: "#d1ffbd", border: "1px solid rgba(209,255,189,0.2)", borderRadius: "5px", marginLeft: "7px", whiteSpace: "nowrap" });
    b.textContent = txt; return b;
  }
  function cbl(html, color) {
    const s = mk("span"); s.style.color = color || "#8fbd6a"; s.innerHTML = html; return s;
  }

  function showBarArmed() {
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const L = row();
    L.append(svgIcon("camera", "margin-right:6px"), cbl(" Capture mode — click an element or select text", "#d1ffbd"));
    const R = row();
    R.append(cbl("Esc to cancel", "#8fbd6a"));
    const c = cbBtn("✕");
    c.addEventListener("click", () => { disableCaptureMode(); hideBar(); });
    R.appendChild(c);
    captureBar.append(L, R);
  }

  function showBarCaptured(item) {
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const colors = { text:"#5a6132", image:"#4a6632", video:"#7a5a1e", iframe:"#6a5228" };
    const L = row(); L.style.gap = "8px"; L.style.overflow = "hidden";
    const tag = mk("span"); tag.style.cssText = `background:${colors[item.type]||"#5a6132"};color:#d1ffbd;font-weight:700;font-size:10px;padding:2px 7px;border-radius:3px;text-transform:uppercase;flex-shrink:0;`;
    tag.textContent = item.type;
    const prev = mk("span"); Object.assign(prev.style, { color:"#d1ffbd", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"340px" });
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
    const d2 = cbBtn("✓"); d2.addEventListener("click", () => { hideBar(); openPanel(); }); R.appendChild(d2);
    captureBar.append(L, R);
  }

  function showBarUndone() {
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const L = row(); L.append(cbl("↩ Note moved to Recycle Bin", "#f5f0c0"));
    const R = row();
    const re = cbBtn("⟳"); re.addEventListener("click", () => { const it = redoLastCapture(); if(it) showBarCaptured(it); }); R.appendChild(re);
    const m = cbBtn("＋"); m.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); }); R.appendChild(m);
    const c = cbBtn("✕"); c.addEventListener("click", () => hideBar()); R.appendChild(c);
    captureBar.append(L, R);
  }

  function hideBar() {
    captureBar.style.display = "none"; captureBar.innerHTML = "";
    if (currentView === "main") renderView("main");
  }

  function startCapture() {
    const sel = window.getSelection().toString().trim() || lastSelectedText;
    if (sel) {
      console.log("[Sidekick] startCapture: capturing selected text, length:", sel.length);
      const item = saveCapturedData({ type:"text", content:sel }); lastSelectedText = "";
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
    camera: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 0 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 0 2 -2"/><circle cx="12" cy="13" r="3"/></svg>`,
    download: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>`,
    save: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2"/><path d="M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M14 4l0 4l-6 0l0 -4"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M9 4v6l-2 4v2h10v-2l-2 -4v-6"/><path d="M12 16l0 5"/><path d="M8 4l8 0"/></svg>`,
    share: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-share" viewBox="0 0 16 16"><path d="M13.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M11 2.5a2.5 2.5 0 1 1 .603 1.628l-6.718 3.12a2.5 2.5 0 0 1 0 1.504l6.718 3.12a2.5 2.5 0 1 1-.488.876l-6.718-3.12a2.5 2.5 0 1 1 0-3.256l6.718-3.12A2.5 2.5 0 0 1 11 2.5m-8.5 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m11 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3"/</svg>`,
    copy:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-copy" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z"/></svg>`,
    docx: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4"/><path d="M5 21v-6h14v6"/><text x="12" y="19.5" font-size="6" font-family="Arial, Helvetica, sans-serif" font-weight="700" stroke="none" fill="currentColor" text-anchor="middle">W</text></svg>`,    txt: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4"/><path d="M5 15h3"/><path d="M5 18h3"/><path d="M13 15h6"/><path d="M13 18h6"/></svg>`,
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
  function row() {
    const d = mk("div"); d.style.cssText = "display:flex;align-items:center;gap:4px;"; return d;
  }

  function finishBoot() {
    console.log("[Sidekick] Boot complete, rendering main view. Notebooks:", getData().notebooks.length, "Items:", getData().capturedItems.length);
    renderView("main");
  }

}