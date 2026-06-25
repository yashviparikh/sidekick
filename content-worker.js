console.log("Sidekick content script loaded");

if (!document.getElementById("sidekick-panel")) {

  // ═══════════════════════════════════════════════════════════════
  // STORAGE HELPERS
  // ═══════════════════════════════════════════════════════════════
  function getData() {
    try {
      return JSON.parse(sessionStorage.getItem("sidekick") || "null") || initData();
    } catch { return initData(); }
  }
  function setData(d) { sessionStorage.setItem("sidekick", JSON.stringify(d)); }
  function initData() {
    const nb = { id: uid(), name: "My First Notebook", createdAt: now() };
    const d = { notebooks: [nb], capturedItems: [], activeNotebookId: nb.id, recycleBin: [] };
    setData(d); return d;
  }
  function uid() { return "id_" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function now() { return new Date().toISOString(); }

  // Purge bin items older than 30 days on load
  function purgeBin(d) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    d.recycleBin = (d.recycleBin || []).filter(e => new Date(e.deletedAt).getTime() > cutoff);
    setData(d);
  }

  let undoStack = [];
  let lastSelectedText = "";
  let captureArmed = false;
  let captureOverlay = null;
  let captureStyleEl = null;

  const data = getData();
  purgeBin(data);

  document.addEventListener("selectionchange", () => {
    const text = window.getSelection().toString().trim();
    if (text) lastSelectedText = text;
  });

  // ═══════════════════════════════════════════════════════════════
  // CSS INJECTION
  // ═══════════════════════════════════════════════════════════════
  const style = document.createElement("style");
  style.textContent = `
    #sidekick-panel * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    #sidekick-panel { scrollbar-width: thin; scrollbar-color: #ddd transparent; }
    .sk-btn {
      padding: 6px 13px; cursor: pointer; font-size: 13px; border-radius: 5px;
      border: 1px solid #ddd; background: #f5f5f5; color: #222;
      transition: background 0.15s; white-space: nowrap;
    }
    .sk-btn:hover { background: #e8e8e8; }
    .sk-btn.primary { background: #2563eb; color: white; border-color: #2563eb; }
    .sk-btn.primary:hover { background: #1d4ed8; }
    .sk-btn.danger { background: #fff; color: #dc2626; border-color: #dc2626; }
    .sk-btn.danger:hover { background: #fef2f2; }
    .sk-btn.ghost { background: transparent; border-color: transparent; color: #555; }
    .sk-btn.ghost:hover { background: #f0f0f0; }
    .sk-icon-btn {
      width: 30px; height: 30px; border-radius: 6px; border: none;
      background: transparent; cursor: pointer; display: flex;
      align-items: center; justify-content: center; font-size: 16px;
      transition: background 0.15s; flex-shrink: 0;
    }
    .sk-icon-btn:hover { background: #f0f0f0; }
    .sk-note-card {
      border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px;
      margin-bottom: 8px; background: #fff; position: relative;
    }
    .sk-note-card:hover .sk-note-delete { opacity: 1; }
    .sk-note-delete {
      position: absolute; top: 6px; right: 6px; opacity: 0;
      transition: opacity 0.15s; width: 24px; height: 24px;
      border-radius: 4px; border: none; background: transparent;
      cursor: pointer; font-size: 14px; color: #999; display: flex;
      align-items: center; justify-content: center;
    }
    .sk-note-delete:hover { background: #fee2e2; color: #dc2626; }
    .sk-nb-card {
      border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px;
      margin-bottom: 8px; background: #fff; cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s;
      display: flex; align-items: center; justify-content: space-between;
    }
    .sk-nb-card:hover { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.1); }
    .sk-nb-card.active { border-color: #2563eb; background: #eff6ff; }
    .sk-badge {
      font-size: 11px; background: #e5e7eb; color: #555;
      padding: 2px 7px; border-radius: 10px; font-weight: 600;
    }
    .sk-tag {
      font-size: 10px; font-weight: 700; padding: 2px 6px;
      border-radius: 3px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .sk-tag.text { background: #dbeafe; color: #1d4ed8; }
    .sk-tag.image { background: #d1fae5; color: #065f46; }
    .sk-tag.video { background: #fce7f3; color: #9d174d; }
    .sk-tag.iframe { background: #fef3c7; color: #92400e; }
    .sk-input {
      border: 1px solid #ddd; border-radius: 6px; padding: 7px 10px;
      font-size: 13px; width: 100%; outline: none;
    }
    .sk-input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.15); }
    .sk-divider { height: 1px; background: #f0f0f0; margin: 8px 0; }
    .sk-dropdown {
      position: absolute; top: 100%; right: 0; margin-top: 4px;
      background: white; border: 1px solid #e5e7eb; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12); z-index: 10; min-width: 140px; overflow: hidden;
    }
    .sk-dropdown-item {
      padding: 9px 14px; cursor: pointer; font-size: 13px; color: #222;
      display: flex; align-items: center; gap: 8px;
    }
    .sk-dropdown-item:hover { background: #f5f7ff; }
    .sk-empty { color: #9ca3af; font-size: 13px; text-align: center; padding: 32px 0; }
    .sk-section-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.8px; color: #9ca3af; margin-bottom: 10px;
    }
    .sk-bin-card {
      border: 1px solid #fecaca; border-radius: 8px; padding: 12px 14px;
      margin-bottom: 8px; background: #fff5f5;
    }
    .sk-bin-meta { font-size: 11px; color: #ef4444; margin-top: 4px; }
  `;
  document.head.appendChild(style);

  // ═══════════════════════════════════════════════════════════════
  // PANEL SHELL
  // ═══════════════════════════════════════════════════════════════
  const panel = document.createElement("div");
  panel.id = "sidekick-panel";
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0",
    height: "100vh", width: "480px",
    background: "#fafafa", color: "#111",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
    transform: "translateX(480px)",
    transition: "transform 0.3s ease",
    zIndex: "999998", display: "flex", flexDirection: "column",
    overflow: "hidden"
  });

  const arrow = document.createElement("div");
  arrow.id = "sidekick-arrow";
  Object.assign(arrow.style, {
    position: "fixed", top: "50%", right: "0",
    transform: "translateY(-50%)",
    width: "20px", height: "60px",
    background: "#1e293b", color: "white",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", zIndex: "999999", borderRadius: "6px 0 0 6px",
    fontSize: "12px"
  });
  arrow.innerHTML = "◀";

  let isOpen = false;
  function openPanel() {
    isOpen = true;
    panel.style.transform = "translateX(0)";
    arrow.style.right = "480px";
    arrow.innerHTML = "▶";
  }
  function closePanel() {
    isOpen = false;
    panel.style.transform = "translateX(480px)";
    arrow.style.right = "0";
    arrow.innerHTML = "◀";
  }
  arrow.addEventListener("click", () => isOpen ? closePanel() : openPanel());
  document.body.appendChild(panel);
  document.body.appendChild(arrow);

  // ═══════════════════════════════════════════════════════════════
  // VIEW ROUTER — renders one of: "main" | "explore" | "bin"
  // ═══════════════════════════════════════════════════════════════
  let currentView = "main";
  function renderView(view) {
    currentView = view;
    panel.innerHTML = "";
    if (view === "main") renderMain();
    else if (view === "explore") renderExplore();
    else if (view === "bin") renderBin();
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN VIEW
  // ═══════════════════════════════════════════════════════════════
  function renderMain() {
    const d = getData();
    const nb = d.notebooks.find(n => n.id === d.activeNotebookId) || d.notebooks[0];
    if (!nb) { renderExplore(); return; }

    // ── Header ──────────────────────────────────────────────────
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "14px 16px 10px", borderBottom: "1px solid #e5e7eb",
      background: "white", flexShrink: "0"
    });

    // Top row: notebook name + icons
    const topRow = document.createElement("div");
    Object.assign(topRow.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" });

    const nbName = document.createElement("div");
    nbName.style.cssText = "font-size: 15px; font-weight: 700; color: #111; flex: 1; cursor: pointer; padding: 3px 6px; border-radius: 4px;";
    nbName.title = "Click to rename";
    nbName.textContent = nb.name;
    nbName.addEventListener("click", () => startRenameNotebook(nb, nbName, d));

    const binCount = (d.recycleBin || []).length;
    const binBadge = binCount > 0 ? ` (${binCount})` : "";

    const exploreBtn = makeIconBtn("⊞", "Browse notebooks");
    exploreBtn.addEventListener("click", () => renderView("explore"));

    const binBtn = makeIconBtn("🗑", "Recycle bin" + binBadge);
    if (binCount > 0) {
      const dot = document.createElement("span");
      Object.assign(dot.style, {
        position: "absolute", top: "3px", right: "3px",
        width: "8px", height: "8px", background: "#ef4444",
        borderRadius: "50%", display: "block"
      });
      binBtn.style.position = "relative";
      binBtn.appendChild(dot);
    }
    binBtn.addEventListener("click", () => renderView("bin"));

    topRow.appendChild(nbName);
    topRow.appendChild(exploreBtn);
    topRow.appendChild(binBtn);

    // Action row: Capture + Save + Download
    const actionRow = document.createElement("div");
    Object.assign(actionRow.style, { display: "flex", gap: "6px", alignItems: "center" });

    const captureBtn = document.createElement("button");
    captureBtn.className = "sk-btn primary";
    captureBtn.textContent = "＋ Capture";
    captureBtn.addEventListener("click", () => {
      const sel = window.getSelection().toString().trim() || lastSelectedText;
      if (sel) {
        const item = saveCapturedData({ type: "text", content: sel });
        lastSelectedText = "";
        showBarCaptured(item);
        closePanel();
        return;
      }
      closePanel();
      showBarArmed();
      enableCaptureMode();
    });

    const saveBtn = document.createElement("button");
    saveBtn.className = "sk-btn";
    saveBtn.textContent = "💾 Save";
    saveBtn.title = "Save notebook name";
    saveBtn.addEventListener("click", () => {
      // name is saved inline on rename; this gives visual confirmation
      saveBtn.textContent = "✓ Saved";
      setTimeout(() => { saveBtn.textContent = "💾 Save"; }, 1200);
    });

    // Download dropdown
    const dlWrap = document.createElement("div");
    dlWrap.style.position = "relative";
    const dlBtn = document.createElement("button");
    dlBtn.className = "sk-btn";
    dlBtn.textContent = "⬇ Download ▾";
    let dlOpen = false;
    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dlOpen = !dlOpen;
      dlDropdown.style.display = dlOpen ? "block" : "none";
    });
    document.addEventListener("click", () => { dlOpen = false; dlDropdown.style.display = "none"; });

    const dlDropdown = document.createElement("div");
    dlDropdown.className = "sk-dropdown";
    dlDropdown.style.display = "none";
    [["📄 Download .txt", "txt"], ["📝 Download .docx", "docx"]].forEach(([label, fmt]) => {
      const item = document.createElement("div");
      item.className = "sk-dropdown-item";
      item.textContent = label;
      item.addEventListener("click", () => { downloadNotebook(nb, fmt); dlDropdown.style.display = "none"; });
      dlDropdown.appendChild(item);
    });
    dlWrap.appendChild(dlBtn);
    dlWrap.appendChild(dlDropdown);

    actionRow.appendChild(captureBtn);
    actionRow.appendChild(saveBtn);
    actionRow.appendChild(dlWrap);

    header.appendChild(topRow);
    header.appendChild(actionRow);

    // ── Notes list ───────────────────────────────────────────────
    const body = document.createElement("div");
    Object.assign(body.style, { flex: "1", overflowY: "auto", padding: "14px 16px" });

    const notes = d.capturedItems.filter(n => n.notebookId === nb.id);

    if (!notes.length) {
      const empty = document.createElement("div");
      empty.className = "sk-empty";
      empty.innerHTML = "No notes yet.<br>Click <b>＋ Capture</b> to start.";
      body.appendChild(empty);
    } else {
      const secTitle = document.createElement("div");
      secTitle.className = "sk-section-title";
      secTitle.textContent = `${notes.length} note${notes.length !== 1 ? "s" : ""}`;
      body.appendChild(secTitle);

      for (const note of notes.slice().reverse()) {
        body.appendChild(makeNoteCard(note, nb));
      }
    }

    panel.appendChild(header);
    panel.appendChild(body);
  }

  function makeNoteCard(note, nb) {
    const card = document.createElement("div");
    card.className = "sk-note-card";

    const topRow = document.createElement("div");
    Object.assign(topRow.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" });

    const tag = document.createElement("span");
    tag.className = `sk-tag ${note.type}`;
    tag.textContent = note.type;

    const ts = document.createElement("span");
    ts.style.cssText = "font-size: 11px; color: #9ca3af; flex: 1;";
    ts.textContent = new Date(note.capturedAt).toLocaleString();
    topRow.appendChild(tag);
    topRow.appendChild(ts);

    const delBtn = document.createElement("button");
    delBtn.className = "sk-note-delete";
    delBtn.title = "Delete note";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => deleteNote(note, nb));
    topRow.appendChild(delBtn);

    const content = document.createElement("div");
    content.style.cssText = "font-size: 13px; color: #374151; margin-bottom: 6px;";

    if (note.type === "image") {
      const img = document.createElement("img");
      img.src = note.content;
      img.style.cssText = "max-width: 100%; max-height: 120px; border-radius: 4px; display: block;";
      content.appendChild(img);
    } else {
      content.textContent = note.content.slice(0, 160) + (note.content.length > 160 ? "…" : "");
    }

    const src = document.createElement("a");
    src.href = note.sourceUrl;
    src.target = "_blank";
    src.rel = "noopener noreferrer";
    src.style.cssText = "font-size: 11px; color: #6b7280; text-decoration: none; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    src.textContent = note.sourceUrl;
    src.addEventListener("mouseover", () => src.style.textDecoration = "underline");
    src.addEventListener("mouseout", () => src.style.textDecoration = "none");

    card.appendChild(topRow);
    card.appendChild(content);
    card.appendChild(src);
    return card;
  }

  function startRenameNotebook(nb, el, d) {
    const input = document.createElement("input");
    input.className = "sk-input";
    input.value = nb.name;
    input.style.cssText = "font-size: 15px; font-weight: 700; flex: 1;";
    el.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const val = input.value.trim() || nb.name;
      const d2 = getData();
      const target = d2.notebooks.find(n => n.id === nb.id);
      if (target) { target.name = val; setData(d2); }
      renderMain();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") renderMain(); });
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPLORE VIEW
  // ═══════════════════════════════════════════════════════════════
  function renderExplore() {
    const d = getData();
    panel.innerHTML = "";

    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "14px 16px 10px", borderBottom: "1px solid #e5e7eb",
      background: "white", flexShrink: "0", display: "flex", alignItems: "center", gap: "8px"
    });

    const backBtn = makeIconBtn("←", "Back");
    backBtn.addEventListener("click", () => renderView("main"));

    const title = document.createElement("div");
    title.style.cssText = "font-size: 15px; font-weight: 700; flex: 1;";
    title.textContent = "Notebooks";

    const addBtn = document.createElement("button");
    addBtn.className = "sk-btn primary";
    addBtn.textContent = "＋ New Notebook";
    addBtn.addEventListener("click", () => createNewNotebook());

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(addBtn);

    const body = document.createElement("div");
    Object.assign(body.style, { flex: "1", overflowY: "auto", padding: "14px 16px" });

    if (!d.notebooks.length) {
      const empty = document.createElement("div");
      empty.className = "sk-empty";
      empty.textContent = "No notebooks yet. Create one!";
      body.appendChild(empty);
    } else {
      d.notebooks.forEach(nb => {
        const noteCount = d.capturedItems.filter(n => n.notebookId === nb.id).length;
        const card = document.createElement("div");
        card.className = "sk-nb-card" + (nb.id === d.activeNotebookId ? " active" : "");

        const left = document.createElement("div");
        left.style.cssText = "display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;";

        const icon = document.createElement("span");
        icon.style.fontSize = "20px";
        icon.textContent = "📓";

        const info = document.createElement("div");
        info.style.cssText = "flex: 1; min-width: 0;";

        const name = document.createElement("div");
        name.style.cssText = "font-size: 14px; font-weight: 600; color: #111; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
        name.textContent = nb.name;

        const meta = document.createElement("div");
        meta.style.cssText = "font-size: 11px; color: #9ca3af; margin-top: 2px;";
        meta.textContent = `${noteCount} note${noteCount !== 1 ? "s" : ""} · Created ${new Date(nb.createdAt).toLocaleDateString()}`;

        info.appendChild(name);
        info.appendChild(meta);
        left.appendChild(icon);
        left.appendChild(info);

        const right = document.createElement("div");
        right.style.cssText = "display: flex; align-items: center; gap: 4px; flex-shrink: 0;";

        if (nb.id === d.activeNotebookId) {
          const activePill = document.createElement("span");
          activePill.style.cssText = "font-size: 11px; color: #2563eb; font-weight: 600; padding: 2px 8px; background: #dbeafe; border-radius: 10px;";
          activePill.textContent = "Active";
          right.appendChild(activePill);
        }

        const delBtn = document.createElement("button");
        delBtn.className = "sk-icon-btn";
        delBtn.title = "Delete notebook";
        delBtn.textContent = "🗑";
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteNotebook(nb); });
        right.appendChild(delBtn);

        card.appendChild(left);
        card.appendChild(right);
        card.addEventListener("click", () => {
          const d2 = getData();
          d2.activeNotebookId = nb.id;
          setData(d2);
          renderView("main");
        });

        body.appendChild(card);
      });
    }

    panel.appendChild(header);
    panel.appendChild(body);
  }

  function createNewNotebook() {
    const d = getData();
    const nb = { id: uid(), name: "New Notebook", createdAt: now() };
    d.notebooks.push(nb);
    d.activeNotebookId = nb.id;
    setData(d);
    renderView("main");
    // immediately enter rename mode
    setTimeout(() => {
      const nameEl = panel.querySelector("[title='Click to rename']");
      if (nameEl) nameEl.click();
    }, 50);
  }

  // ═══════════════════════════════════════════════════════════════
  // BIN VIEW
  // ═══════════════════════════════════════════════════════════════
  function renderBin() {
    const d = getData();
    panel.innerHTML = "";

    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "14px 16px 10px", borderBottom: "1px solid #e5e7eb",
      background: "white", flexShrink: "0", display: "flex", alignItems: "center", gap: "8px"
    });

    const backBtn = makeIconBtn("←", "Back");
    backBtn.addEventListener("click", () => renderView("main"));

    const title = document.createElement("div");
    title.style.cssText = "font-size: 15px; font-weight: 700; flex: 1;";
    title.textContent = "🗑 Recycle Bin";

    header.appendChild(backBtn);
    header.appendChild(title);

    const body = document.createElement("div");
    Object.assign(body.style, { flex: "1", overflowY: "auto", padding: "14px 16px" });

    const bin = d.recycleBin || [];
    if (!bin.length) {
      const empty = document.createElement("div");
      empty.className = "sk-empty";
      empty.textContent = "Recycle bin is empty.";
      body.appendChild(empty);
    } else {
      const info = document.createElement("div");
      info.style.cssText = "font-size: 12px; color: #9ca3af; margin-bottom: 12px;";
      info.textContent = "Items are permanently deleted after 30 days.";
      body.appendChild(info);

      const notebooks = bin.filter(e => e.type === "notebook");
      const notes = bin.filter(e => e.type === "note");

      if (notebooks.length) {
        const sec = document.createElement("div");
        sec.className = "sk-section-title";
        sec.textContent = "Deleted Notebooks";
        body.appendChild(sec);
        notebooks.forEach(entry => body.appendChild(makeBinCard(entry, d)));
      }
      if (notes.length) {
        const sec = document.createElement("div");
        sec.className = "sk-section-title";
        sec.style.marginTop = notebooks.length ? "14px" : "0";
        sec.textContent = "Deleted Notes";
        body.appendChild(sec);
        notes.forEach(entry => body.appendChild(makeBinCard(entry, d)));
      }
    }

    panel.appendChild(header);
    panel.appendChild(body);
  }

  function makeBinCard(entry, d) {
    const card = document.createElement("div");
    card.className = "sk-bin-card";

    const topRow = document.createElement("div");
    Object.assign(topRow.style, { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" });

    const info = document.createElement("div");
    info.style.flex = "1";

    const name = document.createElement("div");
    name.style.cssText = "font-size: 13px; font-weight: 600; color: #374151;";

    if (entry.type === "notebook") {
      name.textContent = "📓 " + entry.notebook.name;
      const cnt = (entry.notes || []).length;
      const meta = document.createElement("div");
      meta.className = "sk-bin-meta";
      meta.textContent = `${cnt} note${cnt !== 1 ? "s" : ""} · `;
      meta.appendChild(daysLeft(entry.deletedAt));
      info.appendChild(name);
      info.appendChild(meta);
    } else {
      const note = entry.note;
      const tag = document.createElement("span");
      tag.className = `sk-tag ${note.type}`;
      tag.style.marginRight = "6px";
      tag.textContent = note.type;
      name.prepend(tag);
      name.append(note.content ? note.content.slice(0, 60) + (note.content.length > 60 ? "…" : "") : "(media)");
      const meta = document.createElement("div");
      meta.className = "sk-bin-meta";

      const origNb = d.notebooks.find(n => n.id === entry.originalNotebookId);
      meta.textContent = `From: ${origNb ? origNb.name : "deleted notebook"} · `;
      meta.appendChild(daysLeft(entry.deletedAt));
      info.appendChild(name);
      info.appendChild(meta);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 6px; flex-shrink: 0;";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "sk-btn";
    restoreBtn.style.fontSize = "12px";
    restoreBtn.textContent = "↩ Restore";
    restoreBtn.addEventListener("click", () => restoreBinEntry(entry));

    const permDelBtn = document.createElement("button");
    permDelBtn.className = "sk-btn danger";
    permDelBtn.style.fontSize = "12px";
    permDelBtn.textContent = "✕ Delete";
    permDelBtn.addEventListener("click", () => permanentDelete(entry));

    btnRow.appendChild(restoreBtn);
    btnRow.appendChild(permDelBtn);
    topRow.appendChild(info);
    topRow.appendChild(btnRow);
    card.appendChild(topRow);
    return card;
  }

  function daysLeft(deletedAt) {
    const span = document.createElement("span");
    const ms = 30 * 24 * 60 * 60 * 1000 - (Date.now() - new Date(deletedAt).getTime());
    const days = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    span.textContent = `${days} day${days !== 1 ? "s" : ""} remaining`;
    return span;
  }

  // ═══════════════════════════════════════════════════════════════
  // DATA MUTATIONS
  // ═══════════════════════════════════════════════════════════════
  function saveCapturedData(data_) {
    const d = getData();
    const enriched = {
      ...data_,
      id: uid(),
      notebookId: d.activeNotebookId,
      sourceUrl: location.href,
      capturedAt: now()
    };
    d.capturedItems.push(enriched);
    setData(d);
    undoStack = [];
    if (currentView === "main") renderMain();
    return enriched;
  }

  function deleteNote(note, nb) {
    const d = getData();
    d.capturedItems = d.capturedItems.filter(n => n.id !== note.id);
    d.recycleBin = d.recycleBin || [];
    d.recycleBin.push({ id: uid(), type: "note", note, originalNotebookId: nb.id, deletedAt: now() });
    setData(d);
    renderMain();
  }

  function deleteNotebook(nb) {
    const confirmed = confirm(
      `Delete "${nb.name}"?\n\nThis notebook and all its notes will be moved to the Recycle Bin. They'll be permanently deleted after 30 days unless restored.`
    );
    if (!confirmed) return;
    const d = getData();
    const notes = d.capturedItems.filter(n => n.notebookId === nb.id);
    d.capturedItems = d.capturedItems.filter(n => n.notebookId !== nb.id);
    d.notebooks = d.notebooks.filter(n => n.id !== nb.id);
    d.recycleBin = d.recycleBin || [];
    d.recycleBin.push({ id: uid(), type: "notebook", notebook: nb, notes, deletedAt: now() });
    // Switch active notebook
    if (d.activeNotebookId === nb.id) {
      d.activeNotebookId = d.notebooks[0]?.id || null;
    }
    // Create default if no notebooks left
    if (!d.notebooks.length) {
      const newNb = { id: uid(), name: "My Notebook", createdAt: now() };
      d.notebooks.push(newNb);
      d.activeNotebookId = newNb.id;
    }
    setData(d);
    renderView("explore");
  }

  function restoreBinEntry(entry) {
    const d = getData();
    d.recycleBin = (d.recycleBin || []).filter(e => e.id !== entry.id);
    if (entry.type === "notebook") {
      d.notebooks.push(entry.notebook);
      d.capturedItems.push(...(entry.notes || []));
      d.activeNotebookId = entry.notebook.id;
    } else {
      const note = entry.note;
      const targetNb = d.notebooks.find(n => n.id === entry.originalNotebookId);
      if (!targetNb) {
        note.notebookId = d.activeNotebookId;
      }
      d.capturedItems.push(note);
    }
    setData(d);
    renderBin();
  }

  function permanentDelete(entry) {
    const confirmed = confirm("Permanently delete this item? This cannot be undone.");
    if (!confirmed) return;
    const d = getData();
    d.recycleBin = (d.recycleBin || []).filter(e => e.id !== entry.id);
    setData(d);
    renderBin();
  }

  // ═══════════════════════════════════════════════════════════════
  // DOWNLOAD
  // ═══════════════════════════════════════════════════════════════
  function downloadNotebook(nb, fmt) {
    const d = getData();
    const notes = d.capturedItems.filter(n => n.notebookId === nb.id);
    if (fmt === "txt") {
      let txt = `${nb.name}\nExported: ${new Date().toLocaleString()}\n${"=".repeat(50)}\n\n`;
      notes.forEach((n, i) => {
        txt += `[${i + 1}] ${n.type.toUpperCase()} — ${new Date(n.capturedAt).toLocaleString()}\n`;
        txt += `${n.content}\nSource: ${n.sourceUrl}\n\n`;
      });
      const blob = new Blob([txt], { type: "text/plain" });
      triggerDownload(blob, `${nb.name}.txt`);
    } else if (fmt === "docx") {
      // Build minimal docx in-browser (pure JS, no library needed)
      // We use a data URI approach via the Office Open XML format embedded as a zip
      // Since we can't run node here, we fall back to an HTML file the user can save-as
      let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escHtml(nb.name)}</title>
<style>body{font-family:Arial,sans-serif;max-width:720px;margin:40px auto;color:#222;}
h1{font-size:22px;border-bottom:2px solid #2563eb;padding-bottom:8px;}
.note{border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:16px;}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;text-transform:uppercase;margin-bottom:8px;}
.text{background:#dbeafe;color:#1d4ed8;}.image{background:#d1fae5;color:#065f46;}
.video{background:#fce7f3;color:#9d174d;}.iframe{background:#fef3c7;color:#92400e;}
.meta{font-size:12px;color:#9ca3af;margin-bottom:6px;}
.content{font-size:14px;line-height:1.6;word-break:break-word;}
img{max-width:100%;max-height:200px;border-radius:4px;display:block;margin-top:8px;}
a{color:#2563eb;}
</style></head><body>
<h1>📓 ${escHtml(nb.name)}</h1>
<p style="color:#9ca3af;font-size:13px;">Exported ${new Date().toLocaleString()} · ${notes.length} note${notes.length !== 1 ? "s" : ""}</p>
`;
      notes.forEach((n, i) => {
        html += `<div class="note">
<span class="tag ${n.type}">${n.type}</span>
<div class="meta">#${i + 1} · ${new Date(n.capturedAt).toLocaleString()}</div>
<div class="content">`;
        if (n.type === "image") html += `<img src="${escHtml(n.content)}" alt="captured image">`;
        else html += escHtml(n.content);
        html += `</div>
<div style="margin-top:8px;font-size:11px;color:#9ca3af;">Source: <a href="${escHtml(n.sourceUrl)}" target="_blank">${escHtml(n.sourceUrl)}</a></div>
</div>`;
      });
      html += "</body></html>";
      const blob = new Blob([html], { type: "application/vnd.ms-word" });
      triggerDownload(blob, `${nb.name}.doc`);
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function escHtml(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ═══════════════════════════════════════════════════════════════
  // CAPTURE BAR
  // ═══════════════════════════════════════════════════════════════
  const captureBar = document.createElement("div");
  captureBar.id = "sidekick-capture-bar";
  Object.assign(captureBar.style, {
    position: "fixed", bottom: "0", left: "0", right: "0",
    height: "56px", background: "#1e293b", color: "white",
    display: "none", alignItems: "center", justifyContent: "space-between",
    padding: "0 20px", zIndex: "9999999",
    fontFamily: "system-ui, sans-serif", fontSize: "14px",
    boxShadow: "0 -2px 12px rgba(0,0,0,0.3)"
  });
  document.body.appendChild(captureBar);

  function cbBtn(label, bg, color) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      padding: "6px 13px", cursor: "pointer", fontSize: "13px",
      background: bg || "#334155", color: color || "white",
      border: "1px solid rgba(255,255,255,0.15)", borderRadius: "5px",
      marginLeft: "8px", whiteSpace: "nowrap"
    });
    return b;
  }

  function showBarArmed() {
    captureBar.style.display = "flex";
    captureBar.innerHTML = "";
    const left = el("div", { display: "flex", alignItems: "center", gap: "10px" });
    left.innerHTML = `<span>🎯</span><span style="color:#94a3b8;font-size:13px;">Capture mode — click element or select text</span>`;
    const right = el("div", { display: "flex", alignItems: "center" });
    right.innerHTML = `<span style="color:#475569;font-size:12px;">Esc to cancel</span>`;
    const cancelBtn = cbBtn("✕ Cancel");
    cancelBtn.addEventListener("click", () => { disableCaptureMode(); hideBar(); });
    right.appendChild(cancelBtn);
    captureBar.appendChild(left);
    captureBar.appendChild(right);
  }

  function showBarCaptured(item) {
    captureBar.style.display = "flex";
    captureBar.innerHTML = "";

    const left = el("div", { display: "flex", alignItems: "center", gap: "10px" });
    const typeColors = { text: "#3b82f6", image: "#10b981", video: "#ec4899", iframe: "#f59e0b" };
    const typeTag = document.createElement("span");
    typeTag.style.cssText = `background:${typeColors[item.type]||"#64748b"};color:white;font-weight:700;font-size:11px;padding:2px 8px;border-radius:3px;text-transform:uppercase;`;
    typeTag.textContent = item.type;

    const preview = el("span", { color: "#cbd5e1", maxWidth: "360px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" });
    if (item.type === "image") {
      const thumb = document.createElement("img");
      thumb.src = item.content;
      Object.assign(thumb.style, { height: "28px", width: "28px", objectFit: "cover", borderRadius: "3px", verticalAlign: "middle", marginRight: "6px" });
      preview.appendChild(thumb);
      preview.append(item.content.split("/").pop().slice(0, 40) || item.content.slice(0, 40));
    } else if (item.type === "video") {
      preview.textContent = "🎬 " + (item.content.split("/").pop().slice(0, 55) || item.content.slice(0, 55));
    } else if (item.type === "iframe") {
      preview.textContent = "🖼 " + item.content.slice(0, 55);
    } else {
      preview.textContent = item.content.slice(0, 80) + (item.content.length > 80 ? "…" : "");
    }

    left.appendChild(typeTag);
    left.appendChild(preview);

    const right = el("div", { display: "flex", alignItems: "center" });
    const undoBtn = cbBtn("↩ Undo");
    undoBtn.addEventListener("click", () => { undoLastCapture(); showBarUndone(); });
    const moreBtn = cbBtn("＋ Capture More", "#1d4ed8");
    moreBtn.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); });
    const doneBtn = cbBtn("✓ Done", "#15803d");
    doneBtn.addEventListener("click", () => { hideBar(); openPanel(); });

    right.appendChild(undoBtn);
    right.appendChild(moreBtn);
    right.appendChild(doneBtn);
    captureBar.appendChild(left);
    captureBar.appendChild(right);
  }

  function showBarUndone() {
    captureBar.style.display = "flex";
    captureBar.innerHTML = "";
    const left = el("div", { display: "flex", alignItems: "center", gap: "10px" });
    left.innerHTML = `<span style="color:#fbbf24;">↩ Note moved to Recycle Bin</span>`;
    const right = el("div", { display: "flex", alignItems: "center" });
    const redoBtn = cbBtn("⟳ Redo", "#6d28d9");
    redoBtn.addEventListener("click", () => { const item = redoLastCapture(); if (item) showBarCaptured(item); });
    const moreBtn = cbBtn("＋ Capture Again", "#1d4ed8");
    moreBtn.addEventListener("click", () => { showBarArmed(); enableCaptureMode(); });
    const cancelBtn = cbBtn("✕ Done");
    cancelBtn.addEventListener("click", () => hideBar());
    right.appendChild(redoBtn);
    right.appendChild(moreBtn);
    right.appendChild(cancelBtn);
    captureBar.appendChild(left);
    captureBar.appendChild(right);
  }

  function hideBar() {
    captureBar.style.display = "none";
    captureBar.innerHTML = "";
    if (currentView === "main") renderMain();
  }

  // ═══════════════════════════════════════════════════════════════
  // UNDO / REDO
  // ═══════════════════════════════════════════════════════════════
  function undoLastCapture() {
    const d = getData();
    if (!d.capturedItems.length) return;
    const removed = d.capturedItems.pop();
    const nb = d.notebooks.find(n => n.id === removed.notebookId);
    d.recycleBin = d.recycleBin || [];
    d.recycleBin.push({ id: uid(), type: "note", note: removed, originalNotebookId: nb?.id, deletedAt: now() });
    undoStack.push(removed);
    setData(d);
  }

  function redoLastCapture() {
    if (!undoStack.length) return null;
    const item = undoStack.pop();
    const d = getData();
    // Remove from bin
    d.recycleBin = (d.recycleBin || []).filter(e => !(e.type === "note" && e.note.id === item.id));
    d.capturedItems.push(item);
    setData(d);
    return item;
  }

  // ═══════════════════════════════════════════════════════════════
  // CAPTURE MODE
  // ═══════════════════════════════════════════════════════════════
  function enableCaptureMode() {
    if (captureArmed) return;
    captureArmed = true;
    captureStyleEl = document.createElement("style");
    captureStyleEl.textContent = "#sidekick-capture-bar, #sidekick-capture-bar * { cursor: default !important; } * { cursor: crosshair !important; }";
    document.head.appendChild(captureStyleEl);
    captureOverlay = document.createElement("div");
    Object.assign(captureOverlay.style, {
      position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
      background: "rgba(0,0,0,0.03)", pointerEvents: "none", zIndex: "999997"
    });
    document.body.appendChild(captureOverlay);
    document.addEventListener("mouseup", onCaptureMouseUp, true);
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("mouseover", onCaptureHover, true);
    document.addEventListener("keydown", onCaptureKeyDown, true);
  }

  function disableCaptureMode() {
    if (!captureArmed) return;
    captureArmed = false;
    if (captureStyleEl) { captureStyleEl.remove(); captureStyleEl = null; }
    if (captureOverlay) { captureOverlay.remove(); captureOverlay = null; }
    document.removeEventListener("mouseup", onCaptureMouseUp, true);
    document.removeEventListener("click", onCaptureClick, true);
    document.removeEventListener("mouseover", onCaptureHover, true);
    document.removeEventListener("keydown", onCaptureKeyDown, true);
  }

  function onCaptureKeyDown(e) {
    if (e.key === "Escape") { disableCaptureMode(); hideBar(); }
  }

  function isSelectionInsidePanel() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el2 = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!(el2 && panel.contains(el2));
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
    if (element?.closest) {
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
    if (e.target?.tagName === "VIDEO") { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  function handleCapturedElement(element) {
    if (!element) return null;
    if (element.tagName === "IMG") return saveCapturedData({ type: "image", content: element.src });
    if (element.tagName === "VIDEO") return saveCapturedData({ type: "video", content: element.currentSrc });
    if (element.tagName === "IFRAME") return saveCapturedData({ type: "iframe", content: element.src });
    const selectedText = window.getSelection().toString().trim() || lastSelectedText;
    if (selectedText.length > 0) {
      lastSelectedText = "";
      return saveCapturedData({ type: "text", content: selectedText });
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════════
  function el(tag, styles) {
    const e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    return e;
  }
  function makeIconBtn(icon, title) {
    const b = document.createElement("button");
    b.className = "sk-icon-btn";
    b.title = title || "";
    b.textContent = icon;
    return b;
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOT
  // ═══════════════════════════════════════════════════════════════
  renderView("main");
}