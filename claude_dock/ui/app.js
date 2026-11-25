(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dock;
  const post = (type, data = {}) => bridge && bridge.postMessage(JSON.stringify({ type, ...data }));
  const body = document.body;

  const OPEN_DWELL = 170;    // ms parado na ilha pra abrir (evita abrir passando pro relógio)
  const CLOSE_DELAY = 300;   // ms fora do painel pra fechar
  const COLLAPSE_MS = 380;   // duração da animação de fechar

  let state = { live: [], history: [], folders: [], home: "" };
  let open = false, tab = null, userPickedTab = false;
  let openTimer, closeTimer, shapeTimer;

  function requestOpen() { setOpen(true); }

  // ----------------------------------------------------------------- i18n
  const DICT = window.I18N;
  const T = () => DICT[state.lang] || DICT.en;
  function t(key, vars) {
    let s = T()[key] ?? DICT.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
    return s;
  }
  let staticLang = null;
  function applyStatic() {
    if (staticLang === state.lang) return;
    staticLang = state.lang;
    document.documentElement.lang = T().locale;
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $$("[data-i18n-ph]").forEach((el) => el.setAttribute("placeholder", t(el.dataset.i18nPh)));
  }
  function errText(code) {
    if (!code) return "";
    const [kind, extra] = String(code).split(":");
    return t(`err_${kind}`, { code: extra || "" });
  }

  // ----------------------------------------------------------------- util

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // idle = terminou e espera você; waiting = parado pedindo algo (permissão etc.); resto = trabalhando
  const statusClass = (st) => (st === "idle" ? "idle" : st === "waiting" ? "other" : "busy");
  const PANEL_MIN = 280, PANEL_MAX = 620;

  function ago(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return t("now");
    if (s < 3600) return t("min", { n: Math.floor(s / 60) });
    if (s < 86400) return t("hours", { n: Math.floor(s / 3600) });
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(T().locale, { day: "numeric", month: "short" }).replace(".", "");
  }

  // cronômetro de "trabalhando há": 0:42, 12:05, 1h 07
  function elapsed(since) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - since));
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function dayLabel(ts) {
    const d = new Date(ts * 1000), today = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86400000);
    if (diff === 0) return t("today");
    if (diff === 1) return t("yesterday");
    if (diff < 7) return t("last7");
    return t("older");
  }

  function hue(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  const ICONS = {
    ghostty: `<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 3.2a7 7 0 00-7 7v10.3l2.33-1.75 2.34 1.75L12 18.75l2.33 1.75 2.34-1.75L19 20.5V10.2a7 7 0 00-7-7zM9.6 9.2a1.35 1.35 0 110 2.7 1.35 1.35 0 010-2.7zm4.8 0a1.35 1.35 0 110 2.7 1.35 1.35 0 010-2.7z"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24"><path d="M6 8l4 4-4 4M13 16.5h5"/></svg>`,
  };

  function hostTile(host) {
    const kind = host.kind || "unknown";
    if (kind === "ghostty") return `<span class="tile tile-ghostty">${ICONS.ghostty}</span>`;
    if (kind === "jetbrains") {
      const caps = (host.label.match(/[A-Z]/g) || []).join("").slice(0, 2) || host.label.slice(0, 2);
      return `<span class="tile tile-jetbrains">${esc(caps)}</span>`;
    }
    if (kind === "vscode") return `<span class="tile tile-vscode">${ICONS.terminal}</span>`;
    return `<span class="tile tile-${esc(kind)}">${ICONS.terminal}</span>`;
  }

  function projectTile(project) {
    const h = hue(project || "~");
    const letter = (project || "~").replace(/^[^a-zA-Z0-9]+/, "").charAt(0).toUpperCase() || "~";
    return `<span class="tile small" style="background:linear-gradient(160deg,hsl(${h} 62% 58%),hsl(${(h + 28) % 360} 58% 40%))">${esc(letter)}</span>`;
  }

  // ------------------------------------------------- altura que acompanha o conteúdo

  let panelH = PANEL_MIN;
  function fitHeight() {
    const panel = $("#panel");
    const view = $(".view.on");
    // scrollHeight nunca fica menor que a área visível; mede pelo último filho
    const last = view && view.lastElementChild;
    const contentH = last ? last.offsetTop + last.offsetHeight + 18 : 0;
    let h = contentH + $(".views").offsetTop + $(".dock-foot").offsetHeight;
    if (body.classList.contains("asking")) {
      // mede o conteúdo (o cartão estica com flex, então scrollHeight não serve)
      const card = $("#ans-card");
      const inner = $("#ans-body").getBoundingClientRect().bottom - card.getBoundingClientRect().top + card.scrollTop + 14;
      h = $("#answer").offsetTop + inner + $("#ans-actions").offsetHeight + 8;
    }
    if (body.classList.contains("ask-picking")) h = Math.max(h, $("#ask").offsetTop + $("#ask-menu").offsetTop + $("#ask-menu").offsetHeight + 24);
    if (body.classList.contains("sheet")) h = Math.max(h, $("#sheet").scrollHeight + 90);
    if (body.classList.contains("sum")) h = Math.max(h, $("#sum-sheet").scrollHeight + 90);
    const ulast = $("#u-body").lastElementChild;
    if (ulast) h = Math.max(h, $("#u-body").offsetTop + ulast.offsetTop + ulast.offsetHeight + $("#u-foot").offsetHeight + 26);
    h = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, h)));
    if (h === panelH && panel.style.height) return;
    panelH = h;
    panel.style.height = `${h}px`;
    if (open) sendShape();
  }

  // ---------------------------------------------------------------- shape

  function sendShape() {
    const el = open ? $("#panel") : $("#island");
    const r = el.getBoundingClientRect();
    if (open) {
      const p = $("#panel");
      post("shape", { x: p.offsetLeft, y: 0, w: p.offsetWidth, h: p.offsetTop + panelH + 2 });
    } else {
      const pad = 16; // área de hover maior que a ilha, colada no top bar
      post("shape", { x: r.left - pad, y: 0, w: r.width + pad * 2, h: r.bottom + 8 });
    }
  }

  // -------------------------------------------------------- abrir/fechar

  function setOpen(v) {
    if (v === open) return;
    open = v;
    clearTimeout(shapeTimer);
    body.classList.toggle("open", v);
    $("#panel").setAttribute("aria-hidden", String(!v));
    post("expanded", { value: v });
    if (v) {
      // resposta já vista e parada há mais de 15 min: volta pras sessões
      if (ask && ask.status !== "running" && ask.endedAt && Date.now() / 1000 - ask.endedAt > 900 && !askCfg().unseen) {
        post("askClear");
        if (!bridge) window.dockAsk(null);
      }
      if (!userPickedTab) setTab(state.live.length ? "live" : "recent", false);
      fitHeight();
      sendShape();
      playUsage();
    } else {
      closeSheet();
      closeSum();
      closeAskMenu();
      if (!ask) askCwd = null;   // a pasta escolhida no chip vale até fechar
      $("#search").blur();
      askInput.blur();
      post("releaseFocus");
      userPickedTab = false;
      shapeTimer = setTimeout(sendShape, COLLAPSE_MS);
    }
  }

  $("#island").addEventListener("mouseenter", () => {
    body.classList.add("hovering");
    clearTimeout(closeTimer);
    openTimer = setTimeout(requestOpen, OPEN_DWELL);
  });
  $("#island").addEventListener("mouseleave", () => {
    body.classList.remove("hovering");
    clearTimeout(openTimer);
  });
  $("#island").addEventListener("click", () => { clearTimeout(openTimer); requestOpen(); });

  let overPanel = false;
  $("#panel").addEventListener("mouseenter", () => { overPanel = true; clearTimeout(closeTimer); });
  $("#panel").addEventListener("mouseleave", () => {
    overPanel = false;
    if (document.activeElement === $("#search") && $("#search").value) return;
    // usando o comando rápido (foco no dock): só fecha com Esc ou clicando fora
    if (document.hasFocus() && (document.activeElement === askInput || ask)) return;
    closeTimer = setTimeout(() => setOpen(false), CLOSE_DELAY);
  });
  // clicou em outra janela: o foco já foi pra lá (nada a devolver) e o painel fecha
  window.addEventListener("blur", () => {
    post("focusLost");
    if (open && !overPanel) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (body.classList.contains("sheet")) closeSheet();
    else if (body.classList.contains("sum")) closeSum();
    else setOpen(false);
  });

  function act(type, data, el) {
    if (el) { el.classList.remove("tap"); void el.offsetWidth; el.classList.add("tap"); }
    post(type, data);
    setTimeout(() => setOpen(false), 160);
  }

  // ----------------------------------------------------------------- abas

  function setTab(t, byUser = true) {
    tab = t;
    if (byUser) userPickedTab = true;
    $(".content .seg").dataset.tab = t;
    $$(".content .seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    $$(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === t));
    fitHeight();
  }
  $$(".seg button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // ---------------------------------------------------------------- folha

  function openSheet() { body.classList.add("sheet"); fitHeight(); }
  function closeSheet() { body.classList.remove("sheet"); fitHeight(); }
  $("#new").addEventListener("click", openSheet);
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#scrim").addEventListener("click", () => { closeSheet(); closeSum(); });
  $("#pick").addEventListener("click", (e) => act("pickFolder", {}, e.currentTarget));
  $("#folders").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-cwd]");
    if (li) act("new", { cwd: li.dataset.cwd }, li);
  });

  // --------------------------------------------------------------- render

  function renderIsland() {
    $("#dots").innerHTML = state.live.slice(0, 10)
      .map((s) => `<span class="dot ${statusClass(s.status)}${s.unseenAt && s.status === "idle" ? " unseen" : ""}"></span>`).join("");
    // texto só enquanto alguém espera você; some sozinho
    const waiting = state.live.filter((s) => s.status === "waiting").length;
    $("#island-wait").textContent = waiting ? t("islandWaiting", { n: waiting }) : "";
    if (!open) requestAnimationFrame(sendShape);
  }

  function renderSummary() {
    const n = state.live.length;
    const busy = state.live.filter((s) => statusClass(s.status) === "busy").length;
    const free = state.live.filter((s) => statusClass(s.status) === "idle").length;
    const waiting = state.live.filter((s) => statusClass(s.status) === "other").length;
    let txt;
    if (!n) txt = t("noneOpen");
    else {
      const parts = [];
      if (busy) parts.push(t("working", { n: busy }));
      if (waiting) parts.push(t("waiting", { n: waiting }));
      if (free) parts.push(t(free === 1 ? "free1" : "freeN", { n: free }));
      txt = parts.join(" · ") || t(n === 1 ? "sessions1" : "sessionsN", { n });
    }
    $("#summary").textContent = txt;
    $("#nlive").textContent = n ? String(n) : "";
  }

  function renderLive() {
    const box = $("#live");
    if (!state.live.length) {
      box.innerHTML = `
        <div class="empty">
          <div class="empty-ico"><svg viewBox="0 0 24 24"><path d="M12 2.5l1.6 6.1 5.6-3.1-3.1 5.6 6.1 1.6-6.1 1.6 3.1 5.6-5.6-3.1L12 22.5l-1.6-6.1-5.6 3.1 3.1-5.6-6.1-1.6 6.1-1.6-3.1-5.6 5.6 3.1z"/></svg></div>
          <b>${t("emptyLiveTitle")}</b>
          <span>${t("emptyLiveText")}</span>
        </div>`;
      return;
    }
    // quem espera você vem primeiro; o resto mantém a ordem de sempre
    const rows = [...state.live].sort((a, b) => (b.status === "waiting") - (a.status === "waiting"));
    box.innerHTML = `<ul class="group">${rows.map((s) => {
      const c = statusClass(s.status);
      const unseen = c === "idle" && s.unseenAt;
      const trail = c === "busy"
        ? `<span class="elapsed" data-since="${s.statusSince}">${elapsed(s.statusSince)}</span><span class="spinner" title="${t("workingTip")}"></span>`
        : c === "idle"
          ? `<span class="badge idle">${t(unseen ? "readyBadge" : "free")}</span>`
          : `<span class="badge other">${t("waitingBadge")}</span>`;
      // parada: a linha de baixo diz onde parou (ou que ficou esquecida com alterações)
      const forgot = c === "idle" && s.forgotten;
      const recap = c === "idle" && s.recap;
      const sub = c === "other"
        ? `<span class="why">${esc(waitReason(s.waitingFor))}</span> · ${esc(s.project)}`
        : forgot
          ? `<span class="stale" title="${esc(t("forgotTip"))}">${esc(forgotLine(s.forgotten))}</span> · <span class="proj">${esc(s.project)}</span>`
          : unseen
            ? `<span class="done" data-done="${s.unseenAt}">${doneAgo(s.unseenAt)}</span> · ${recap ? `<span class="recap">${esc(s.recap)}</span>` : esc(s.project)}`
            : recap
              ? `<span class="proj">${esc(s.project)}</span> · <span class="recap">${esc(s.recap)}</span>`
              : `${esc(s.project)} · ${esc(s.host.label)}`;
      const tip = [s.title || t("untitled"), recap ? `${s.project} · ${s.recap}` : ""].filter(Boolean).join("\n");
      return `
        <li class="row${c === "other" ? " waiting" : ""}${unseen ? " unseen" : ""}${forgot ? " forgotten" : ""}" data-pid="${s.pid}" title="${esc(tip)}">
          ${hostTile(s.host)}
          <div class="row-text">
            <div class="row-title">${esc(s.title || t("untitled"))}</div>
            <div class="row-sub">${sub}</div>
          </div>
          <div class="trail">${trail}</div>
        </li>`;
    }).join("")}</ul>`;
  }

  // "parada há 3 h · 4 arquivos sem commit"
  function forgotLine(f) {
    const s = Math.max(0, Date.now() / 1000 - f.since);
    const span = s >= 86400 ? t("daysN", { n: Math.floor(s / 86400) }) : t("hours", { n: Math.max(1, Math.floor(s / 3600)) });
    return t(f.files === 1 ? "forgotLine1" : "forgotLine", { t: span, n: f.files });
  }

  const WAIT_KEYS = { "permission": "wf_permission", "input needed": "wf_input", "dialog open": "wf_dialog", "sandbox request": "wf_sandbox" };
  const waitReason = (w) => t(WAIT_KEYS[String(w || "").trim().toLowerCase()] || "wf_other");
  function doneAgo(ts) {
    const s = Date.now() / 1000 - ts;
    return s < 60 ? t("doneNow") : t("doneAgo", { t: ago(ts) });
  }

  // realça o trecho buscado (todas as ocorrências, sem diferenciar maiúsculas)
  function mark(text, q) {
    const s = String(text ?? "");
    if (!q) return esc(s);
    const low = s.toLowerCase();
    let out = "", i = 0, j;
    while ((j = low.indexOf(q, i)) !== -1) {
      out += esc(s.slice(i, j)) + `<mark>${esc(s.slice(j, j + q.length))}</mark>`;
      i = j + q.length;
    }
    return out + esc(s.slice(i));
  }

  function renderHistory() {
    const q = $("#search").value.trim().toLowerCase();
    const items = state.history.filter((h) =>
      !q || h.title.toLowerCase().includes(q) || h.project.toLowerCase().includes(q));
    const box = $("#history");
    if (!items.length) {
      box.innerHTML = `<div class="empty"><b>${q ? t("nothingFound") : t("noHistory")}</b><span>${q ? t("tryAnother") : ""}</span></div>`;
      return;
    }
    const groups = [];
    for (const h of items) {
      const label = dayLabel(h.mtime);
      if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
      groups[groups.length - 1].items.push(h);
    }
    box.innerHTML = groups.map((g) => `
      <div class="section-title">${g.label}</div>
      <ul class="group">${g.items.map((h) => `
        <li class="row compact" data-sid="${esc(h.sessionId)}" data-cwd="${esc(h.cwd)}" title="${esc(h.title)}">
          ${projectTile(h.project)}
          <div class="row-text">
            <div class="row-title">${mark(h.title, q)}</div>
            <div class="row-sub">${mark(h.project, q)}</div>
          </div>
          <span class="when">${ago(h.mtime)}</span>
          <span class="chev"></span>
        </li>`).join("")}
      </ul>`).join("");
  }

  function renderFolders() {
    const folders = state.folders.length ? state.folders
      : (state.home ? [{ cwd: state.home, project: "~", short: state.home }] : []);
    $("#folders").innerHTML = folders.map((f) => `
      <li class="row compact" data-cwd="${esc(f.cwd)}">
        ${projectTile(f.project)}
        <div class="row-text">
          <div class="row-title">${esc(f.project)}</div>
          <div class="row-sub">${esc(f.short)}</div>
        </div>
        <span class="chev"></span>
      </li>`).join("");
    $("#folders").style.display = folders.length ? "" : "none";
  }

  $("#live").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-pid]");
    if (li) act("focus", { pid: Number(li.dataset.pid) }, li);
  });
  $("#history").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-sid]");
    if (!li) return;
    const mode = clickMode();
    if (mode === "open") { act("resume", { sessionId: li.dataset.sid, cwd: li.dataset.cwd }, li); return; }
    // modo copiar: o Python põe na área de transferência; a linha confirma e o painel fecha
    post("resume", { sessionId: li.dataset.sid, cwd: li.dataset.cwd });
    const sub = li.querySelector(".row-sub");
    if (sub) { sub.textContent = t(mode === "copySlash" ? "copiedSlash" : "copiedCli"); sub.classList.add("copied"); }
    li.classList.remove("tap"); void li.offsetWidth; li.classList.add("tap");
    setTimeout(() => setOpen(false), 650);
  });
  $("#search").addEventListener("input", () => { renderHistory(); fitHeight(); });
  $("#see-all").addEventListener("click", (e) => act("openLibrary", {}, e.currentTarget));

  // ================================================================ uso

  const SEV = (p) => (p >= 90 ? "crit" : p >= 70 ? "warn" : "");
  const GRAD = {
    session: ["#ff9f5a", "#ff5e8a"],
    week: ["#34d399", "#5ac8fa"],
    model: ["#bf5af2", "#7d7aff"],
  };
  const SEV_COLOR = { warn: ["#ffd60a", "#ff9f0a"], crit: ["#ff6b5a", "#ff2d55"] };
  const SPENT_COLORS = ["#ff9f5a", "#bf5af2", "#5ac8fa", "#34d399", "#ffd60a"];
  let usageKey = "";

  const colorsFor = (kind, pct) => SEV_COLOR[SEV(pct)] || GRAD[kind];
  const usageCfg = () => ({ plan: true, rings: true, session: true, week: true, paceMarker: true, resetTime: true, models: false, spent: false,
    ...((state.config && state.config.usage) || {}) });
  const cfg = usageCfg; // usado dentro de statRow

  // configurações: janela própria (a mesma da engrenagem da janela de sessões)
  const CLICKS = ["open", "copyCli", "copySlash"];
  function clickMode() {
    const m = state.config && state.config.clickAction;
    return CLICKS.includes(m) ? m : "open";
  }
  $("#u-settings").addEventListener("click", (e) => act("openSettings", {}, e.currentTarget));
  const grad = (c) => `linear-gradient(90deg, ${c[0]}, ${c[1]})`;

  function until(iso) {
    const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
    if (d) return t("inDH", { d, h });
    if (h) return t("inHM", { h, m: String(m).padStart(2, "0") });
    return t("inM", { m: Math.max(1, m) });
  }
  function when(iso) {
    const d = new Date(iso), today = new Date();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (d.toDateString() === today.toDateString()) return t("todayAt", { hm });
    return `${T().weekdays[d.getDay()]} ${hm}`;
  }
  const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString(T().locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  function since(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 10) return t("justNow");
    if (s < 60) return t("agoS", { n: s });
    if (s < 3600) return t("agoM", { n: Math.floor(s / 60) });
    return t("agoH", { n: Math.floor(s / 3600) });
  }
  // fração da janela que já passou (pra comparar com o consumo)
  function elapsedFrac(resetsAt, startedAt, spanH) {
    const end = Date.parse(resetsAt);
    const start = startedAt ? Date.parse(startedAt) : end - spanH * 3600000;
    return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
  }

  function ringsSvg(rings) {
    const size = 172, stroke = 15, gap = 4;
    let defs = "", body = "";
    rings.forEach((r, i) => {
      const rad = size / 2 - stroke / 2 - i * (stroke + gap);
      const circ = 2 * Math.PI * rad;
      const off = circ * (1 - Math.min(100, r.pct) / 100);
      const id = `rg${i}`;
      defs += `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${r.c[0]}"/><stop offset="1" stop-color="${r.c[1]}"/></linearGradient>`;
      body += `<circle class="ring-track" cx="86" cy="86" r="${rad}" stroke="${r.c[0]}" stroke-width="${stroke}"/>
        <circle class="ring-val" cx="86" cy="86" r="${rad}" stroke="url(#${id})" stroke-width="${stroke}"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-circ="${circ}" data-off="${off}"/>`;
    });
    return `<svg viewBox="0 0 172 172"><defs>${defs}</defs>${body}</svg>`;
  }

  function statRow({ name, pct, kind, resetsAt, pace, note }) {
    const c = colorsFor(kind, pct);
    return `
      <li class="stat" style="--g:${grad(c)}">
        <div class="stat-top">
          <span class="stat-name"><i></i>${esc(name)}</span>
          <span class="stat-pct ${SEV(pct)}">${pct}%</span>
        </div>
        <div class="bar"><b data-w="${Math.min(100, pct)}" style="width:0"></b>${pace != null ? `<span class="pace" style="left:${(pace * 100).toFixed(1)}%" title="${t("paceTip")}"></span>` : ""}</div>
        ${cfg().resetTime ? `<div class="stat-sub"><span>${resetsAt ? t("resets", { when: until(resetsAt) }) : ""}</span><span>${resetsAt ? when(resetsAt) : ""}</span></div>` : ""}
        ${note || ""}
      </li>`;
  }


  function renderUsage(force = false) {
    const u = state.usage;
    $("#u-refresh").classList.toggle("spin", !!state.usageLoading);
    const cfg = usageCfg();
    const key = JSON.stringify([u, state.config, state.lang]);
    if (!force && key === usageKey) { renderUsageFoot(); return; }
    usageKey = key;

    // ilha: 5h se existir, senão semana
    const main = u && (u.session || u.week) ? (u.session ? { ...u.session, tag: "5h" } : { ...u.week, tag: "week" }) : null;
    const showIsland = main && (state.config ? state.config.islandUsage !== false : true);
    const iu = $("#island-usage");
    iu.className = `island-usage ${showIsland ? SEV(main.pct) : ""}`;
    iu.textContent = showIsland ? `${main.pct}%` : "";
    iu.title = showIsland ? (main.tag === "5h" ? t("session5h") : t("week")) : "";
    if (!open) requestAnimationFrame(sendShape);

    $("#u-plan").textContent = u && u.plan && cfg.plan ? u.plan : "";
    const bodyEl = $("#u-body");
    if (!u) { bodyEl.innerHTML = `<div class="u-empty">${t("checking")}</div>`; renderUsageFoot(); return; }
    if (u.ok === false && !u.week && !u.session) {
      bodyEl.innerHTML = `<div class="u-empty">${esc(errText(u.error))}</div>`;
      renderUsageFoot();
      return;
    }

    const rings = [];
    if (u.session) rings.push({ pct: u.session.pct, c: colorsFor("session", u.session.pct) });
    if (u.week) rings.push({ pct: u.week.pct, c: colorsFor("week", u.week.pct) });
    const center = main;

    const rows = [];
    if (u.session && cfg.session) {
      const f = cfg.paceMarker ? elapsedFrac(u.session.resetsAt, null, 5) : null;
      // só aparece quando o ritmo dos últimos 30 min acaba com a janela antes do reset
      const eta = u.forecastAt;
      const note = eta && eta * 1000 > Date.now() && eta * 1000 < Date.parse(u.session.resetsAt)
        ? `<div class="forecast" title="${esc(t("forecastTip"))}"><i></i>${esc(t("forecast", { hm: hhmm(eta) }))}</div>` : "";
      rows.push(statRow({ name: t("sessionRow"), pct: u.session.pct, kind: "session", resetsAt: u.session.resetsAt, pace: f, note }));
    }
    if (u.week && cfg.week) {
      const f = cfg.paceMarker ? elapsedFrac(u.week.resetsAt, u.weekStartedAt, 168) : null;
      rows.push(statRow({ name: t("week"), pct: u.week.pct, kind: "week", resetsAt: u.week.resetsAt, pace: f }));
    }
    const modelRows = (cfg.models ? u.models || [] : []).map((m) => statRow({ name: t("weekOf", { name: m.name }), pct: m.pct, kind: "model", resetsAt: m.resetsAt }));

    const spent = cfg.spent ? u.spent || [] : [];
    const spentHtml = spent.length ? `
      <div class="section-title">${t("spentTitle")}</div>
      <div class="group" style="padding:2px 14px 13px">
        <div class="stack">${spent.map((s, i) => `<span style="flex-grow:${s.pct};background:${SPENT_COLORS[i % SPENT_COLORS.length]}"></span>`).join("")}</div>
        <div class="legend">${spent.map((s, i) => `<span><i style="background:${SPENT_COLORS[i % SPENT_COLORS.length]}"></i>${esc(s.name)} <b>${s.pct}%</b></span>`).join("")}</div>
      </div>` : "";

    bodyEl.innerHTML = `
      ${u.error ? `<div class="u-err">${esc(errText(u.error))}</div>` : ""}
      ${rings.length && cfg.rings ? `<div class="rings">${ringsSvg(rings)}
        <div class="rings-center"><div class="big">${center.pct}<small>%</small></div>
        <div class="big-label">${center.tag === "5h" ? t("ofSession") : t("ofWeek")}</div></div></div>` : ""}
      ${rows.length ? `<ul class="group">${rows.join("")}</ul>` : ""}
      ${modelRows.length ? `<ul class="group">${modelRows.join("")}</ul>` : ""}
      ${spentHtml}`;
    if (!bodyEl.textContent.trim()) {
      bodyEl.innerHTML = `<div class="u-empty">${t("nothingSelected")}</div>`;
    }
    renderUsageFoot();
    if (open) playUsage(false);
    fitHeight();
  }

  function renderUsageFoot() {
    const u = state.usage;
    const foot = $("#u-foot");
    foot.classList.toggle("loading", !!state.usageLoading);
    if (state.usageLoading) foot.innerHTML = `<span class="live-dot"></span>${t("updating")}`;
    else if (u && u.fetchedAt) foot.innerHTML = `<span class="live-dot"></span>${t("updated", { when: since(u.fetchedAt) })}`;
    else foot.innerHTML = "";
  }

  // anéis e barras crescem do zero
  function playUsage(fromZero = true) {
    const rings = $$(".ring-val"), bars = $$(".bar > b");
    if (fromZero) {
      rings.forEach((c) => { c.style.transition = "none"; c.setAttribute("stroke-dashoffset", c.dataset.circ); });
      bars.forEach((b) => { b.style.transition = "none"; b.style.width = "0"; });
      void document.body.offsetWidth;
    }
    requestAnimationFrame(() => {
      rings.forEach((c) => { c.style.transition = ""; c.setAttribute("stroke-dashoffset", c.dataset.off); });
      bars.forEach((b) => { b.style.transition = ""; b.style.width = `${b.dataset.w}%`; });
    });
  }

  $("#u-refresh").addEventListener("click", () => {
    $("#u-refresh").classList.add("spin");
    post("refreshUsage");
  });

  // ---------------------------------------------------------- atualização
  let updateKey = "";
  function renderUpdate() {
    const u = state.update && state.update.available ? state.update : null;
    const st = state.updateState;
    const key = JSON.stringify([u, st, state.lang]);
    if (key === updateKey) return;
    updateKey = key;

    const badge = $("#island-update");
    badge.hidden = !u;
    badge.title = u ? t("updateTip") : "";
    if (!open) requestAnimationFrame(sendShape);

    const box = $("#u-update");
    if (!u) { box.innerHTML = ""; return; }
    const running = st === "running";
    box.innerHTML = `
      <div class="update-card ${running ? "running" : ""}">
        <div class="uc-icon"><svg viewBox="0 0 24 24"><path d="M12 18V6M6.5 11.5L12 6l5.5 5.5"/></svg></div>
        <div class="uc-text">
          <b>${esc(t("updateTitle", { v: u.latest }))}</b>
          <span>${esc(t("updateCurrent", { v: u.current }))} · <a href="#" class="uc-notes">${t("updateNotes")}</a></span>
        </div>
        <button class="uc-btn" ${running ? "disabled" : ""}>${running ? `<i class="uc-spin"></i>${t("updateRunning")}` : t("updateBtn")}</button>
      </div>
      ${st === "error" ? `<div class="uc-err">${esc(t("updateError"))}</div>` : ""}`;
    fitHeight();
  }
  $("#u-update").addEventListener("click", (e) => {
    const u = state.update;
    if (!u) return;
    if (e.target.closest(".uc-notes")) { e.preventDefault(); post("openUrl", { url: u.url }); return; }
    if (e.target.closest(".uc-btn")) { state.updateState = "running"; updateKey = ""; renderUpdate(); post("applyUpdate"); }
  });

  // ======================================================== resumo do dia

  const sumOn = () => !state.config || !state.config.summary || state.config.summary.enabled !== false;
  let sumCopiedTimer;
  function openSum() {
    const s = state.summary;
    const today = new Date().toDateString();
    // só roda quando você pede: abre o último de hoje; sem nenhum, escreve agora
    if (!s || (s.status !== "running" && new Date((s.at || 0) * 1000).toDateString() !== today)) runSum();
    body.classList.add("sum");
    sumKey = "";
    renderSum();
  }
  function closeSum() {
    if (!body.classList.contains("sum")) return;
    body.classList.toggle("sum", false);
    fitHeight();
  }
  function runSum() {
    post("summaryRun");
    if (!bridge) demoSum();
    else state.summary = { status: "running", at: Date.now() / 1000 };
  }

  let sumKey = "";
  function renderSum() {
    const btn = $("#sum-open");
    btn.hidden = !sumOn();
    const s = state.summary;
    btn.classList.toggle("busy", !!s && s.status === "running");
    if (!sumOn()) closeSum();
    const showing = body.classList.contains("sum");
    const key = JSON.stringify([s, state.lang]);
    if (!showing || key === sumKey) return;
    sumKey = key;
    const st = s ? s.status : "running";
    $("#sum-sub").textContent = st === "done" && s.at ? t("sumAt", { hm: hhmm(s.at) }) : t("sumSub");
    let html;
    if (st === "running") {
      html = `<div class="sum-wait"><span class="spinner"></span><div><b>${t("sumRunning")}</b><span>${t("sumRunningHint")}</span></div></div>`;
    } else if (st === "error" && s.error === "empty") {
      html = `<div class="sum-empty"><b>${t("sumEmpty")}</b><span>${t("sumEmptySub")}</span></div>`;
    } else if (st === "error") {
      html = `<div class="ans-err"><b>${t("sumFailed")}</b>${s.error ? `<span>${esc(s.error === "noClaude" ? t("askNoClaude") : s.error)}</span>` : ""}</div>`;
    } else {
      html = `<div class="md">${md(s.text || "")}</div>`;
    }
    $("#sum-body").innerHTML = html;
    // linha só com o nome do projeto em negrito vira cabeçalho do grupo
    $$("#sum-body .md p").forEach((p) => {
      if (p.childNodes.length === 1 && p.firstChild.nodeName === "B") p.classList.add("md-proj");
    });
    $("#sum-actions").innerHTML = st === "running" ? "" : [
      st === "done" ? `<button class="pill primary" data-sum="copy"><span>${t("sumCopy")}</span></button>` : "",
      `<button class="pill" data-sum="again"><span>${t("sumAgain")}</span></button>`,
    ].join("");
    fitHeight();
  }
  $("#sum-open").addEventListener("click", openSum);
  $("#sum-close").addEventListener("click", closeSum);
  $("#sum-actions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sum]");
    if (!b) return;
    if (b.dataset.sum === "again") { runSum(); sumKey = ""; renderSum(); return; }
    post("summaryCopy");
    b.classList.add("done");
    b.querySelector("span").textContent = t("sumCopied");
    clearTimeout(sumCopiedTimer);
    sumCopiedTimer = setTimeout(() => { b.classList.toggle("done", false); b.querySelector("span").textContent = t("sumCopy"); }, 1400);
  });

  // ======================================================= comando rápido

  let ask = null;            // pedido atual (snapshot vindo do Python) ou null
  let askCwd = null;         // pasta escolhida no chip; null = a padrão
  let histIdx = -1, histDraft = "";
  let copiedTimer;
  const askInput = $("#ask-input");
  const askRunning = () => !!ask && ask.status === "running";
  const askCfg = () => state.ask || {};
  // com uma conversa aberta, o próximo pedido vai pra pasta dela (e continua a conversa)
  const askFolder = () => askCwd || (ask && ask.cwd ? { cwd: ask.cwd, project: ask.project, short: ask.short } : null)
    || askCfg().default || { cwd: state.home, project: "~", short: "~" };

  // markdown mínimo e seguro: tudo é escapado antes; só parágrafos, listas, títulos e código
  function mdInline(s) {
    const codes = [];
    let out = String(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    out = esc(out)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span class="md-link">$1</span>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  }
  function md(text) {
    const lines = String(text).split("\n");
    const out = [];
    let para = [], list = null, i = 0;
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(mdInline).join("<br>")}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${mdInline(x)}</li>`).join("")}</${list.tag}>`); list = null; };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```/);
      if (fence) {
        flushPara(); flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {          // tabela: mostra como texto alinhado
        flushPara(); flushList();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
        out.push(`<pre class="md-table">${esc(rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r)).join("\n"))}</pre>`);
        continue;
      }
      const h = line.match(/^\s*#{1,6}\s+(.*)$/);
      const ul = line.match(/^\s*[-*+•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push(`<h4>${mdInline(h[1])}</h4>`); }
      else if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += " " + line.trim();
      else { flushList(); para.push(line); }
      i++;
    }
    flushPara(); flushList();
    return out.join("");
  }

  const TOOL_KEYS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Edit", "Write", "Bash"];
  function toolLine(it, last) {
    const key = TOOL_KEYS.includes(it.tool) && it.arg ? `tool_${it.tool}` : "tool_other";
    const label = t(key, { arg: it.arg || "", tool: it.tool });
    return `<div class="ans-tool${it.denied ? " denied" : ""}"><i></i><span>${esc(label)}${last && !it.denied ? "…" : ""}</span>${it.denied ? `<em>${t("askDenied")}</em>` : ""}</div>`;
  }

  function dur(s) {
    s = Math.max(0, Math.round(s));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  }

  function renderAskBar() {
    const running = askRunning();
    body.classList.toggle("ask-running", running);
    askInput.disabled = running;
    if (running) askInput.value = "";
    askInput.placeholder = t(running ? "askRunning" : ask ? "askPhAgain" : "askPh");
    const f = askFolder();
    $("#ask-folder").innerHTML = `<span>${esc(f.project)}</span><i class="caret"></i>`;
    $("#ask-folder").title = `${t("askFolderTip")}: ${f.short}`;
    const sc = askCfg().shortcut;
    $("#ask-keys").innerHTML = sc && sc !== "off" ? keycaps(sc).map((k) => `<kbd>${esc(k)}</kbd>`).join("") : "";
    $("#island-ask").textContent = askCfg().unseen ? t("askReady") : "";
  }

  // "<Control><Alt>space" -> ["Ctrl", "Alt", "Espaço"]
  function keycaps(accel) {
    const MOD = { Control: "Ctrl", Primary: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Super", Meta: "Super" };
    const mods = [...accel.matchAll(/<(\w+)>/g)].map((m) => MOD[m[1]] || m[1]);
    let key = accel.replace(/<\w+>/g, "");
    key = key === "space" ? t("keySpace") : key.length === 1 ? key.toUpperCase() : key;
    return [...mods, key];
  }

  function renderAnswer() {
    body.classList.toggle("asking", !!ask);
    if (!ask) { fitHeight(); return; }
    const card = $("#ans-card");
    const nearBottom = card.scrollHeight - card.scrollTop - card.clientHeight < 40;
    const turns = ask.turns || [];
    // numa conversa o título é o primeiro pedido; cada pedido seguinte aparece no corpo
    $("#ans-q").textContent = turns.length ? turns[0].prompt : ask.prompt;
    const running = ask.status === "running";
    const meta = [esc(ask.project), esc(ask.model ? ask.model[0].toUpperCase() + ask.model.slice(1) : t("askDefaultModel")), t(`askMode_${ask.mode}`)];
    if (ask.status === "done" && ask.endedAt) meta.push(t("askDoneIn", { t: dur(ask.endedAt - ask.startedAt) }));
    $("#ans-meta").innerHTML = (running ? `<span class="ans-spin"></span>` : "") + meta.join(" · ");
    $("#ans-meta").title = ask.short;

    const items = ask.items || [];
    const itemHtml = (list, live) => list.map((it, i) => it.kind === "tool"
      ? toolLine(it, live && i === list.length - 1)
      : it.kind === "note" ? `<div class="ans-note">${t("askStopped")}</div>`
      : `<div class="md">${md(it.text)}</div>`).join("");
    const past = turns.map((tn, i) => (i ? `<div class="ans-uq">${esc(tn.prompt)}</div>` : "") + itemHtml(tn.items || [], false)).join("");
    let html = itemHtml(items, running);
    if (running && !items.length) html = `<div class="ans-tool wait"><i></i><span>${t("askThinking")}</span></div>`;
    if (turns.length) html = `${past}<div class="ans-uq">${esc(ask.prompt)}</div>${html}`;
    if (running && items.length && items[items.length - 1].kind === "text" && ask.streaming) html += `<span class="caret-blink"></span>`;
    if (ask.status === "stopped") html += `<div class="ans-note">${t("askStopped")}</div>`;
    if (ask.status === "error") html += `<div class="ans-err"><b>${t("askFailed")}</b>${ask.error ? `<span>${esc(ask.error === "noClaude" ? t("askNoClaude") : ask.error)}</span>` : ""}</div>`;
    $("#ans-body").innerHTML = html;
    // o cursor que pisca fica no fim do último parágrafo
    const caret = $("#ans-body > .caret-blink");
    let lastP = caret && caret.previousElementSibling;
    while (lastP && lastP.lastElementChild && /^(DIV|UL|OL)$/.test(lastP.tagName)) lastP = lastP.lastElementChild;
    if (caret && lastP && /^(P|LI|H4)$/.test(lastP.tagName)) lastP.appendChild(caret);

    const hasText = items.some((it) => it.kind === "text" && it.text.trim());
    $("#ans-actions").innerHTML = running ? "" : [
      ask.sessionId ? `<button class="pill primary" data-ask="resume">${ICONS.terminal}<span>${t("askContinue")}</span></button>` : "",
      hasText ? `<button class="pill" data-ask="copy"><span>${t("askCopy")}</span></button>` : "",
      `<button class="pill" data-ask="new"><span>${t("askNew")}</span></button>`,
    ].join("");
    fitHeight();
    if (running && nearBottom) card.scrollTop = card.scrollHeight;
  }

  function sendAsk() {
    const prompt = askInput.value.trim();
    if (!prompt || askRunning()) return;
    closeAskMenu();
    post("askSend", { prompt, cwd: askFolder().cwd });
    histIdx = -1;
    askInput.value = "";
    if (!bridge) demoAsk(prompt);   // prévia no navegador
  }

  function focusAsk() {
    if (askRunning()) $("#ask-stop").focus(); else askInput.focus();
  }

  function openAskMenu() {
    const folders = state.folders.length ? state.folders : [askFolder()];
    const cur = askFolder().cwd;
    $("#ask-folders").innerHTML = folders.map((f) => `
      <li class="row compact${f.cwd === cur ? " on" : ""}" data-cwd="${esc(f.cwd)}" data-project="${esc(f.project)}" data-short="${esc(f.short)}">
        ${projectTile(f.project)}
        <div class="row-text"><div class="row-title">${esc(f.project)}</div><div class="row-sub">${esc(f.short)}</div></div>
        ${f.cwd === cur ? `<span class="check"></span>` : ""}
      </li>`).join("");
    body.classList.add("ask-picking");
    fitHeight();
  }
  function closeAskMenu() { if (body.classList.contains("ask-picking")) { body.classList.remove("ask-picking"); fitHeight(); } }

  askInput.addEventListener("mousedown", () => post("grabFocus"));
  askInput.addEventListener("focus", () => body.classList.add("ask-focus"));
  askInput.addEventListener("blur", () => body.classList.remove("ask-focus"));
  askInput.addEventListener("input", () => { histIdx = -1; });
  askInput.addEventListener("keydown", (e) => {
    const hist = askCfg().history || [];
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendAsk(); return; }
    if (e.key === "ArrowUp" && hist.length) {
      e.preventDefault();
      if (histIdx === -1) histDraft = askInput.value;
      histIdx = Math.min(hist.length - 1, histIdx + 1);
      askInput.value = hist[histIdx];
      return;
    }
    if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      histIdx -= 1;
      askInput.value = histIdx === -1 ? histDraft : hist[histIdx];
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      if (body.classList.contains("ask-picking")) closeAskMenu();
      else if (askInput.value) { askInput.value = ""; histIdx = -1; }
      else setOpen(false);
    }
  });
  // o chip não tira o foco do campo
  $("#ask-folder").addEventListener("mousedown", (e) => { e.preventDefault(); post("grabFocus"); });
  $("#ask-folder").addEventListener("click", () => {
    if (body.classList.contains("ask-picking")) closeAskMenu(); else openAskMenu();
  });
  $("#ask-folders").addEventListener("mousedown", (e) => e.preventDefault());
  $("#ask-folders").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-cwd]");
    if (!li) return;
    askCwd = { cwd: li.dataset.cwd, project: li.dataset.project, short: li.dataset.short };
    closeAskMenu();
    renderAskBar();
    askInput.focus();
  });
  $("#ask-pick").addEventListener("click", () => { closeAskMenu(); post("askPickFolder"); });
  $("#ask-stop").addEventListener("click", () => post("askStop"));
  $("#ans-close").addEventListener("click", () => { post("askClear"); if (!bridge) window.dockAsk(null); askInput.focus(); });
  $("#ans-actions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ask]");
    if (!b) return;
    const what = b.dataset.ask;
    if (what === "resume") act("askResume", {}, null);
    else if (what === "copy") {
      post("askCopy");
      b.classList.add("done");
      b.querySelector("span").textContent = t("askCopied");
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { b.classList.remove("done"); b.querySelector("span").textContent = t("askCopy"); }, 1400);
    } else if (what === "new") {
      post("askClear");
      if (!bridge) window.dockAsk(null);
      post("grabFocus");
      askInput.focus();
    }
  });

  window.dockAsk = (snap) => {
    const had = !!ask;
    ask = snap;
    renderAskBar();
    renderAnswer();
    if (open && had !== !!ask && document.hasFocus()) focusAsk();
  };
  // atalho global (ou `claude-dock --ask`): abre já com o cursor no campo
  window.dockAskOpen = () => {
    clearTimeout(closeTimer);
    closeSheet();
    setOpen(true);
    requestAnimationFrame(focusAsk);
    setTimeout(focusAsk, 120);   // a janela pode ganhar o foco do X um pouco depois
  };
  // notificação "Resumo de hoje pronto" -> Ver
  window.dockSumOpen = () => {
    clearTimeout(closeTimer);
    closeSheet();
    setOpen(true);
    if (sumOn()) { body.classList.add("sum"); sumKey = ""; renderSum(); }
  };
  window.dockAskFolder = (f) => { askCwd = f; renderAskBar(); askInput.focus(); };

  window.dockUpdate = (data) => {
    state = data;
    applyStatic();
    renderUpdate();
    renderUsage();
    renderIsland();
    renderSummary();
    renderLive();
    renderHistory();
    renderFolders();
    renderAskBar();
    renderSum();
    if (ask) renderAnswer();
    $("#see-all-sub").textContent = t("seeAllSub");
    fitHeight();
  };

  setInterval(() => { if (open) renderHistory(); }, 30000);
  setInterval(() => {
    if (!open) return;
    $$(".elapsed").forEach((el) => { el.textContent = elapsed(Number(el.dataset.since)); });
    $$("[data-done]").forEach((el) => { el.textContent = doneAgo(Number(el.dataset.done)); });
    renderUsageFoot();
  }, 1000);

  // teclado: a janela só recebe foco quando a busca é clicada
  $("#search").addEventListener("mousedown", () => post("grabFocus"));

  window.dockDebugOpen = (t) => {
    requestOpen();
    if (t === "recent" || t === "live") setTimeout(() => setTab(t), 300);
    if (t === "sheet") setTimeout(openSheet, 300);
    if (t === "settings") post("openSettings");
    if (t === "applyUpdate") setTimeout(() => post("applyUpdate"), 300);
    if (t && t.startsWith("q:")) setTimeout(() => { setTab("recent"); $("#search").value = t.slice(2); renderHistory(); fitHeight(); }, 300);
    if (t === "focus") setTimeout(() => { setTab("recent"); post("grabFocus"); $("#search").focus(); }, 400);
    if (t === "focus") setTimeout(() => setOpen(false), 1800);
  };

  // ------------------------------------------- pré-visualização no navegador
  // abre ui/index.html?lang=en&view=recent&q=api num navegador (usado pros prints do README)
  if (!bridge && window.dockDemo) {
    const params = new URLSearchParams(location.search);
    const demo = window.dockDemo(params.get("lang") || "en");
    if (params.get("update")) demo.update = { available: true, current: "1.0.0", latest: "1.1.0", url: "https://github.com/krugerrgabriel/claude-dock/releases", method: "installer" };
    window.dockUpdate(demo);
    const view = params.get("view");
    if (params.get("closed") === null) setOpen(true);
    if (view === "recent") setTab("recent");
    if (view === "sheet") openSheet();
    if (view === "summary") openSum();
    if (view === "summary-wait") { state.summary = { status: "running", at: Date.now() / 1000 }; body.classList.add("sum"); renderSum(); }
    if (params.get("q")) { setTab("recent"); $("#search").value = params.get("q"); renderHistory(); fitHeight(); }
    window.dockDemoOpen = (v) => setOpen(v);
    // ?ask=stream (transmite), ?ask=running (parado no meio), ?ask=done, ?ask=focus (campo focado)
    const askView = params.get("ask");
    if (askView === "focus") { askInput.focus(); if (params.get("text")) askInput.value = params.get("text"); }
    else if (askView === "menu") { askInput.focus(); openAskMenu(); }
    else if (askView) demoAsk(null, askView);
    if (params.get("askUnseen")) { state.ask.unseen = true; renderAskBar(); setOpen(false); }
  }

  // prévia: finge o resumo sendo escrito e pronto um instante depois
  function demoSum() {
    if (!window.dockSumDemo) return;
    state.summary = { status: "running", at: Date.now() / 1000 };
    renderSum();
    setTimeout(() => { state.summary = { status: "done", at: Date.now() / 1000, text: window.dockSumDemo(state.lang) }; renderSum(); }, 900);
  }

  // prévia: finge um pedido rodando, com ferramentas e texto chegando aos pedaços
  function demoAsk(prompt, mode = "stream") {
    if (!window.dockAskDemo) return;
    const d = window.dockAskDemo(state.lang, prompt);
    const snap = { ...d, items: [] };
    delete snap.tools; delete snap.text;
    const finish = () => {
      snap.items = [...d.tools, { kind: "text", text: d.text }];
      snap.status = "done"; snap.streaming = false; snap.endedAt = snap.startedAt + 14;
      window.dockAsk({ ...snap });
    };
    if (mode === "done") { finish(); return; }
    if (mode === "running") {
      // para no meio do último tópico, depois do negrito fechado (senão aparece "**" solto)
      snap.items = [...d.tools, { kind: "text", text: d.text.slice(0, d.text.indexOf(":", d.text.lastIndexOf("\n- ")) + 1) }];
      snap.streaming = true;
      window.dockAsk({ ...snap });
      return;
    }
    snap.startedAt = Date.now() / 1000;
    window.dockAsk({ ...snap });
    let step = 0, pos = 0;
    const timer = setInterval(() => {
      if (step < d.tools.length) { snap.items = [...snap.items, d.tools[step++]]; window.dockAsk({ ...snap }); return; }
      pos = Math.min(d.text.length, pos + 9);
      snap.items = [...d.tools, { kind: "text", text: d.text.slice(0, pos) }];
      snap.streaming = true;
      if (pos >= d.text.length) { clearInterval(timer); snap.endedAt = Date.now() / 1000; finish(); return; }
      window.dockAsk({ ...snap });
    }, 45);
  }

  post("ready");
})();
