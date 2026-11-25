(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.settings;
  const post = (type, extra = {}) => bridge && bridge.postMessage(JSON.stringify({ type, ...extra }));

  let data = { config: {}, lang: "en", terminals: [], folders: [] };
  let section = "general";
  let recording = false;
  let testSentAt = 0;

  // ------------------------------------------------------------------ i18n
  const DICT = window.SET_I18N;
  const T = () => DICT[data.lang] || DICT.en;
  function t(key, vars) {
    let s = T()[key] ?? DICT.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
    return s;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

  // ---------------------------------------------------------- configuração
  // mesmos padrões do DEFAULT_CONFIG do app.py
  const DEFAULTS = {
    language: "auto", clickAction: "open", terminal: null, islandUsage: true, checkUpdates: true,
    usage: { plan: true, rings: true, session: true, week: true, paceMarker: true, resetTime: true, models: false, spent: false },
    notify: { waiting: true, done: true, forgotten: true, forgottenHours: 2, limit: true, sound: false },
    ask: { shortcut: "<Control><Alt>space", mode: "read", cwd: "auto", model: "auto" },
    recap: { mode: "simple" },
    summary: { enabled: true },
  };
  function get(key) {
    const [a, b] = key.split(".");
    const c = data.config || {};
    const v = b ? (c[a] || {})[b] : c[a];
    if (v !== undefined) return v;
    return b ? (DEFAULTS[a] || {})[b] : DEFAULTS[a];
  }
  function set(key, value) {
    const [a, b] = key.split(".");
    data.config = data.config || {};
    if (b) data.config[a] = { ...(data.config[a] || {}), [b]: value };
    else data.config[a] = value;
    if (key === "language" && value !== "auto") { data.lang = value; applyStatic(true); }
    post("setConfig", { key, value });
    render();
  }

  // --------------------------------------------------------------- blocos
  const toggle = (key, label, hint, extra = "") => `
    <li class="row toggle" data-toggle="${key}">
      <div class="row-text"><b>${label}</b>${hint ? `<span>${hint}</span>` : ""}</div>
      <span class="switch ${get(key) ? "on" : ""}" role="switch" aria-checked="${!!get(key)}"></span>
    </li>${extra}`;

  const seg = (key, opts, cur = get(key), cls = "") => `
    <div class="seg ${cls}" style="--n:${opts.length}">${opts.map(([v, label]) =>
      `<button data-key="${key}" data-value='${esc(JSON.stringify(v))}' class="${v === cur ? "on" : ""}">${label}</button>`).join("")}</div>`;

  // rótulo à esquerda, controle compacto à direita
  const inline = (label, hint, control) => `
    <li class="row">
      <div class="row-text"><b>${label}</b>${hint ? `<span>${hint}</span>` : ""}</div>
      <div class="row-ctl">${control}</div>
    </li>`;

  // rótulo em cima, controle largo e uma explicação que muda com a escolha
  const stacked = (label, control, hint, hintCls = "") => `
    <li class="row stacked">
      <div class="row-text"><b>${label}</b></div>
      ${control}
      ${hint ? `<p class="hint ${hintCls}">${hint}</p>` : ""}
    </li>`;

  const select = (key, opts, cur) => `
    <label class="select">
      <select data-select="${key}">${opts.map(([v, label]) =>
        `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
      ${icon("chev")}
    </label>`;

  const group = (rows, title = "") => `${title ? `<div class="group-title">${title}</div>` : ""}<ul class="group">${rows.join("")}</ul>`;

  // ---------------------------------------------------------------- seções
  const SECTIONS = ["general", "alerts", "ask", "intelligence", "usage", "sessions"];
  const CLICKS = ["open", "copyCli", "copySlash"];

  function general() {
    const lang = get("language");
    const click = CLICKS.includes(get("clickAction")) ? get("clickAction") : "open";
    const auto = data.autoTerminal && (data.terminals.find((x) => x.id === data.autoTerminal) || {}).label;
    const terms = [["", auto ? t("termAuto", { name: auto }) : t("termAutoNone")], ...data.terminals.map((x) => [x.id, x.label])];
    const term = get("terminal") || "";
    return [
      group([inline(t("g_language"), "", seg("language", [["auto", t("langAuto")], ["en", "English"], ["pt", "Português"]], lang, "compact"))]),
      group([stacked(t("g_click"), seg("clickAction", CLICKS.map((m) => [m, t(`c_${m}`)]), click), t(`c_${click}Hint`))]),
      group([
        inline(t("g_terminal"), t("g_terminalHint"), select("terminal", terms, term)),
      ]),
      group([
        toggle("islandUsage", t("g_island"), t("g_islandHint")),
        toggle("checkUpdates", t("g_updates"), t("g_updatesHint")),
      ]),
    ].join("");
  }

  function alerts() {
    const h = get("notify.forgottenHours");
    const after = get("notify.forgotten") ? `
      <li class="row sub">
        <div class="row-text"><b>${t("a_after")}</b></div>
        <div class="row-ctl">${seg("notify.forgottenHours", [1, 2, 4].map((n) => [n, t("hours", { n })]), h, "compact")}</div>
      </li>` : "";
    const sent = Date.now() - testSentAt < 6000;
    return [
      data.notifyOk === false ? `<div class="note warn">${icon("warn")}<span>${t("a_unavailable")}</span></div>` : "",
      group([
        toggle("notify.waiting", t("a_waiting"), t("a_waitingHint")),
        toggle("notify.done", t("a_done"), t("a_doneHint")),
        toggle("notify.forgotten", t("a_forgotten"), t("a_forgottenHint", { h }), after),
        toggle("notify.limit", t("a_limit"), t("a_limitHint")),
      ]),
      group([toggle("notify.sound", t("a_sound"), t("a_soundHint"))]),
      `<div class="actions"><button class="btn" id="test-alert" ${data.notifyOk === false ? "disabled" : ""}>${icon("bell")}${t("a_test")}</button>
        <span class="sent ${sent ? "on" : ""}">${t("a_testSent")}</span></div>`,
    ].join("");
  }

  // "<Control><Alt>space" -> ["Ctrl", "Alt", "Espaço"]
  const MOD_LABEL = { Control: "Ctrl", Primary: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Super", Meta: "Super" };
  function keycaps(accel) {
    const mods = [...accel.matchAll(/<(\w+)>/g)].map((m) => MOD_LABEL[m[1]] || m[1]);
    let key = accel.replace(/<\w+>/g, "");
    const names = { space: data.lang === "pt" ? "Espaço" : "Space", Return: "Enter", grave: "`", minus: "-", equal: "=", comma: ",", period: ".", slash: "/", semicolon: ";", apostrophe: "'", bracketleft: "[", bracketright: "]", backslash: "\\", Up: "↑", Down: "↓", Left: "←", Right: "→" };
    key = names[key] || (key.length === 1 ? key.toUpperCase() : key);
    return [...mods, key];
  }

  function ask() {
    const sc = get("ask.shortcut");
    const off = sc === "off";
    const caps = recording
      ? `<span class="rec">${t("q_recording")}</span>`
      : off ? `<span class="muted">${t("q_disabled")}</span>`
        : keycaps(sc).map((k) => `<kbd>${esc(k)}</kbd>`).join(`<i class="plus">+</i>`);
    const shortcut = `
      <li class="row stacked">
        <div class="row-text"><b>${t("q_shortcut")}</b><span>${recording ? t("q_recHint") : t("q_shortcutHint")}</span></div>
        <div class="shortcut ${recording ? "recording" : ""}">
          <div class="keys">${caps}</div>
          <div class="sc-btns">
            ${recording ? "" : `<button class="btn small" id="sc-change">${off ? t("q_set") : t("q_change")}</button>`}
            ${!recording && !off ? `<button class="btn small ghost" id="sc-off">${t("q_off")}</button>` : ""}
          </div>
        </div>
      </li>`;
    const mode = get("ask.mode");
    const model = get("ask.model");
    const cwd = get("ask.cwd");
    const folders = (data.folders || []).map((f) => [f.cwd, f.short]);
    if (cwd !== "auto" && !folders.some(([v]) => v === cwd)) folders.unshift([cwd, cwd.replace(data.home || "\u0000", "~")]);
    const cwdOpts = [["auto", t("q_cwdAuto")], ...folders, ["__pick", t("q_cwdPick")]];
    return [
      group([shortcut]),
      group([stacked(t("q_mode"), seg("ask.mode", [["read", t("m_read")], ["edit", t("m_edit")], ["full", t("m_full")]], mode),
        (mode === "full" ? icon("warn") : "") + t(`m_${mode}Hint`), mode === "full" ? "warn" : "")]),
      group([
        inline(t("q_cwd"), cwd === "auto" ? t("q_cwdAutoHint") : t("q_cwdFixedHint"), select("ask.cwd", cwdOpts, cwd)),
        stacked(t("q_model"), seg("ask.model", [["auto", t("md_auto")], ["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"]], model), t(`md_${model}Hint`)),
      ]),
    ].join("");
  }

  function intelligence() {
    const recap = get("recap.mode");
    return [
      `<div class="note">${icon("info")}<span>${t("i_note")}</span></div>`,
      group([stacked(t("i_recap"), seg("recap.mode", [["simple", t("r_simple")], ["ai", t("r_ai")], ["off", t("r_off")]], recap), t(`r_${recap}Hint`))]),
      group([toggle("summary.enabled", t("i_summary"), t("i_summaryHint"))]),
    ].join("");
  }

  const USAGE_ITEMS = [
    ["usage.plan", "u_plan"], ["usage.rings", "u_rings"], ["usage.session", "u_session"], ["usage.week", "u_week"],
    ["usage.paceMarker", "u_pace"], ["usage.resetTime", "u_reset"], ["usage.models", "u_models"], ["usage.spent", "u_spent"],
  ];
  function usagePanel() {
    return `
      <div class="usage-layout">
        <div class="usage-toggles">${group(USAGE_ITEMS.map(([k, l]) => toggle(k, t(l), t(`${l}Hint`))))}</div>
        <div class="usage-preview">
          <div class="pv" id="pv"><div class="pv-label">${t("u_preview")}</div>${preview()}</div>
        </div>
      </div>`;
  }

  function sessionsPanel() {
    const cur = data.autoTrashDays || 0;
    const AUTO = [0, 30, 60, 90];
    const opts = (AUTO.includes(cur) ? AUTO : [...AUTO, cur].sort((a, b) => a - b))
      .map((d) => [d, d ? t("s_days", { n: d }) : t("s_off")]);
    const store = data.shared
      ? `${t("s_storeShared")}${data.managerUrl ? `<button class="link" id="open-manager">${t("s_openManager")}</button>` : ""}`
      : t("s_storeOwn");
    return [
      group([stacked(t("s_autoTrash"), seg("autoTrash", opts, cur), cur ? t("s_autoHint", { n: cur }) : t("s_autoHintOff"))]),
      group([`
        <li class="row stacked">
          <div class="row-text"><b>${t("s_storage")}</b></div>
          <div class="store"><span class="dot ${data.shared ? "on" : ""}"></span><b>${t(data.shared ? "s_syncOn" : "s_syncOff")}</b></div>
          <p class="hint">${store}</p>
        </li>`]),
    ].join("");
  }

  // ------------------------------------------------------ prévia do uso
  const SEV = (p) => (p >= 90 ? "crit" : p >= 70 ? "warn" : "");
  const GRAD = { session: ["#ff9f5a", "#ff5e8a"], week: ["#34d399", "#5ac8fa"], model: ["#bf5af2", "#7d7aff"] };
  const SEV_COLOR = { warn: ["#ffd60a", "#ff9f0a"], crit: ["#ff6b5a", "#ff2d55"] };
  const SPENT_COLORS = ["#ff9f5a", "#bf5af2", "#5ac8fa", "#34d399", "#ffd60a"];
  const colorsFor = (kind, pct) => SEV_COLOR[SEV(pct)] || GRAD[kind];
  const grad = (c) => `linear-gradient(90deg, ${c[0]}, ${c[1]})`;
  function until(iso) {
    const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
    if (d) return t("inDH", { d, h });
    if (h) return t("inHM", { h, m: String(m).padStart(2, "0") });
    return t("inM", { m: Math.max(1, m) });
  }
  function frac(resetsAt, startedAt, spanH) {
    const end = Date.parse(resetsAt);
    const start = startedAt ? Date.parse(startedAt) : end - spanH * 3600000;
    return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
  }
  function ringsSvg(rings) {
    const size = 112, stroke = 10, gap = 3, c0 = size / 2;
    let defs = "", out = "";
    rings.forEach((r, i) => {
      const rad = c0 - stroke / 2 - i * (stroke + gap);
      const circ = 2 * Math.PI * rad;
      const off = circ * (1 - Math.min(100, r.pct) / 100);
      defs += `<linearGradient id="pg${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${r.c[0]}"/><stop offset="1" stop-color="${r.c[1]}"/></linearGradient>`;
      out += `<circle cx="${c0}" cy="${c0}" r="${rad}" fill="none" stroke="${r.c[0]}" stroke-opacity=".17" stroke-width="${stroke}"/>
        <circle cx="${c0}" cy="${c0}" r="${rad}" fill="none" stroke="url(#pg${i})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${off}"/>`;
    });
    return `<svg viewBox="0 0 ${size} ${size}"><defs>${defs}</defs>${out}</svg>`;
  }
  function statRow(name, pct, kind, resetsAt, pace) {
    const c = colorsFor(kind, pct);
    return `<li class="stat" style="--g:${grad(c)}">
      <div class="stat-top"><span class="stat-name"><i></i>${esc(name)}</span><span class="stat-pct ${SEV(pct)}">${pct}%</span></div>
      <div class="bar"><b style="width:${Math.min(100, pct)}%"></b>${pace != null ? `<span class="pace" style="left:${(pace * 100).toFixed(1)}%"></span>` : ""}</div>
      ${get("usage.resetTime") && resetsAt ? `<div class="stat-sub">${t("pv_resets", { when: until(resetsAt) })}</div>` : ""}
    </li>`;
  }
  function preview() {
    const u = data.usage;
    if (!u || (!u.session && !u.week)) return `<div class="pv-empty">${t("u_noData")}</div>`;
    const on = (k) => !!get(`usage.${k}`);
    const main = u.session ? { ...u.session, tag: "5h" } : { ...u.week, tag: "week" };
    const rings = [];
    if (u.session) rings.push({ pct: u.session.pct, c: colorsFor("session", u.session.pct) });
    if (u.week) rings.push({ pct: u.week.pct, c: colorsFor("week", u.week.pct) });
    const rows = [];
    if (u.session && on("session")) rows.push(statRow(t("pv_session"), u.session.pct, "session", u.session.resetsAt, on("paceMarker") ? frac(u.session.resetsAt, null, 5) : null));
    if (u.week && on("week")) rows.push(statRow(t("pv_week"), u.week.pct, "week", u.week.resetsAt, on("paceMarker") ? frac(u.week.resetsAt, u.weekStartedAt, 168) : null));
    const models = on("models") ? (u.models || []).map((m) => statRow(t("pv_weekOf", { name: m.name }), m.pct, "model", m.resetsAt)) : [];
    const spent = on("spent") ? u.spent || [] : [];
    const html = `
      ${on("plan") && u.plan ? `<div class="pv-plan"><span class="plan">${esc(u.plan)}</span></div>` : ""}
      ${on("rings") && rings.length ? `<div class="pv-rings">${ringsSvg(rings)}<div class="pv-center"><b>${main.pct}<small>%</small></b><span>${main.tag === "5h" ? t("pv_ofSession") : t("pv_ofWeek")}</span></div></div>` : ""}
      ${rows.length ? `<ul class="pv-group">${rows.join("")}</ul>` : ""}
      ${models.length ? `<ul class="pv-group">${models.join("")}</ul>` : ""}
      ${spent.length ? `<div class="pv-title">${t("pv_spent")}</div><div class="pv-group pv-spent">
        <div class="stack">${spent.map((s, i) => `<span style="flex-grow:${s.pct};background:${SPENT_COLORS[i % SPENT_COLORS.length]}"></span>`).join("")}</div>
        <div class="legend">${spent.map((s, i) => `<span><i style="background:${SPENT_COLORS[i % SPENT_COLORS.length]}"></i>${esc(s.name)} <b>${s.pct}%</b></span>`).join("")}</div></div>` : ""}`;
    return html.trim() ? html : `<div class="pv-empty">${t("pv_nothing")}</div>`;
  }

  // ---------------------------------------------------------------- render
  const BUILD = { general, alerts, ask, intelligence, usage: usagePanel, sessions: sessionsPanel };

  let staticLang = null;
  function applyStatic(force = false) {
    if (!force && staticLang === data.lang) return;
    staticLang = data.lang;
    document.documentElement.lang = T().locale;
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  }

  function renderNav() {
    $("#nav").innerHTML = SECTIONS.map((id) => `
      <button class="nav ${id === section ? "on" : ""}" data-section="${id}">
        <span class="tile t-${id}">${icon(id)}</span><span class="nav-label">${t(`nav_${id}`)}</span>
      </button>`).join("");
    $("#side-sub").textContent = t("autosave");
    $("#side-foot").textContent = data.version ? t("version", { v: data.version }) : "";
  }

  function render() {
    applyStatic();
    renderNav();
    const scroll = $("#main").scrollTop;
    $("#page").innerHTML = `
      <header class="page-head">
        <h2>${t(`nav_${section}`)}</h2>
        <p>${t(`sub_${section}`)}</p>
      </header>
      ${BUILD[section]()}`;
    $("#main").scrollTop = scroll;
  }

  function setSection(id) {
    if (!SECTIONS.includes(id)) return;
    if (id !== section) { section = id; recording = false; $("#main").scrollTop = 0; }
    render();
    const nav = $(`.nav[data-section="${id}"]`);
    if (nav) nav.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  window.setSection = setSection;

  // ---------------------------------------------------------------- eventos
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest("[data-section]");
    if (b) setSection(b.dataset.section);
  });

  $("#page").addEventListener("click", (e) => {
    const tg = e.target.closest("[data-toggle]");
    if (tg) { set(tg.dataset.toggle, !get(tg.dataset.toggle)); return; }
    const sb = e.target.closest("[data-key]");
    if (sb) {
      const value = JSON.parse(sb.dataset.value);
      if (sb.dataset.key === "autoTrash") { data.autoTrashDays = value; post("autoTrash", { days: value }); render(); return; }
      if (get(sb.dataset.key) !== value) set(sb.dataset.key, value);
      return;
    }
    if (e.target.closest("#test-alert")) { testSentAt = Date.now(); post("testAlert"); render(); setTimeout(render, 6100); return; }
    if (e.target.closest("#sc-change")) { recording = true; render(); return; }
    if (e.target.closest("#sc-off")) { set("ask.shortcut", "off"); return; }
    if (e.target.closest("#open-manager")) post("openManager");
  });

  $("#page").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-select]");
    if (!sel) return;
    const key = sel.dataset.select;
    if (key === "terminal") { set("terminal", sel.value || null); return; }
    if (key === "ask.cwd") {
      if (sel.value === "__pick") { sel.value = get("ask.cwd"); post("pickFolder"); return; }
      set("ask.cwd", sel.value);
    }
  });

  // gravação do atalho: formato de acelerador do GTK ("<Control><Alt>space")
  const CODE_KEYS = {
    Space: "space", Enter: "Return", Tab: "Tab", Backquote: "grave", Minus: "minus", Equal: "equal", Comma: "comma",
    Period: "period", Slash: "slash", Semicolon: "semicolon", Quote: "apostrophe", BracketLeft: "bracketleft",
    BracketRight: "bracketright", Backslash: "backslash", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Home: "Home", End: "End", PageUp: "Page_Up", PageDown: "Page_Down", Insert: "Insert", Delete: "Delete",
  };
  function keyName(e) {
    const c = e.code || "";
    if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
    if (/^Digit\d$/.test(c)) return c.slice(5);
    if (/^F\d{1,2}$/.test(c)) return c;
    return CODE_KEYS[c] || null;
  }
  document.addEventListener("keydown", (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { recording = false; render(); return; }
    const key = keyName(e);
    if (!key) return; // só modificador por enquanto: espera a tecla
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return; // precisa de Ctrl, Alt ou Super
    const accel = `${e.ctrlKey ? "<Control>" : ""}${e.altKey ? "<Alt>" : ""}${e.shiftKey ? "<Shift>" : ""}${e.metaKey ? "<Super>" : ""}${key}`;
    recording = false;
    set("ask.shortcut", accel);
  }, true);
  window.addEventListener("blur", () => { if (recording) { recording = false; render(); } });

  // ------------------------------------------------------------------ dados
  window.settingsUpdate = (d) => {
    data = d;
    render();
  };

  // prévia no navegador: settings.html?lang=pt&section=alerts
  if (!bridge && window.settingsDemo) {
    const params = new URLSearchParams(location.search);
    window.settingsUpdate(window.settingsDemo(params.get("lang") || "en"));
    if (params.get("section")) setSection(params.get("section"));
    if (params.get("recording")) { recording = true; render(); }
  }

  post("ready");
})();
