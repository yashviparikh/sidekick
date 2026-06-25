console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-panel")) {

  // ═══════════════════════════════════════════════════════════════
  // STORAGE — always read fresh, never cache
  // ═══════════════════════════════════════════════════════════════
  function getData() {
    try { return JSON.parse(sessionStorage.getItem("sidekick") || "null") || initData(); }
    catch { return initData(); }
  }
  function setData(d) {
    sessionStorage.setItem("sidekick", JSON.stringify(d));
  }
  function initData() {
    const nb = { id: uid(), name: "My First Notebook", createdAt: now() };
    const d = { notebooks: [nb], capturedItems: [], activeNotebookId: nb.id, recycleBin: [] };
    setData(d); return d;
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
  let panelW = 480; // resizable width

  purgeBin();

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
  `;
  document.head.appendChild(styleEl);

  // ═══════════════════════════════════════════════════════════════
  // PANEL SHELL (created once, never destroyed)
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

  // ── Resize handle: left edge (horizontal) ──
  const resizeH = document.createElement("div");
  resizeH.className = "sk-resize-h";
  panel.appendChild(resizeH);

  // ── Resize handle: bottom edge (vertical) ──
  const resizeV = document.createElement("div");
  resizeV.className = "sk-resize-v";
  panel.appendChild(resizeV);

  // ── Header slot ──
  const headerSlot = document.createElement("div");
  headerSlot.id = "sidekick-header";
  headerSlot.style.flexShrink = "0";
  panel.appendChild(headerSlot);

  // ── Body slot (scrollable) ──
  const bodySlot = document.createElement("div");
  bodySlot.id = "sidekick-body";
  Object.assign(bodySlot.style, {
    flex: "1", overflowY: "auto", overflowX: "hidden",
    padding: "14px 14px 20px",
    minHeight: "0"   // critical: flex child must have minHeight:0 to scroll
  });
  panel.appendChild(bodySlot);

  // ── Arrow toggle ──
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
  let panelH = null; // null = 100vh

  resizeH.addEventListener("mousedown", e => {
    e.preventDefault();
    resizeH.classList.add("dragging");
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = e2 => {
      const newW = Math.max(300, Math.min(900, startW + (startX - e2.clientX)));
      panelW = newW;
      panel.style.width = newW + "px";
      if (isOpen) arrow.style.right = newW + "px";
      if (!isOpen) panel.style.transform = `translateX(${newW}px)`;
    };
    const onUp = () => {
      resizeH.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  resizeV.addEventListener("mousedown", e => {
    e.preventDefault();
    resizeV.classList.add("dragging");
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const onMove = e2 => {
      const newH = Math.max(200, Math.min(window.innerHeight, startH + (e2.clientY - startY)));
      panelH = newH;
      panel.style.height = newH + "px";
      panel.style.top = (window.innerHeight - newH) + "px";
    };
    const onUp = () => {
      resizeV.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // ═══════════════════════════════════════════════════════════════
  // VIEW RENDERER — always wipes header + body slots, never whole panel
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

    // ── Header ──────────────────────────────────────────────────
    const hdr = document.createElement("div");
    hdr.className = "sk-header";

    // Row 1: name + icons
    const row1 = document.createElement("div");
    row1.className = "sk-header-row";

    const nbName = document.createElement("div");
    nbName.className = "sk-nb-name";
    nbName.title = "Click to rename";
    nbName.textContent = nb.name;
    nbName.addEventListener("click", () => inlineRename(nb, nbName));

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

    row1.append(nbName, exploreBtn, binBtn);

    // Row 2: actions
    const row2 = document.createElement("div");
    row2.className = "sk-action-row";

    const capBtn = mk("button", "sk-btn primary");
    capBtn.textContent = "＋ Capture";
    capBtn.addEventListener("click", startCapture);

    const saveBtn = mk("button", "sk-btn");
    saveBtn.textContent = "💾 Save";
    saveBtn.addEventListener("click", () => {
      saveBtn.textContent = "✓ Saved!";
      setTimeout(() => { saveBtn.textContent = "💾 Save"; }, 1400);
    });

    // Download dropdown
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

    // ── Body ────────────────────────────────────────────────────
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
  // DATA MUTATIONS — each mutates then re-renders
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
    renderView("main");  // immediate full re-render
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

  // ─── Undo / Redo ─────────────────────────────────────────────
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
      notes.forEach((n,i) => {
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
  function enableCaptureMode() {
    if (captureArmed) return; captureArmed = true;
    captureStyleEl = mk("style");
    captureStyleEl.textContent = "#sidekick-capture-bar,#sidekick-capture-bar *{cursor:default!important}*{cursor:crosshair!important}";
    document.head.appendChild(captureStyleEl);
    captureOverlay = mk("div");
    Object.assign(captureOverlay.style, { position:"fixed", top:"0", left:"0", width:"100vw", height:"100vh", background:"rgba(0,0,0,0.03)", pointerEvents:"none", zIndex:"999997" });
    document.body.appendChild(captureOverlay);
    document.addEventListener("mouseup", onCaptureMouseUp, true);
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("mouseover", onCaptureHover, true);
    document.addEventListener("keydown", onCaptureKeyDown, true);
  }

  function disableCaptureMode() {
    if (!captureArmed) return; captureArmed = false;
    if (captureStyleEl) { captureStyleEl.remove(); captureStyleEl = null; }
    if (captureOverlay) { captureOverlay.remove(); captureOverlay = null; }
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

  function onCaptureMouseUp() {
    if (!captureArmed) return;
    const txt = window.getSelection().toString().trim() || lastSelectedText;
    if (txt&&!isInsidePanel()) {
      const item = saveCapturedData({ type:"text", content:txt }); lastSelectedText = "";
      disableCaptureMode(); showBarCaptured(item);
    }
  }

  function onCaptureClick(e) {
    if (!captureArmed) return;
    if (captureBar.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (panel.contains(e.target)||arrow.contains(e.target)) return;
    const path = typeof e.composedPath==="function"?e.composedPath():[];
    let el = e.target;
    for (const n of path) { if (n.tagName==="VIDEO"||n.tagName==="IMG"||n.tagName==="IFRAME"){el=n;break;} }
    if (el?.closest) { const v=el.closest("video"),i=el.closest("img"); if(v)el=v; else if(i)el=i; }
    if (el&&(el.tagName==="IMG"||el.tagName==="VIDEO"||el.tagName==="IFRAME")) {
      const item = handleEl(el); disableCaptureMode(); if(item) showBarCaptured(item);
    }
  }

  function onCaptureHover(e) { if (!captureArmed) return; if(e.target?.tagName==="VIDEO"){e.preventDefault();e.stopImmediatePropagation();} }

  function handleEl(el) {
    if (!el) return null;
    if (el.tagName==="IMG") return saveCapturedData({ type:"image", content:el.src });
    if (el.tagName==="VIDEO") return saveCapturedData({ type:"video", content:el.currentSrc });
    if (el.tagName==="IFRAME") return saveCapturedData({ type:"iframe", content:el.src });
    const txt = window.getSelection().toString().trim()||lastSelectedText;
    if (txt) { lastSelectedText=""; return saveCapturedData({ type:"text", content:txt }); }
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
  // BOOT
  // ═══════════════════════════════════════════════════════════════
  renderView("main");
}