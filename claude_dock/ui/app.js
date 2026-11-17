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
    let h = contentH + $(".views").offsetTop;
    if (body.classList.contains("sheet")) h = Math.max(h, $("#sheet").scrollHeight + 90);
    if (body.classList.contains("settings")) h = Math.max(h, $("#settings").scrollHeight + 16);
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
      if (!userPickedTab) setTab(state.live.length ? "live" : "recent", false);
      fitHeight();
      sendShape();
      playUsage();
    } else {
      closeSheet();
      $("#search").blur();
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

  $("#panel").addEventListener("mouseenter", () => clearTimeout(closeTimer));
  $("#panel").addEventListener("mouseleave", () => {
    if (document.activeElement === $("#search") && $("#search").value) return;
    closeTimer = setTimeout(() => setOpen(false), CLOSE_DELAY);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (body.classList.contains("sheet") || body.classList.contains("settings")) closeSheet(); else setOpen(false);
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
  function closeSheet() { body.classList.remove("sheet", "settings"); fitHeight(); }
  $("#new").addEventListener("click", openSheet);
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#scrim").addEventListener("click", closeSheet);
  $("#pick").addEventListener("click", (e) => act("pickFolder", {}, e.currentTarget));
  $("#folders").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-cwd]");
    if (li) act("new", { cwd: li.dataset.cwd }, li);
  });

  // --------------------------------------------------------------- render

  function renderIsland() {
    $("#dots").innerHTML = state.live.slice(0, 10)
      .map((s) => `<span class="dot ${statusClass(s.status)}"></span>`).join("");
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
    box.innerHTML = `<ul class="group">${state.live.map((s) => {
      const c = statusClass(s.status);
      const trail = c === "busy"
        ? `<span class="elapsed" data-since="${s.statusSince}">${elapsed(s.statusSince)}</span><span class="spinner" title="${t("workingTip")}"></span>`
        : c === "idle"
          ? `<span class="badge idle">${t("free")}</span>`
          : `<span class="badge other">${t("waitingBadge")}</span>`;
      return `
        <li class="row" data-pid="${s.pid}" title="${esc(s.title || t("untitled"))}">
          ${hostTile(s.host)}
          <div class="row-text">
            <div class="row-title">${esc(s.title || t("untitled"))}</div>
            <div class="row-sub">${esc(s.project)} · ${esc(s.host.label)}</div>
          </div>
          <div class="trail">${trail}</div>
        </li>`;
    }).join("")}</ul>`;
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
    if (li) act("resume", { sessionId: li.dataset.sid, cwd: li.dataset.cwd }, li);
  });
  $("#search").addEventListener("input", () => { renderHistory(); fitHeight(); });

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

  // ------------------------------------------------------ configurações
  const SETTINGS = [
    { title: "setDock", items: [
      ["islandUsage", "setIsland", "setIslandHint"],
    ] },
    { title: "setPanel", items: [
      ["usage.plan", "setPlan", "setPlanHint"],
      ["usage.rings", "setRings", "setRingsHint"],
      ["usage.session", "setSession", "setSessionHint"],
      ["usage.week", "setWeek", "setWeekHint"],
      ["usage.paceMarker", "setPace", "setPaceHint"],
      ["usage.resetTime", "setReset", "setResetHint"],
      ["usage.models", "setModels", "setModelsHint"],
      ["usage.spent", "setSpent", "setSpentHint"],
    ] },
  ];
  function getCfg(key) {
    const [a, b] = key.split(".");
    const c = state.config || {};
    const v = b ? (c[a] || {})[b] : c[a];
    if (v === undefined) return b ? usageCfg()[b] : true;
    return v !== false;
  }
  function setCfg(key, value) {
    const [a, b] = key.split(".");
    state.config = state.config || {};
    if (b) state.config[a] = { ...(state.config[a] || {}), [b]: value };
    else state.config[a] = value;
    post("setConfig", { key, value });
    renderSettings();
    renderUsage(true);
  }
  function renderSettings() {
    const langNow = (state.config && state.config.language) || "auto";
    const langs = [["auto", t("langAuto")], ["en", "English"], ["pt", "Português"]];
    $("#settings-body").innerHTML = SETTINGS.map((sec) => `
      <div class="section-title">${t(sec.title)}</div>
      <ul class="group">${sec.items.map(([key, label, hint]) => `
        <li class="toggle-row" data-key="${key}">
          <div class="toggle-text"><b>${t(label)}</b><span>${t(hint)}</span></div>
          <span class="switch ${getCfg(key) ? "on" : ""}"></span>
        </li>`).join("")}</ul>`).join("") + `
      <div class="section-title">${t("setLanguage")}</div>
      <div class="seg lang-seg" style="--n:${langs.length}">${langs.map(([v, label]) =>
        `<button data-lang="${v}" class="${v === langNow ? "on" : ""}">${label}</button>`).join("")}</div>`;
  }
  $("#settings-body").addEventListener("click", (e) => {
    const row = e.target.closest(".toggle-row");
    if (row) setCfg(row.dataset.key, !getCfg(row.dataset.key));
    const lb = e.target.closest("[data-lang]");
    if (lb) setCfg("language", lb.dataset.lang);
  });
  function openSettings() { renderSettings(); body.classList.add("settings"); fitHeight(); }
  function closeSettings() { body.classList.remove("settings"); fitHeight(); }
  $("#u-settings").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
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
      rows.push(statRow({ name: t("sessionRow"), pct: u.session.pct, kind: "session", resetsAt: u.session.resetsAt, pace: f }));
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

  window.dockUpdate = (data) => {
    state = data;
    applyStatic();
    if (body.classList.contains("settings")) renderSettings();
    renderUsage();
    renderIsland();
    renderSummary();
    renderLive();
    renderHistory();
    renderFolders();
    fitHeight();
  };

  setInterval(() => { if (open) renderHistory(); }, 30000);
  setInterval(() => {
    if (!open) return;
    $$(".elapsed").forEach((el) => { el.textContent = elapsed(Number(el.dataset.since)); });
    renderUsageFoot();
  }, 1000);

  // teclado: a janela só recebe foco quando a busca é clicada
  $("#search").addEventListener("mousedown", () => post("grabFocus"));

  window.dockDebugOpen = (t) => {
    requestOpen();
    if (t === "recent" || t === "live") setTimeout(() => setTab(t), 300);
    if (t === "sheet") setTimeout(openSheet, 300);
    if (t === "settings") setTimeout(openSettings, 300);
    if (t && t.startsWith("q:")) setTimeout(() => { setTab("recent"); $("#search").value = t.slice(2); renderHistory(); fitHeight(); }, 300);
    if (t === "focus") setTimeout(() => { setTab("recent"); post("grabFocus"); $("#search").focus(); }, 400);
    if (t === "focus") setTimeout(() => setOpen(false), 1800);
  };

  // ------------------------------------------- pré-visualização no navegador
  // abre ui/index.html?lang=en&view=recent&q=api num navegador (usado pros prints do README)
  if (!bridge && window.dockDemo) {
    const params = new URLSearchParams(location.search);
    window.dockUpdate(window.dockDemo(params.get("lang") || "en"));
    const view = params.get("view");
    if (params.get("closed") === null) setOpen(true);
    if (view === "recent") setTab("recent");
    if (view === "sheet") openSheet();
    if (view === "settings") openSettings();
    if (params.get("q")) { setTab("recent"); $("#search").value = params.get("q"); renderHistory(); fitHeight(); }
    window.dockDemoOpen = (v) => setOpen(v);
  }

  post("ready");
})();
