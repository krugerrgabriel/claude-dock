(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lib;
  const post = (type, data = {}) => bridge && bridge.postMessage(JSON.stringify({ type, ...data }));
  const body = document.body;

  let data = { items: [], live: {}, lang: "en", prefs: {} };
  const ui = {
    filter: "all", project: null, q: "",
    sort: "recent", collapsed: new Set(),
    selected: new Set(), lastPicked: null,
    hits: {}, hitsQ: "", searching: false, gen: 0,
    editing: null, prefsLoaded: false,
  };

  // ----------------------------------------------------------------- i18n
  const DICT = window.LIB_I18N;
  const T = () => DICT[data.lang] || DICT.en;
  function t(key, vars) {
    let s = T()[key] ?? DICT.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
    return s;
  }
  let staticLang = null;
  function applyStatic() {
    if (staticLang === data.lang) return;
    staticLang = data.lang;
    document.documentElement.lang = T().locale;
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $$("[data-i18n-ph]").forEach((el) => el.setAttribute("placeholder", t(el.dataset.i18nPh)));
  }

  // ----------------------------------------------------------------- util
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // ícones inline em vez de <use>: no WebKit cada <use> clona uma árvore escondida,
  // e com centenas de ícones na grade isso pesava no estilo/layout e na rolagem
  const ICONS = {};
  document.querySelectorAll("symbol[id^='i-']").forEach((sym) => {
    ICONS[sym.id.slice(2)] = `<svg viewBox="${sym.getAttribute("viewBox")}">${sym.innerHTML}</svg>`;
  });
  const icon = (id) => ICONS[id] || `<svg><use href="#i-${id}"/></svg>`;
  const statusClass = (st) => (st === "idle" ? "idle" : st === "waiting" ? "other" : "busy");
  const statusLabel = (c) => (c === "idle" ? t("free") : c === "other" ? t("waiting") : t("working"));

  function hue(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
  }
  function projectTile(name, cls = "") {
    const h = hue(name || "~");
    const letter = (name || "~").replace(/^[^a-zA-Z0-9]+/, "").charAt(0).toUpperCase() || "~";
    return `<span class="tile ${cls}" style="background:linear-gradient(160deg,hsl(${h} 62% 58%),hsl(${(h + 28) % 360} 58% 40%))">${esc(letter)}</span>`;
  }
  function hostTile(host) {
    const kind = (host && host.kind) || "unknown";
    if (kind === "ghostty") return `<span class="tile sm t-ghostty">${icon("ghostty")}</span>`;
    if (kind === "jetbrains") {
      const caps = (host.label.match(/[A-Z]/g) || []).join("").slice(0, 2) || host.label.slice(0, 2);
      return `<span class="tile sm t-jetbrains">${esc(caps)}</span>`;
    }
    return `<span class="tile sm t-${esc(kind)}">${icon("term")}</span>`;
  }

  function ago(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return t("now");
    if (s < 3600) return t("min", { n: Math.floor(s / 60) });
    if (s < 86400) return t("hours", { n: Math.floor(s / 3600) });
    const d = new Date(ts * 1000);
    const yest = new Date(); yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return t("yesterday");
    const opts = { year: d.getFullYear() !== new Date().getFullYear() };
    return fmt(opts.year ? "dateY" : "date").format(d).replace(".", "");
  }
  // formatadores criados uma vez por idioma: toLocaleString cria um novo a cada
  // chamada e isso, vezes cem cards, era o grosso do tempo de montar a grade
  const FMT_OPTS = {
    date: { day: "numeric", month: "short" },
    dateY: { day: "numeric", month: "short", year: "numeric" },
    full: { dateStyle: "medium", timeStyle: "short" },
  };
  const fmtCache = new Map();
  function fmt(kind) {
    const key = `${T().locale}|${kind}`;
    let f = fmtCache.get(key);
    if (!f) {
      f = kind === "num" ? new Intl.NumberFormat(T().locale) : new Intl.DateTimeFormat(T().locale, FMT_OPTS[kind]);
      fmtCache.set(key, f);
    }
    return f;
  }
  const fullDate = (ts) => fmt("full").format(new Date(ts * 1000));
  function size(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${Math.round(b / 1024)} KB`;
    return `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
  }
  function tokens(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
    return `${(n / 1e6).toFixed(2)}M`;
  }
  // 200k é a janela padrão; acima de 180k está quase cheia
  const tokClass = (n) => (n >= 800000 ? "hot" : n >= 180000 ? "warm" : "");
  const short = (p) => (data.home && p.startsWith(data.home) ? "~" + p.slice(data.home.length) : p);

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

  // ---------------------------------------------------------------- dados
  const projectKey = (s) => s.cwd || s.folder;
  const titleOf = (s) => s.name || s.title || s.first || "";
  const isLive = (s) => !!data.live[s.id];

  function inFilter(s, f = ui.filter) {
    if (f === "trash") return s.deleted;
    if (s.deleted) return false;
    if (f === "fav") return s.favorite;
    if (f === "live") return isLive(s);
    return true;
  }
  function localMatch(s, q) {
    return [s.name, s.title, s.first, s.notes, s.project, s.cwd, s.branch, s.id]
      .some((v) => v && String(v).toLowerCase().includes(q));
  }
  function visible() {
    const q = ui.q.trim().toLowerCase();
    const hits = ui.hitsQ === q ? ui.hits : {};
    const list = data.items.filter((s) => inFilter(s)
      && (!ui.project || projectKey(s) === ui.project)
      && (!q || localMatch(s, q) || hits[s.id]));
    const by = {
      recent: (a, b) => b.mtime - a.mtime,
      oldest: (a, b) => a.mtime - b.mtime,
      tokens: (a, b) => (b.tokens || 0) - (a.tokens || 0),
      size: (a, b) => b.size - a.size,
      name: (a, b) => titleOf(a).localeCompare(titleOf(b), T().locale, { sensitivity: "base" }),
    }[ui.sort] || ((a, b) => b.mtime - a.mtime);
    // abertas agora sobem pro topo na ordem padrão
    return list.sort((a, b) => (ui.sort === "recent" ? isLive(b) - isLive(a) : 0) || by(a, b));
  }

  // --------------------------------------------------------------- render
  const FILTERS = [
    { id: "all", label: "f_all", tile: "t-all", ico: "claude" },
    { id: "fav", label: "f_fav", tile: "t-fav", ico: "star" },
    { id: "live", label: "f_live", tile: "t-live", ico: "live" },
    { id: "trash", label: "f_trash", tile: "t-trash", ico: "trash" },
  ];

  function renderSide() {
    const total = data.items.filter((s) => !s.deleted).length;
    const live = Object.keys(data.live).length;
    $("#side-sub").textContent = live ? t("sideSub", { n: total, m: live }) : t("sideSub0", { n: total });

    $("#filters").innerHTML = FILTERS.map((f) => `
      <li class="nav ${ui.filter === f.id && !ui.project ? "on" : ""}" data-filter="${f.id}">
        <span class="tile sm ${f.tile}">${icon(f.ico)}</span>
        <span class="nav-label">${t(f.label)}</span>
        <span class="nav-n">${data.items.filter((s) => inFilter(s, f.id)).length || ""}</span>
      </li>`).join("");

    const groups = new Map();
    for (const s of data.items) {
      if (!inFilter(s)) continue;
      const k = projectKey(s);
      const g = groups.get(k) || { key: k, name: s.project, n: 0, last: 0 };
      g.n += 1; g.last = Math.max(g.last, s.mtime);
      groups.set(k, g);
    }
    const projects = [...groups.values()].sort((a, b) => b.last - a.last);
    $("#projects").innerHTML = projects.map((p) => `
      <li class="nav ${ui.project === p.key ? "on" : ""}" data-project="${esc(p.key)}" title="${esc(short(p.key))}">
        ${projectTile(p.name, "sm")}
        <span class="nav-label">${esc(p.name)}</span>
        <span class="nav-n">${p.n}</span>
      </li>`).join("");
    $("#projects").style.display = projects.length ? "" : "none";

    const sync = $("#sync");
    sync.classList.toggle("on", !!data.shared);
    sync.innerHTML = `<i></i><span><b>${t(data.shared ? "l_syncOn" : "l_syncOff")}</b>${t(data.shared ? "l_syncOnSub" : "l_syncOffSub")}</span>`;
  }

  function renderHead(list) {
    const f = FILTERS.find((x) => x.id === ui.filter);
    if (ui.project) {
      const any = data.items.find((s) => projectKey(s) === ui.project);
      $("#view-title").textContent = any ? any.project : ui.project;
      $("#view-sub").textContent = `${short(ui.project)} · ${list.length === 1 ? t("count1") : t("countN", { n: list.length })}`;
    } else {
      $("#view-title").textContent = t(f.label);
      $("#view-sub").textContent = list.length === 1 ? t("count1") : t("countN", { n: list.length });
    }
    $("#sort-label").textContent = t(`s_${ui.sort}`);
  }

  function renderNotice() {
    const parts = [];
    if (data.metaError) parts.push(`<div class="notice err">${icon("x")}<span>${esc(t("n_meta", { detail: data.metaError }))}</span></div>`);
    if (ui.filter === "trash" && !ui.project) parts.push(`<div class="notice">${icon("trash")}<span>${esc(t("n_trash"))}</span></div>`);
    $("#notice").innerHTML = parts.join("");
  }

  function row(s, q, flat) {
    const live = data.live[s.id];
    const title = titleOf(s);
    const hit = q && ui.hitsQ === q ? ui.hits[s.id] : null;
    const showHit = hit && !localMatch(s, q);
    let desc = "";
    if (showHit) desc = `<div class="row-desc snippet" data-label="${esc(t("l_inText"))}">${mark(hit, q)}</div>`;
    else if (s.notes) desc = `<div class="row-desc note">${mark(s.notes, q)}</div>`;
    else if (s.first && s.first !== title) desc = `<div class="row-desc">${mark(s.first, q)}</div>`;

    // onde parei: o resumo da IA (se houver) ou a última fala do Claude, encurtada
    const recapText = data.recapMode === "off" ? "" : ((data.recaps || {})[s.id] || s.last || "");
    const recap = recapText && !s.deleted
      ? `<div class="row-recap" title="${esc(recapText)}"><b>${esc(t("l_recap"))}</b>${esc(recapText)}</div>` : "";

    const chips = [];
    if (flat) chips.push(`<span class="chip proj" title="${esc(short(s.cwd))}"><i style="background:hsl(${hue(s.project)} 62% 55%)"></i>${mark(s.project, q)}</span>`);
    if (s.branch && s.branch !== "HEAD") chips.push(`<span class="chip" title="${esc(t("l_branchTip"))}">${icon("branch")}${mark(s.branch, q)}</span>`);
    if (s.tokens) chips.push(`<span class="chip ${tokClass(s.tokens)}" title="${esc(t("l_tokensTip", { n: fmt("num").format(s.tokens) }))}">${icon("ctx")}${tokens(s.tokens)}</span>`);
    if (s.size) chips.push(`<span class="chip" title="${esc(t("l_sizeTip"))}">${icon("file")}${size(s.size)}</span>`);
    if (s.cwd && !s.exists) chips.push(`<span class="chip gone">${esc(t("l_gone"))}</span>`);

    chips.push(`<span class="chip" title="${esc(fullDate(s.mtime))}">${icon("clock")}<span class="when">${ago(s.mtime)}</span></span>`);

    const c = live ? statusClass(live.status) : null;
    const acts = s.deleted
      ? `
        <button class="act copy" data-act="copy" title="${esc(t("l_copyTipCmd", { cmd: copyText(s, copyMode()) }))}">${icon("copy")}${t("l_copy")}</button>
        <span class="acts-gap"></span>
        <button class="act go" data-act="restore">${icon("restore")}${t("l_restore")}</button>`
      : `
        <button class="act copy" data-act="copy" title="${esc(t("l_copyTipCmd", { cmd: copyText(s, copyMode()) }))}">${icon("copy")}${t("l_copy")}</button>
        <button class="act fav ${s.favorite ? "on" : ""}" data-act="fav" title="${t(s.favorite ? "l_unfavorite" : "l_favorite")}">${icon("star")}</button>
        <button class="act" data-act="edit" title="${t("l_edit")}">${icon("edit")}</button>
        <button class="act danger" data-act="trash" title="${t("l_toTrash")}">${icon("trash")}</button>
        <span class="acts-gap"></span>
        <button class="act go ${live ? "live" : ""}" data-act="open">${live ? icon("chev") : icon("play")}${t(live ? "l_goTo" : "l_resume")}</button>`;

    const cls = ["row", "card"];
    if (ui.selected.has(s.id)) cls.push("sel");
    if (s.favorite) cls.push("fav");
    if (s.deleted) cls.push("trashed");
    if (live) cls.push("is-live");
    return `
      <li class="${cls.join(" ")}" data-id="${s.id}" tabindex="0">
        <button class="pick" data-act="pick" title="${t("l_select")}">${icon("check")}</button>
        ${live ? `<div class="card-live">${hostTile(live.host)}<span class="badge ${c}">${statusLabel(c)}</span><span class="host-name">${esc((live.host && live.host.label) || "")}</span></div>` : ""}
        <div class="row-title ${title ? "" : "untitled"}" title="${esc(title || s.first || "")}">${s.favorite ? icon("star").replace("<svg", '<svg class="star"') : ""}<span>${mark(title || t("l_untitled"), q)}</span></div>
        ${recap}
        ${desc}
        <span class="card-id" title="${esc(s.id)}">${s.id}</span>
        <div class="chips">${chips.join("")}</div>
        <div class="acts">${acts}</div>
      </li>`;
  }

  function emptyState() {
    const q = ui.q.trim();
    const [h, p] = q ? ["e_search", "e_searchSub"]
      : ui.filter === "fav" ? ["e_fav", "e_favSub"]
      : ui.filter === "trash" ? ["e_trash", "e_trashSub"]
      : ui.filter === "live" ? ["e_live", "e_liveSub"]
      : ["e_none", "e_noneSub"];
    if (q && ui.searching) return "";
    return `<div class="empty"><div class="empty-ico"><svg><use href="#i-claude"/></svg></div><b>${t(h)}</b><span>${t(p)}</span></div>`;
  }

  let lastSig = null;
  let paintToken = 0;
  const FIRST_PAINT = 24;
  const cardHtml = new Map();
  const keep = (s, html) => { cardHtml.set(s.id, html); return html; };
  function renderList() {
    const list = visible();
    const q = ui.q.trim().toLowerCase();
    renderHead(list);
    renderNotice();
    const box = $("#list");
    const focusId = document.activeElement && document.activeElement.closest && document.activeElement.closest(".row")?.dataset.id;
    // mesma estrutura de antes (mesmos cards, mesma ordem): troca só os cards que
    // mudaram em vez de refazer a grade toda; é o caso comum do refresh a cada 10 s
    const grouped = !(ui.project || ui.sort !== "recent");
    const sig = JSON.stringify([grouped, ui.project, q, ui.hitsQ === q, [...ui.collapsed], list.map((s) => s.id)]);
    if (list.length && sig === lastSig) {
      for (const s of list) {
        const html = row(s, q, !grouped && !ui.project);
        if (cardHtml.get(s.id) === html) continue;
        cardHtml.set(s.id, html);
        const el = box.querySelector(`.row[data-id="${s.id}"]`);
        if (el) el.outerHTML = html;
      }
      if (focusId) { const el = box.querySelector(`.row[data-id="${focusId}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }
      renderBulk();
      return;
    }
    lastSig = sig;
    cardHtml.clear();
    // primeira pintura só com os cards que cabem na tela; o resto entra no quadro seguinte
    let deferred = [];
    const token = ++paintToken;
    if (!list.length) {
      box.innerHTML = emptyState();
    } else if (ui.project || ui.sort !== "recent") {
      // lista corrida: projeto único, ou ordem que não faz sentido agrupar
      const now = list.slice(0, FIRST_PAINT);
      box.innerHTML = `<ul class="group" data-g="0">${now.map((s) => keep(s, row(s, q, !ui.project))).join("")}</ul>`;
      if (list.length > FIRST_PAINT) deferred = [["0", list.slice(FIRST_PAINT).map((s) => keep(s, row(s, q, !ui.project))).join("")]];
    } else {
      const groups = [];
      const idx = new Map();
      for (const s of list) {
        const k = projectKey(s);
        if (!idx.has(k)) { idx.set(k, groups.length); groups.push({ key: k, name: s.project, items: [] }); }
        groups[idx.get(k)].items.push(s);
      }
      let budget = FIRST_PAINT;
      box.innerHTML = groups.map((g, gi) => {
        const path = short(g.key);
        const parent = path.endsWith("/" + g.name) ? path.slice(0, -g.name.length) : path;
        const collapsed = ui.collapsed.has(g.key) && !q;
        const n = collapsed ? 0 : Math.max(0, Math.min(g.items.length, budget));
        budget -= n;
        const rows = g.items.map((s) => keep(s, row(s, q, false)));
        if (n < rows.length) deferred.push([String(gi), rows.slice(n).join("")]);
        return `
          <section class="proj ${collapsed ? "collapsed" : ""}" data-key="${esc(g.key)}">
            <div class="proj-head">
              <svg class="proj-chev"><use href="#i-chev"/></svg>
              ${projectTile(g.name, "sm")}
              <span class="proj-name">${mark(g.name, q)}</span>
              <span class="proj-path">${esc(parent)}</span>
              <span class="proj-n">${g.items.length}</span>
            </div>
            <ul class="group" data-g="${gi}">${rows.slice(0, n).join("")}</ul>
          </section>`;
      }).join("");
    }
    if (deferred.length) {
      requestAnimationFrame(() => setTimeout(() => {
        if (token !== paintToken) return;
        for (const [g, html] of deferred) {
          const ul = box.querySelector(`ul.group[data-g="${g}"]`);
          if (ul) ul.insertAdjacentHTML("beforeend", html);
        }
      }, 0));
    }
    // quantas vieram só da busca no texto
    const extra = q && ui.hitsQ === q ? list.filter((s) => ui.hits[s.id] && !localMatch(s, q)).length : 0;
    if (extra) box.insertAdjacentHTML("afterbegin", `<div class="more-hits">${t("l_foundText", { n: extra })}</div>`);
    if (focusId) { const el = box.querySelector(`.row[data-id="${focusId}"]`); if (el) el.focus({ preventScroll: true }); }
    renderBulk();
  }

  function renderSearchStatus() {
    $("#q-status").innerHTML = ui.searching ? `<i class="mini-spin"></i>${t("l_searching")}` : "";
  }

  function render() { renderSide(); renderList(); renderSearchStatus(); }

  // ------------------------------------------------------------- seleção
  function renderBulk() {
    const ids = [...ui.selected].filter((id) => data.items.some((s) => s.id === id));
    ui.selected = new Set(ids);
    const bar = $("#bulk");
    bar.hidden = !ids.length;
    body.classList.toggle("selecting", ids.length > 0);
    if (!ids.length) return;
    const items = data.items.filter((s) => ui.selected.has(s.id));
    const anyDeleted = items.some((s) => s.deleted);
    $("#bulk-n").textContent = t("l_selected", { n: ids.length });
    bar.querySelector('[data-bulk="fav"]').hidden = anyDeleted;
    bar.querySelector('[data-bulk="trash"]').hidden = anyDeleted;
    bar.querySelector('[data-bulk="restore"]').hidden = !anyDeleted;
    if (!$("#toast").hidden) $("#toast").hidden = true;
  }

  function pick(id, shift) {
    if (shift && ui.lastPicked) {
      const ids = [...$$("#list .row")].map((r) => r.dataset.id);
      const a = ids.indexOf(ui.lastPicked), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) ui.selected.add(x);
        renderList();
        return;
      }
    }
    if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
    ui.lastPicked = id;
    const r = $(`#list .row[data-id="${id}"]`);
    if (r) r.classList.toggle("sel", ui.selected.has(id));
    renderBulk();
  }
  function clearSel() { ui.selected.clear(); $$("#list .row.sel").forEach((r) => r.classList.remove("sel")); renderBulk(); }

  // ---------------------------------------------------------------- ações
  // muda local na hora (a lista responde sem esperar o disco) e manda pro Python
  function patch(ids, fields, toastKey, n) {
    if (data.metaError) { toast(t("t_err_metaUnreadable"), false, true); return; }
    for (const s of data.items) {
      if (!ids.includes(s.id)) continue;
      if ("favorite" in fields) s.favorite = fields.favorite;
      if ("deleted" in fields) s.deleted = fields.deleted;
      if ("name" in fields) s.name = fields.name;
      if ("description" in fields) s.notes = fields.description;
    }
    post("patch", { ids, fields });
    render();
    if (toastKey) toast(t(toastKey, { n }), ids.length > 0 && toastKey !== "t_saved");
  }

  function action(act, s, el) {
    if (act === "open") {
      el && el.closest(".row") && el.closest(".row").classList.add("tap");
      post("open", { id: s.id });
    } else if (act === "fav") {
      patch([s.id], { favorite: !s.favorite }, s.favorite ? "t_unfav" : "t_fav");
    } else if (act === "trash") {
      patch([s.id], { deleted: true }, "t_trashed1");
    } else if (act === "restore") {
      patch([s.id], { deleted: false }, "t_restored1");
    } else if (act === "edit") {
      openEditor(s);
    } else if (act === "copy" || act === "copyCli" || act === "copySlash" || act === "copyId") {
      const mode = act === "copy" ? copyMode() : act === "copyId" ? "id" : act;
      copy(s, mode);
      if (el && el.classList.contains("copy")) {
        el.classList.add("done");
        setTimeout(() => el.classList.remove("done"), 1200);
      }
    }
  }

  // o comando que retoma a sessão, igual ao que o dock roda no terminal
  const shq = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);
  function resumeCommand(s) {
    const cmd = `claude --resume ${s.id}`;
    return s.cwd && s.exists ? `cd ${shq(s.cwd)} && ${cmd}` : cmd;
  }
  // formato do botão Copiar: segue a configuração de clique (padrão: comando do shell)
  const clickMode = () => (["open", "copyCli", "copySlash"].includes(data.clickAction) ? data.clickAction : "open");
  const copyMode = () => (clickMode() === "copySlash" ? "copySlash" : "copyCli");
  const copyText = (s, mode) => (mode === "id" ? s.id : mode === "copySlash" ? `/resume ${s.id}` : resumeCommand(s));
  function copy(s, mode) {
    if (bridge) post("copy", { id: s.id, mode });
    else if (navigator.clipboard) navigator.clipboard.writeText(copyText(s, mode)).catch(() => {});
    toast(t(mode === "id" ? "t_idCopied" : mode === "copySlash" ? "t_slashCopied" : "t_copied"));
  }
  // clique (ou Enter) numa sessão: abre no terminal ou copia, conforme a configuração.
  // Sessão aberta sempre vai pra janela dela.
  function primary(s, el) {
    if (s.deleted) return;
    const mode = clickMode();
    if (mode === "open" || data.live[s.id]) { action("open", s, el); return; }
    if (el) { el.classList.remove("tap"); void el.offsetWidth; el.classList.add("tap"); }
    copy(s, mode);
  }

  // ------------------------------------------------------ botão direito
  function closeCtx() {
    $("#ctx").hidden = true;
    $$("#list .row.ctx-on").forEach((r) => r.classList.remove("ctx-on"));
  }
  function openCtx(s, r, x, y) {
    closeCtx();
    const many = ui.selected.size > 1 && ui.selected.has(s.id);
    const item = (act, ic, label, extra = "") => `<li data-ctx="${act}" class="${extra}">${ic}<span>${esc(label)}</span></li>`;
    const live = data.live[s.id];
    let html;
    if (many) {
      const n = ui.selected.size;
      const ids = [...ui.selected];
      const anyTrashed = data.items.some((x) => ids.includes(x.id) && x.deleted);
      html = anyTrashed
        ? item("bulk-restore", icon("restore"), t("m_restoreN", { n }))
        : item("bulk-fav", icon("star"), t("m_favN", { n })) + "<hr>" + item("bulk-trash", icon("trash"), t("m_trashN", { n }), "danger");
      html += "<hr>" + item("bulk-clear", icon("x"), t("l_clearSel"));
    } else if (s.deleted) {
      html = item("restore", icon("restore"), t("l_restore"))
        + item("copyCli", icon("copy"), t("m_copyCli"))
        + item("copySlash", icon("term"), t("m_copySlash"))
        + item("copyId", icon("hash"), t("m_copyId"));
    } else {
      html = item("open", live ? icon("chev") : icon("play"), t(live ? "l_goTo" : "l_resume"))
        + item("copyCli", icon("copy"), t("m_copyCli"))
        + item("copySlash", icon("term"), t("m_copySlash"))
        + item("copyId", icon("hash"), t("m_copyId"))
        + "<hr>"
        + item("edit", icon("edit"), t("m_rename")).replace("</span></li>", "</span><kbd>F2</kbd></li>")
        + item("fav", s.favorite ? `<svg class="on-star"><use href="#i-star"/></svg>` : icon("star"), t(s.favorite ? "l_unfavorite" : "l_favorite")).replace("</span></li>", "</span><kbd>F</kbd></li>")
        + item("pick", icon("check"), t(ui.selected.has(s.id) ? "m_unselect" : "m_select"))
        + "<hr>"
        + item("trash", icon("trash"), t("l_toTrash"), "danger").replace("</span></li>", "</span><kbd>Del</kbd></li>");
    }
    const m = $("#ctx");
    m.innerHTML = html;
    m.dataset.id = s.id;
    m.hidden = false;
    r.classList.add("ctx-on");
    const W = innerWidth, H = innerHeight, mw = m.offsetWidth, mh = m.offsetHeight;
    const up = y + mh > H - 8;
    m.classList.toggle("up", up);
    m.style.left = `${Math.min(x, W - mw - 8)}px`;
    m.style.top = `${up ? Math.max(8, y - mh) : y}px`;
  }
  $("#ctx").addEventListener("click", (e) => {
    const li = e.target.closest("[data-ctx]");
    if (!li) return;
    const s = data.items.find((x) => x.id === $("#ctx").dataset.id);
    const act = li.dataset.ctx;
    closeCtx();
    if (act.startsWith("bulk-")) { bulk(act.slice(5)); return; }
    if (!s) return;
    if (act === "pick") { pick(s.id, false); return; }
    const r = $(`#list .row[data-id="${s.id}"]`);
    action(act, s, r);
  });
  $("#list").addEventListener("contextmenu", (e) => {
    const r = e.target.closest(".row");
    if (!r) return;
    e.preventDefault();
    const s = data.items.find((x) => x.id === r.dataset.id);
    if (s) openCtx(s, r, e.clientX, e.clientY);
  });
  document.addEventListener("contextmenu", (e) => { if (!e.target.closest("#list .row")) e.preventDefault(); });
  document.addEventListener("mousedown", (e) => { if (!$("#ctx").hidden && !e.target.closest("#ctx")) closeCtx(); });
  $("#list").addEventListener("scroll", closeCtx, { passive: true });
  window.addEventListener("blur", closeCtx);

  function bulk(kind) {
    const ids = [...ui.selected];
    if (!ids.length) return;
    if (kind === "clear") { clearSel(); return; }
    if (kind === "fav") patch(ids, { favorite: true }, ids.length === 1 ? "t_fav" : "t_favN", ids.length);
    if (kind === "trash") patch(ids, { deleted: true }, ids.length === 1 ? "t_trashed1" : "t_trashedN", ids.length);
    if (kind === "restore") patch(ids, { deleted: false }, ids.length === 1 ? "t_restored1" : "t_restoredN", ids.length);
    ui.selected.clear();
    renderList();
  }

  // ----------------------------------------------------------------- toast
  let toastTimer;
  function toast(text, undo = false, err = false) {
    if (ui.selected.size) return;
    const el = $("#toast");
    $("#toast-text").textContent = text;
    $("#toast-undo").hidden = !undo;
    el.classList.toggle("err", err);
    el.hidden = false;
    el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 6000 : 2600);
  }
  $("#toast-undo").addEventListener("click", () => { post("undo"); $("#toast").hidden = true; });
  window.libToast = (m) => toast(t(`t_err_${m.error}`), false, true);

  // ---------------------------------------------------------------- editor
  function openDialog(id) { body.classList.add("dialog-open"); $(id).hidden = false; }
  function closeDialogs() {
    body.classList.remove("dialog-open");
    $$(".dialog").forEach((d) => { d.hidden = true; });
    ui.editing = null;
  }
  function openEditor(s) {
    ui.editing = s.id;
    $("#ed-first").textContent = s.title || s.first || "";
    $("#ed-name").value = s.name || "";
    $("#ed-name").placeholder = s.title || s.first || t("l_untitled");
    $("#ed-notes").value = s.notes || "";
    openDialog("#editor");
    setTimeout(() => $("#ed-name").focus(), 30);
  }
  function saveEditor() {
    const id = ui.editing;
    if (!id) return;
    patch([id], { name: $("#ed-name").value.trim(), description: $("#ed-notes").value.trim() }, "t_saved");
    closeDialogs();
  }
  $("#ed-save").addEventListener("click", saveEditor);
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeDialogs));
  $("#scrim").addEventListener("click", closeDialogs);

  // -------------------------------------------------------- configurações
  // tudo fica na janela de configurações (a mesma da engrenagem do dock)
  $("#settings-btn").addEventListener("click", () => post("openSettings"));
  $("#sync").addEventListener("click", () => post("openSettings", { section: "sessions" }));

  // ------------------------------------------------------------- ordenação
  const SORTS = ["recent", "oldest", "tokens", "size", "name"];
  $("#sort-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const m = $("#sort-menu");
    if (!m.hidden) { m.hidden = true; return; }
    m.innerHTML = SORTS.map((k) => `<li data-sort="${k}" class="${k === ui.sort ? "on" : ""}">${icon("check")}${t(`s_${k}`)}</li>`).join("");
    m.hidden = false;
  });
  $("#sort-menu").addEventListener("click", (e) => {
    const li = e.target.closest("[data-sort]");
    if (!li) return;
    ui.sort = li.dataset.sort;
    $("#sort-menu").hidden = true;
    post("pref", { key: "sort", value: ui.sort });
    renderList();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("#sort-menu").hidden = true; });

  // --------------------------------------------------------------- busca
  let searchTimer;
  $("#q").addEventListener("input", () => {
    ui.q = $("#q").value;
    const q = ui.q.trim().toLowerCase();
    clearTimeout(searchTimer);
    ui.searching = q.length >= 3 && ui.hitsQ !== q;
    renderList(); renderSearchStatus();
    if (ui.searching) {
      searchTimer = setTimeout(() => { ui.gen += 1; post("search", { q, gen: ui.gen }); }, 450);
    }
  });
  window.libSearchResult = (r) => {
    if (r.gen !== ui.gen) return;
    ui.hits = r.hits || {};
    ui.hitsQ = r.q;
    ui.searching = false;
    if (ui.q.trim().toLowerCase() === r.q) renderList();
    renderSearchStatus();
  };

  // --------------------------------------------------------------- cliques
  $("#filters").addEventListener("click", (e) => {
    const li = e.target.closest("[data-filter]");
    if (!li) return;
    ui.filter = li.dataset.filter; ui.project = null;
    clearSel(); render();
    $("#list").scrollTop = 0;
  });
  $("#projects").addEventListener("click", (e) => {
    const li = e.target.closest("[data-project]");
    if (!li) return;
    ui.project = ui.project === li.dataset.project ? null : li.dataset.project;
    render();
    $("#list").scrollTop = 0;
  });
  $("#list").addEventListener("click", (e) => {
    const head = e.target.closest(".proj-head");
    if (head) {
      const key = head.parentElement.dataset.key;
      if (ui.collapsed.has(key)) ui.collapsed.delete(key); else ui.collapsed.add(key);
      head.parentElement.classList.toggle("collapsed", ui.collapsed.has(key));
      post("pref", { key: "collapsed", value: [...ui.collapsed] });
      return;
    }
    const r = e.target.closest(".row");
    if (!r) return;
    const s = data.items.find((x) => x.id === r.dataset.id);
    if (!s) return;
    const btn = e.target.closest("[data-act]");
    if (btn && btn.dataset.act === "pick") { pick(s.id, e.shiftKey); return; }
    if (btn) { action(btn.dataset.act, s, btn); return; }
    // com algo selecionado, clicar na linha soma à seleção
    if (ui.selected.size || e.ctrlKey || e.shiftKey) { pick(s.id, e.shiftKey); return; }
    if (s.deleted) action("edit", s, r); else primary(s, r);
  });
  $("#list").addEventListener("dblclick", (e) => e.preventDefault());
  $("#bulk").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bulk]");
    if (b) bulk(b.dataset.bulk);
  });
  $("#refresh").addEventListener("click", () => {
    const b = $("#refresh");
    b.classList.add("spin");
    setTimeout(() => b.classList.remove("spin"), 700);
    post("refresh");
  });

  // ---------------------------------------------------------------- teclado
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if (body.classList.contains("dialog-open")) {
      if (e.key === "Escape") closeDialogs();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ui.editing) saveEditor();
      if (e.key === "Enter" && !e.shiftKey && document.activeElement === $("#ed-name")) { e.preventDefault(); saveEditor(); }
      return;
    }
    if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
    if (e.key === "Escape") {
      if (!$("#ctx").hidden) { closeCtx(); return; }
      if (!$("#sort-menu").hidden) { $("#sort-menu").hidden = true; return; }
      if (ui.selected.size) { clearSel(); return; }
      if (ui.q) { $("#q").value = ""; ui.q = ""; ui.searching = false; renderList(); renderSearchStatus(); return; }
      if (typing) document.activeElement.blur();
      return;
    }
    const arrows = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
    if (arrows.includes(e.key) && (!typing || (document.activeElement === $("#q") && (e.key === "ArrowDown" || e.key === "ArrowUp")))) {
      const rows = [...$$("#list .proj:not(.collapsed) .row, #list > .group .row")];
      if (!rows.length) return;
      e.preventDefault();
      const cur = document.activeElement;
      const i = rows.indexOf(cur);
      if (i < 0) { rows[0].focus(); rows[0].scrollIntoView({ block: "nearest" }); return; }
      let next;
      if (e.key === "ArrowRight") next = rows[Math.min(rows.length - 1, i + 1)];
      else if (e.key === "ArrowLeft") next = rows[Math.max(0, i - 1)];
      else {
        // na grade: o card mais perto na linha de baixo/de cima
        const b = cur.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const down = e.key === "ArrowDown";
        const cands = rows.filter((r) => {
          const rb = r.getBoundingClientRect();
          return down ? rb.top > b.top + 4 : rb.top < b.top - 4;
        });
        if (cands.length) {
          const edge = down ? Math.min(...cands.map((r) => r.getBoundingClientRect().top))
            : Math.max(...cands.map((r) => r.getBoundingClientRect().top));
          next = cands.filter((r) => Math.abs(r.getBoundingClientRect().top - edge) < 4)
            .sort((x, y) => Math.abs(x.getBoundingClientRect().left + x.offsetWidth / 2 - cx) - Math.abs(y.getBoundingClientRect().left + y.offsetWidth / 2 - cx))[0];
        }
      }
      if (next) { next.focus(); next.scrollIntoView({ block: "nearest" }); }
      return;
    }
    const r = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("row") ? document.activeElement : null;
    if (!r) return;
    const s = data.items.find((x) => x.id === r.dataset.id);
    if (!s) return;
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const b = r.getBoundingClientRect();
      openCtx(s, r, b.left + 48, b.top + b.height / 2);
      return;
    }
    if (!$("#ctx").hidden) return;
    if (e.key === "Enter") { e.preventDefault(); if (s.deleted) action("restore", s, r); else primary(s, r); }
    else if (e.key === "c" && !e.ctrlKey) { e.preventDefault(); copy(s, copyMode()); }
    else if (e.key === "c" && e.ctrlKey && !window.getSelection().toString()) { e.preventDefault(); copy(s, copyMode()); }
    else if (e.key === " ") { e.preventDefault(); pick(s.id, e.shiftKey); }
    else if (e.key === "e" || e.key === "F2") { e.preventDefault(); if (!s.deleted) openEditor(s); }
    else if (e.key === "f") { e.preventDefault(); if (!s.deleted) action("fav", s); }
    else if (e.key === "Delete") { e.preventDefault(); action(s.deleted ? "restore" : "trash", s); }
  });

  // ----------------------------------------------------------------- entrada
  window.libUpdate = (d) => {
    data = d;
    if (!ui.prefsLoaded) {
      ui.prefsLoaded = true;
      const p = d.prefs || {};
      if (SORTS.includes(p.sort)) ui.sort = p.sort;
      if (Array.isArray(p.collapsed)) ui.collapsed = new Set(p.collapsed);
    }
    applyStatic();
    if (ui.project && !data.items.some((s) => projectKey(s) === ui.project)) ui.project = null;
    render();
  };

  setInterval(() => { if (!body.classList.contains("dialog-open")) $$(".when").forEach((el) => {
    const r = el.closest(".row"); const s = r && data.items.find((x) => x.id === r.dataset.id);
    if (s) el.textContent = ago(s.mtime);
  }); }, 60000);

  window.libDebug = (cmd) => {
    if (cmd.startsWith("q:")) { $("#q").value = cmd.slice(2); $("#q").dispatchEvent(new Event("input")); }
    if (cmd === "settings") post("openSettings");
  };

  // pré-visualização no navegador (prints do README): library.html?lang=pt&view=fav&q=...
  if (!bridge && window.libDemo) {
    const params = new URLSearchParams(location.search);
    const demo = window.libDemo(params.get("lang") || "en");
    window.libUpdate(demo);
    if (params.get("view")) { ui.filter = params.get("view"); render(); }
    if (params.get("q")) {
      $("#q").value = params.get("q"); ui.q = params.get("q");
      const q = ui.q.toLowerCase();
      ui.hits = demo.hits || {}; ui.hitsQ = q;
      render();
    }
    if (params.get("sel")) { params.get("sel").split(",").forEach((i) => ui.selected.add(demo.items[Number(i)].id)); renderList(); }
    if (params.get("edit")) openEditor(demo.items[Number(params.get("edit"))]);
  }

  post("ready");
})();
