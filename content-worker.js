console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-panel")) {

  // ═══════════════════════════════════════════════════════════════
  // STORAGE — chrome.storage.local for cross-tab, cross-window
  // persistence within the same browser profile.
  //
  // Strategy: keep an in-memory _cache so all render code stays
  // synchronous. On boot we pull from storage once; every write
  // updates the cache AND fires an async push to storage.
  // A storage listener keeps every other tab's cache in sync.
  // ═══════════════════════════════════════════════════════════════
  const STORAGE_KEY = "sidekick_data";
  let _cache = null; // populated during boot, never null afterwards
  let _contextAlive = true; // set to false when extension is reloaded/updated

  // Guard: returns true if the extension context is still valid.
  // When an extension is reloaded/updated while a tab is open, all
  // chrome.* APIs throw "Extension context invalidated". We detect this
  // once and then stop calling chrome.* entirely for this page session.
  // The in-memory _cache continues to work for the rest of the session.
  function contextOk() {
    if (!_contextAlive) return false;
    try {
      // Cheapest possible API call — just reads a string, never throws
      // under normal circumstances.
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
    if (!contextOk()) return; // cache updated above; just skip the disk write
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

  // Keep other tabs in sync: when storage changes externally, pull
  // the new value into our cache and re-render the current view.
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

  // ── Boot sequence ─────────────────────────────────────────────
  // Everything is deferred until storage resolves. We mount a
  // temporary loading indicator while we wait.
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
    // Context already dead on load (extension reloaded before this ran) —
    // start fresh from an empty in-memory state so the UI still works.
    boot(null);
  }

  // ─────────────────────────────────────────────────────────────
  // Everything below is identical to the original except:
  //   • getData() / setData() now hit the cache above
  //   • purgeBin() / finishBoot() called from boot()
  //   • No sessionStorage references remain
  // ─────────────────────────────────────────────────────────────

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

  // ═══════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════
  const styleEl = document.createElement("style");
  styleEl.id = "sidekick-styles";
  styleEl.textContent = `
    #sidekick-panel, #sidekick-panel * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; margin: 0; }
    #sidekick-panel { scrollbar-width: thin; scrollbar-color: #d1d5db transparent; }
    #sidekick-body::-webkit-scrollbar { width: 6px; }
    #sidekick-body::-webkit-scrollbar-track { background: transparent; }
    #sidekick-body::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
    .sk-btn { padding: 6px 13px; cursor: pointer; font-size: 13px; border-radius: 6px; border: 1px solid #e2e8f0; background: #f8fafc; color: #1e293b; transition: all 0.12s; white-space: nowrap; line-height: 1.4; }
    .sk-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }
    .sk-btn.primary { background: #2563eb; color: white; border-color: #2563eb; }
    .sk-btn.primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
    .sk-btn.danger { color: #dc2626; border-color: #fca5a5; background: #fff; }
    .sk-btn.danger:hover { background: #fef2f2; }
    .sk-icon-btn { width: 28px; height: 28px; border-radius: 6px; border: none; background: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; transition: background 0.12s; flex-shrink: 0; padding: 0; }
    .sk-icon-btn:hover { background: #f1f5f9; }
    .sk-note-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: #fff; position: relative; transition: border-color 0.12s; }
    .sk-note-card:hover { border-color: #94a3b8; }
    .sk-note-card:hover .sk-note-del { opacity: 1; }
    .sk-note-del { position: absolute; top: 7px; right: 7px; opacity: 0; transition: opacity 0.12s; width: 22px; height: 22px; border-radius: 4px; border: none; background: transparent; cursor: pointer; font-size: 12px; color: #94a3b8; display: inline-flex; align-items: center; justify-content: center; }
    .sk-note-del:hover { background: #fee2e2; color: #dc2626; }
    .sk-nb-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; background: #fff; cursor: pointer; transition: border-color 0.12s, box-shadow 0.12s; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .sk-nb-card:hover { border-color: #93c5fd; box-shadow: 0 0 0 3px rgba(37,99,235,0.08); }
    .sk-nb-card.active { border-color: #2563eb; background: #eff6ff; }
    .sk-tag { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
    .sk-tag.text  { background: #dbeafe; color: #1d4ed8; }
    .sk-tag.image { background: #d1fae5; color: #065f46; }
    .sk-tag.video { background: #fce7f3; color: #9d174d; }
    .sk-tag.iframe{ background: #fef3c7; color: #92400e; }
    .sk-input { border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; font-size: 13px; width: 100%; outline: none; background: white; }
    .sk-input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.12); }
    .sk-section-lbl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; color: #94a3b8; margin-bottom: 8px; display: block; }
    .sk-empty { color: #94a3b8; font-size: 13px; text-align: center; padding: 40px 16px; line-height: 1.6; }
    .sk-bin-card { border: 1px solid #fecaca; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; background: #fff5f5; }
    .sk-bin-meta { font-size: 11px; color: #ef4444; margin-top: 3px; }
    .sk-dropdown { position: absolute; top: calc(100% + 4px); right: 0; background: white; border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); z-index: 10000; min-width: 150px; overflow: hidden; }
    .sk-dd-item { padding: 9px 14px; cursor: pointer; font-size: 13px; color: #1e293b; display: flex; align-items: center; gap: 8px; }
    .sk-dd-item:hover { background: #f1f5f9; }
    .sk-resize-h { position: absolute; left: 0; top: 0; width: 5px; height: 100%; cursor: ew-resize; z-index: 10; background: transparent; }
    .sk-resize-h:hover, .sk-resize-h.dragging { background: rgba(37,99,235,0.25); }
    .sk-resize-v { position: absolute; left: 0; bottom: 0; width: 100%; height: 5px; cursor: ns-resize; z-index: 10; background: transparent; }
    .sk-resize-v:hover, .sk-resize-v.dragging { background: rgba(37,99,235,0.25); }
    .sk-header { padding: 13px 14px 10px; border-bottom: 1px solid #e2e8f0; background: white; flex-shrink: 0; }
    .sk-header-row { display: flex; align-items: center; gap: 6px; margin-bottom: 9px; }
    .sk-action-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .sk-nb-name { font-size: 15px; font-weight: 700; color: #0f172a; flex: 1; min-width: 0; cursor: pointer; padding: 3px 5px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sk-nb-name:hover { background: #f1f5f9; }
    .sk-view-title { font-size: 15px; font-weight: 700; color: #0f172a; flex: 1; }
    .sk-sync-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; display: inline-block; margin-left: 4px; opacity: 0; transition: opacity 0.3s; }
    .sk-sync-dot.active { opacity: 1; }
  `;
  document.head.appendChild(styleEl);

  // ═══════════════════════════════════════════════════════════════
  // PANEL SHELL
  // ═══════════════════════════════════════════════════════════════
  const panel = document.createElement("div");
  panel.id = "sidekick-panel";
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0",
    height: "100vh", width: panelW + "px",
    background: "#f8fafc", color: "#0f172a",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.1)",
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
    background: "#1e293b", color: "white",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", zIndex: "999999",
    borderRadius: "6px 0 0 6px", fontSize: "11px",
    userSelect: "none"
  });
  arrow.innerHTML = "◀";

  document.body.appendChild(panel);
  document.body.appendChild(arrow);

  // ── Loading placeholder (shown while storage.get() resolves) ──
  const loadingMsg = document.createElement("div");
  loadingMsg.className = "sk-empty";
  loadingMsg.textContent = "Loading…";
  bodySlot.appendChild(loadingMsg);

  // ═══════════════════════════════════════════════════════════════
  // PANEL OPEN / CLOSE
  // ═══════════════════════════════════════════════════════════════
  let isOpen = false;
  function openPanel() {
    isOpen = true;
    panel.style.transform = "translateX(0)";
    arrow.style.right = panelW + "px";
    arrow.innerHTML = "▶";
  }
  function closePanel() {
    isOpen = false;
    panel.style.transform = `translateX(${panelW}px)`;
    arrow.style.right = "0";
    arrow.innerHTML = "◀";
  }
  arrow.addEventListener("click", () => isOpen ? closePanel() : openPanel());

  // ═══════════════════════════════════════════════════════════════
  // RESIZE LOGIC
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // VIEW RENDERER
  // ═══════════════════════════════════════════════════════════════
  function renderView(view) {
    currentView = view;
    headerSlot.innerHTML = "";
    bodySlot.innerHTML = "";
    bodySlot.scrollTop = 0;
    if (view === "main") renderMain();
    else if (view === "explore") renderExplore();
    else if (view === "bin") renderBin();
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN VIEW
  // ═══════════════════════════════════════════════════════════════
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

    // Sync indicator dot — flashes green when another tab writes
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
    capBtn.textContent = "＋ Capture";
    capBtn.addEventListener("click", startCapture);

    const saveBtn = mk("button", "sk-btn");
    saveBtn.textContent = "💾 Save";
    saveBtn.addEventListener("click", () => {
      if (!contextOk()) {
        saveBtn.textContent = "⚠ Reload tab";
        setTimeout(() => { saveBtn.textContent = "💾 Save"; }, 2000);
        return;
      }
      chrome.storage.local.set({ [STORAGE_KEY]: getData() }, () => {
        if (chrome.runtime.lastError) { console.error(chrome.runtime.lastError); return; }
        saveBtn.textContent = "✓ Saved!";
        setTimeout(() => { saveBtn.textContent = "💾 Save"; }, 1400);
      });
    });

    const dlWrap = mk("div"); dlWrap.style.position = "relative";
    const dlBtn = mk("button", "sk-btn"); dlBtn.textContent = "⬇ Download ▾";
    const dlDrop = mk("div", "sk-dropdown"); dlDrop.style.display = "none";
    [["📄 .txt", "txt"], ["📝 .doc (Word)", "docx"]].forEach(([lbl, fmt]) => {
      const it = mk("div", "sk-dd-item"); it.textContent = lbl;
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
      empty.innerHTML = "No notes yet.<br>Click <b>＋ Capture</b> to start.";
      bodySlot.appendChild(empty);
      return;
    }

    const lbl = mk("span", "sk-section-lbl");
    lbl.textContent = `${notes.length} note${notes.length !== 1 ? "s" : ""}`;
    bodySlot.appendChild(lbl);

    notes.slice().reverse().forEach(note => bodySlot.appendChild(noteCard(note, nb)));
  }

  function noteCard(note, nb) {
    const card = mk("div", "sk-note-card");

    const top = mk("div"); Object.assign(top.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", paddingRight: "24px" });
    const tag = mk("span", `sk-tag ${note.type}`); tag.textContent = note.type;
    const ts = mk("span"); Object.assign(ts.style, { fontSize: "11px", color: "#94a3b8", flex: "1" });
    ts.textContent = new Date(note.capturedAt).toLocaleString();
    top.append(tag, ts);

    const delBtn = mk("button", "sk-note-del"); delBtn.title = "Delete note"; delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => { deleteNote(note, nb); });
    card.appendChild(delBtn);

    const body = mk("div"); Object.assign(body.style, { fontSize: "13px", color: "#374151", marginBottom: "6px", lineHeight: "1.5" });
    if (note.type === "image") {
      const img = mk("img"); img.src = note.content;
      Object.assign(img.style, { maxWidth: "100%", maxHeight: "130px", borderRadius: "4px", display: "block" });
      body.appendChild(img);
    } else if (note.type === "video") {
      // Thumbnail wrapper links to the clean watch URL
      const watchUrl = note.content || note.pageUrl || "";
      const wrap = mk("a"); wrap.href = watchUrl; wrap.target = "_blank"; wrap.rel = "noopener noreferrer";
      wrap.style.cssText = "display:block;position:relative;text-decoration:none;";
      if (note.thumb) {
        const thumb = mk("img"); thumb.src = note.thumb;
        Object.assign(thumb.style, { maxWidth: "100%", maxHeight: "130px", borderRadius: "6px", display: "block", objectFit: "cover" });
        const play = mk("div");
        play.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40px;height:40px;background:rgba(0,0,0,0.65);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;pointer-events:none;";
        play.textContent = "\u25b6";
        wrap.append(thumb, play);
      } else {
        const pill = mk("div");
        pill.style.cssText = "background:#fce7f3;color:#9d174d;border-radius:6px;padding:10px 12px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;";
        const short = watchUrl.slice(0, 60) + (watchUrl.length > 60 ? "\u2026" : "");
        pill.innerHTML = `<span style="font-size:20px">\ud83c\udfa6</span><span>${esc(short)}</span>`;
        wrap.appendChild(pill);
      }
      body.appendChild(wrap);
    } else {
      body.textContent = note.content.slice(0, 180) + (note.content.length > 180 ? "…" : "");
    }

    const src = mk("a"); src.href = note.sourceUrl; src.target = "_blank"; src.rel = "noopener noreferrer";
    Object.assign(src.style, { fontSize: "11px", color: "#6b7280", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" });
    src.textContent = note.sourceUrl;
    src.onmouseover = () => src.style.textDecoration = "underline";
    src.onmouseout = () => src.style.textDecoration = "none";

    card.append(top, body, src);
    return card;
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

  // ═══════════════════════════════════════════════════════════════
  // EXPLORE VIEW
  // ═══════════════════════════════════════════════════════════════
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
      const name = mk("div"); Object.assign(name.style, { fontSize: "14px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      name.textContent = nb.name;
      const meta = mk("div"); meta.style.cssText = "font-size:11px;color:#94a3b8;margin-top:2px;";
      meta.textContent = `${cnt} note${cnt !== 1 ? "s" : ""} · ${new Date(nb.createdAt).toLocaleDateString()}`;
      info.append(name, meta);
      left.append(ico, info);

      const right = mk("div"); right.style.cssText = "display:flex;align-items:center;gap:4px;flex-shrink:0;";
      if (nb.id === d.activeNotebookId) {
        const pill = mk("span"); pill.style.cssText = "font-size:11px;color:#2563eb;font-weight:600;padding:2px 8px;background:#dbeafe;border-radius:10px;";
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

  // ═══════════════════════════════════════════════════════════════
  // BIN VIEW
  // ═══════════════════════════════════════════════════════════════
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

    const info = mk("p"); info.style.cssText = "font-size:12px;color:#94a3b8;margin-bottom:12px;";
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
    const name = mk("div"); name.style.cssText = "font-size:13px;font-weight:600;color:#374151;";
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

  // ═══════════════════════════════════════════════════════════════
  // DATA MUTATIONS
  // ═══════════════════════════════════════════════════════════════
  function saveCapturedData(payload) {
    const d = getData();
    const item = { ...payload, id: uid(), notebookId: d.activeNotebookId, sourceUrl: location.href, capturedAt: now() };
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

  // ═══════════════════════════════════════════════════════════════
  // DOWNLOAD
  // ═══════════════════════════════════════════════════════════════
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
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#222}
h1{font-size:22px;border-bottom:2px solid #2563eb;padding-bottom:8px}
.note{border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:16px}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 6px;border-radius:3px;text-transform:uppercase;margin-bottom:6px}
.text{background:#dbeafe;color:#1d4ed8}.image{background:#d1fae5;color:#065f46}
.video{background:#fce7f3;color:#9d174d}.iframe{background:#fef3c7;color:#92400e}
.meta{font-size:12px;color:#9ca3af;margin-bottom:6px}.content{font-size:14px;line-height:1.6;word-break:break-word}
img{max-width:100%;max-height:200px;border-radius:4px;display:block;margin-top:8px}a{color:#2563eb}
</style></head><body><h1>📓 ${esc(nb.name)}</h1>
<p style="color:#9ca3af;font-size:13px">Exported ${new Date().toLocaleString()} · ${notes.length} note${notes.length!==1?"s":""}</p>`;
      notes.forEach((n, i) => {
        html += `<div class="note"><span class="tag ${n.type}">${n.type}</span>
<div class="meta">#${i+1} · ${new Date(n.capturedAt).toLocaleString()}</div>
<div class="content">${n.type==="image"?`<img src="${esc(n.content)}" alt="captured image">`:esc(n.content)}</div>
<div style="margin-top:8px;font-size:11px;color:#9ca3af">Source: <a href="${esc(n.sourceUrl)}" target="_blank">${esc(n.sourceUrl)}</a></div></div>`;
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

  // ═══════════════════════════════════════════════════════════════
  // CAPTURE BAR
  // ═══════════════════════════════════════════════════════════════
  const captureBar = document.createElement("div");
  captureBar.id = "sidekick-capture-bar";
  Object.assign(captureBar.style, {
    position: "fixed", bottom: "0", left: "0", right: "0", height: "54px",
    background: "#0f172a", color: "white", display: "none",
    alignItems: "center", justifyContent: "space-between",
    padding: "0 18px", zIndex: "9999999",
    fontFamily: "system-ui,sans-serif", fontSize: "13px",
    boxShadow: "0 -2px 16px rgba(0,0,0,0.25)"
  });
  document.body.appendChild(captureBar);

  function cbBtn(txt, bg) {
    const b = mk("button");
    Object.assign(b.style, { padding: "5px 12px", cursor: "pointer", fontSize: "12px", background: bg||"#1e293b", color: "white", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "5px", marginLeft: "7px", whiteSpace: "nowrap" });
    b.textContent = txt; return b;
  }
  function cbl(html, color) {
    const s = mk("span"); s.style.color = color || "#94a3b8"; s.innerHTML = html; return s;
  }

  function showBarArmed() {
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const L = row(); L.append(cbl("🎯"), cbl(" Capture mode — click an element or select text"));
    const R = row();
    R.append(cbl("Esc to cancel", "#475569"));
    const c = cbBtn("✕ Cancel"); c.addEventListener("click", () => { disableCaptureMode(); hideBar(); }); R.appendChild(c);
    captureBar.append(L, R);
  }

  function showBarCaptured(item) {
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const colors = { text:"#3b82f6", image:"#10b981", video:"#ec4899", iframe:"#f59e0b" };
    const L = row(); L.style.gap = "8px"; L.style.overflow = "hidden";
    const tag = mk("span"); tag.style.cssText = `background:${colors[item.type]||"#64748b"};color:#fff;font-weight:700;font-size:10px;padding:2px 7px;border-radius:3px;text-transform:uppercase;flex-shrink:0;`;
    tag.textContent = item.type;
    const prev = mk("span"); Object.assign(prev.style, { color:"#cbd5e1", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"340px" });
    if (item.type==="image") {
      const th = mk("img"); Object.assign(th.style, { height:"26px", width:"26px", objectFit:"cover", borderRadius:"3px", verticalAlign:"middle", marginRight:"5px" }); th.src = item.content;
      prev.appendChild(th); prev.append(item.content.split("/").pop().slice(0,40));
    } else if (item.type==="video") { prev.textContent = "🎬 " + (item.content.split("/").pop().slice(0,55)||item.content.slice(0,55));
    } else if (item.type==="iframe") { prev.textContent = "🖼 " + item.content.slice(0,55);
    } else { prev.textContent = item.content.slice(0,80)+(item.content.length>80?"…":""); }
    L.append(tag, prev);
    const R = row();
    const u = cbBtn("↩ Undo"); u.addEventListener("click", () => { undoLastCapture(); showBarUndone(); }); R.appendChild(u);
    const m = cbBtn("＋ More","#1d4ed8"); m.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); }); R.appendChild(m);
    const d2 = cbBtn("✓ Done","#15803d"); d2.addEventListener("click", () => { hideBar(); openPanel(); }); R.appendChild(d2);
    captureBar.append(L, R);
  }

  function showBarUndone() {
    captureBar.style.display = "flex"; captureBar.innerHTML = "";
    const L = row(); L.append(cbl("↩ Note moved to Recycle Bin", "#fbbf24"));
    const R = row();
    const re = cbBtn("⟳ Redo","#6d28d9"); re.addEventListener("click", () => { const it = redoLastCapture(); if(it) showBarCaptured(it); }); R.appendChild(re);
    const m = cbBtn("＋ More","#1d4ed8"); m.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); }); R.appendChild(m);
    const c = cbBtn("✕ Done"); c.addEventListener("click", () => hideBar()); R.appendChild(c);
    captureBar.append(L, R);
  }

  function hideBar() {
    captureBar.style.display = "none"; captureBar.innerHTML = "";
    if (currentView === "main") renderView("main");
  }

  function startCapture() {
    const sel = window.getSelection().toString().trim() || lastSelectedText;
    if (sel) {
      const item = saveCapturedData({ type:"text", content:sel }); lastSelectedText = "";
      showBarCaptured(item); closePanel(); return;
    }
    closePanel(); showBarArmed(); enableCaptureMode();
  }

  // ═══════════════════════════════════════════════════════════════
  // CAPTURE MODE
  // ═══════════════════════════════════════════════════════════════
  // Track last mousedown position so iframe hit-test works even when
  // the click event is swallowed by the iframe's document.
  let _lastDownX = 0, _lastDownY = 0;
  function onCaptureMouseDown(e) {
    if (!captureArmed) return;
    _lastDownX = e.clientX;
    _lastDownY = e.clientY;
  }

  function enableCaptureMode() {
    if (captureArmed) return; captureArmed = true;
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
      const item = saveCapturedData({ type:"text", content:txt }); lastSelectedText = "";
      disableCaptureMode(); showBarCaptured(item);
      return;
    }
    // mouseup fires even when the iframe eats the click — use saved coords
    // as fallback so iframeAtPoint always has a position to work with.
    const x = (e && e.clientX) || _lastDownX;
    const y = (e && e.clientY) || _lastDownY;
    // Check for a video-link under the pointer (e.g. Google Search thumbnails)
    const elAtPoint = document.elementFromPoint(x, y);
    if (elAtPoint) {
      const nearestLink = elAtPoint.closest && elAtPoint.closest("a[href]");
      if (nearestLink && !panel.contains(nearestLink) && !captureBar.contains(nearestLink)) {
        const info = parseVideoUrl(nearestLink.href);
        if (info) {
          const imgEl = nearestLink.querySelector("img") ||
                        (elAtPoint.tagName === "IMG" ? elAtPoint : null);
          const thumb = info.thumb || (imgEl ? imgEl.src : null);
          const item = saveCapturedData({
            type: "video", content: info.pageUrl, thumb,
            platform: info.platform, pageUrl: location.href
          });
          disableCaptureMode();
          if (item) showBarCaptured(item);
          return;
        }
      }
    }
    // Fallback: iframe positional hit-test (embedded players)
    const hit = iframeAtPoint(x, y);
    if (hit && !panel.contains(hit) && !captureBar.contains(hit)) {
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

    // ── Priority 1: video link thumbnail (e.g. Google Search results,
    //   Twitter cards, Reddit previews). These are plain <a><img> combos
    //   with no iframe or <video> tag — detect by walking up to the nearest
    //   <a> and checking if its href is a known video URL.
    const nearestLink = e.target.closest && e.target.closest("a[href]");
    if (nearestLink) {
      const info = parseVideoUrl(nearestLink.href);
      if (info) {
        // Also grab the thumbnail image from inside the link if present
        const imgEl = nearestLink.querySelector("img") ||
                      (e.target.tagName === "IMG" ? e.target : null);
        const thumb = info.thumb || (imgEl ? imgEl.src : null);
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
      }
    }

    // ── Priority 2: actual <video>, <img>, <iframe> elements
    const composedPath = typeof e.composedPath === "function" ? e.composedPath() : [];
    let el = e.target;
    for (const n of composedPath) {
      if (n.tagName === "VIDEO" || n.tagName === "IMG" || n.tagName === "IFRAME") { el = n; break; }
    }
    if (el?.closest) { const v = el.closest("video"), i = el.closest("img"); if (v) el = v; else if (i) el = i; }
    if (el && (el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "IFRAME")) {
      const item = handleEl(el, e.clientX, e.clientY);
      disableCaptureMode(); if (item) showBarCaptured(item);
      return;
    }

    // ── Priority 3: iframe positional hit-test (embedded players)
    const hit = iframeAtPoint(e.clientX, e.clientY);
    if (hit) {
      const item = handleEl(hit, e.clientX, e.clientY);
      disableCaptureMode(); if (item) showBarCaptured(item);
    }
  }

  function onCaptureHover(e) {
    // Only suppress default play-on-hover; don't block propagation so
    // the element is still reachable by the click handler.
    if (!captureArmed) return;
    if (e.target?.tagName === "VIDEO") e.preventDefault();
  }

  // ── Video platform helpers ────────────────────────────────────
  // Given any URL string, return { videoId, platform, pageUrl, thumb }
  // or null if not a recognised embed/watch URL.
  function parseVideoUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      // YouTube: youtube.com/watch?v=ID  or  youtu.be/ID
      //          youtube.com/embed/ID     or  www.youtube-nocookie.com/embed/ID
      let m;
      if (/youtube\.com|youtube-nocookie\.com/.test(u.hostname)) {
        const id = u.searchParams.get("v") ||
                   (m = u.pathname.match(/\/(?:embed|shorts|v)\/([^/?&#]+)/)) && m[1];
        if (id) return {
          platform: "youtube", videoId: id,
          pageUrl: `https://www.youtube.com/watch?v=${id}`,
          thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
        };
      }
      if (u.hostname === "youtu.be") {
        const id = u.pathname.slice(1).split(/[?&#]/)[0];
        if (id) return {
          platform: "youtube", videoId: id,
          pageUrl: `https://www.youtube.com/watch?v=${id}`,
          thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg`
        };
      }
      // Vimeo: vimeo.com/ID  or  player.vimeo.com/video/ID
      if (/vimeo\.com/.test(u.hostname)) {
        const id = (m = u.pathname.match(/\/(?:video\/)?(\d+)/)) && m[1];
        if (id) return {
          platform: "vimeo", videoId: id,
          pageUrl: `https://vimeo.com/${id}`,
          // Vimeo thumbnails require API; use a reliable placeholder embed
          thumb: null
        };
      }
      // Dailymotion
      if (/dailymotion\.com/.test(u.hostname)) {
        const id = (m = u.pathname.match(/\/(?:embed\/video\/|video\/)([^/?&#]+)/)) && m[1];
        if (id) return {
          platform: "dailymotion", videoId: id,
          pageUrl: `https://www.dailymotion.com/video/${id}`,
          thumb: `https://www.dailymotion.com/thumbnail/video/${id}`
        };
      }
    } catch(_) {}
    return null;
  }

  // Find the <iframe> whose bounding rect contains the click point.
  // Needed because clicks inside an iframe's content don't bubble to
  // the parent page — e.target is always the <iframe> element itself
  // (or nothing if sandboxed), so we hit-test by position instead.
  function iframeAtPoint(x, y) {
    for (const f of document.querySelectorAll("iframe")) {
      const r = f.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return f;
    }
    return null;
  }

  function handleEl(el, clickX, clickY) {
    if (!el) return null;

    if (el.tagName === "IMG") {
      return saveCapturedData({ type: "image", content: el.src });
    }

    if (el.tagName === "VIDEO") {
      // Try to grab the poster frame first, then fall back to a canvas snapshot
      const src = el.currentSrc || el.src || "";
      let thumb = el.poster || null;
      if (!thumb && el.videoWidth > 0) {
        try {
          const c = document.createElement("canvas");
          c.width = el.videoWidth; c.height = el.videoHeight;
          c.getContext("2d").drawImage(el, 0, 0);
          thumb = c.toDataURL("image/jpeg", 0.8);
        } catch(_) { /* cross-origin canvas taint — skip */ }
      }
      return saveCapturedData({ type: "video", content: src, thumb, pageUrl: location.href });
    }

    // IFRAME — may be a known video embed
    if (el.tagName === "IFRAME") {
      const info = parseVideoUrl(el.src);
      if (info) {
        return saveCapturedData({
          type: "video",
          content: info.pageUrl,   // store the clean watch URL
          thumb: info.thumb,
          platform: info.platform,
          embedSrc: el.src,
          pageUrl: location.href
        });
      }
      // Unknown iframe — store as before
      return saveCapturedData({ type: "iframe", content: el.src });
    }

    // Fallback: check if the click landed inside any iframe on the page
    // (handles sandboxed iframes where e.target is the iframe itself
    //  but tagName check above already covers that; this catches edge
    //  cases where composedPath walk returned a non-iframe ancestor)
    if (clickX !== undefined) {
      const hit = iframeAtPoint(clickX, clickY);
      if (hit) {
        const info = parseVideoUrl(hit.src);
        if (info) {
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
    if (txt) { lastSelectedText = ""; return saveCapturedData({ type: "text", content: txt }); }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM UTILS
  // ═══════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════
  // BOOT — called once chrome.storage.local.get() resolves
  // ═══════════════════════════════════════════════════════════════
  function finishBoot() {
    renderView("main");
  }

}