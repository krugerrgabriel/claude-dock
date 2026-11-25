// Dados fictícios pra abrir a janela de configurações num navegador (prints, desenvolvimento).
// Só é usado quando a página roda fora do app (sem a ponte do WebKit).
window.settingsDemo = (lang) => {
  const now = Date.now() / 1000;
  const iso = (sec) => new Date((now + sec) * 1000).toISOString();
  return {
    lang: lang === "pt" ? "pt" : "en",
    home: "/home/you",
    version: "1.3.0",
    notifyOk: true,
    config: {
      language: "auto", clickAction: "open", terminal: null, islandUsage: true, checkUpdates: true,
      usage: { plan: true, rings: true, session: true, week: true, paceMarker: true, resetTime: true, models: false, spent: false },
      notify: { waiting: true, done: true, forgotten: true, forgottenHours: 2, limit: true, sound: false },
      ask: { shortcut: "<Control><Alt>space", mode: "read", cwd: "auto", model: "auto" },
      recap: { mode: "simple" },
      summary: { enabled: true },
    },
    terminals: [{ id: "ghostty", label: "Ghostty" }, { id: "gnome-terminal", label: "GNOME Terminal" }],
    autoTerminal: "ghostty",
    folders: [
      { cwd: "/home/you/code/api-gateway", project: "api-gateway", short: "~/code/api-gateway" },
      { cwd: "/home/you/code/web-app", project: "web-app", short: "~/code/web-app" },
      { cwd: "/home/you/code/storefront", project: "storefront", short: "~/code/storefront" },
    ],
    autoTrashDays: 60,
    shared: true,
    managerUrl: "http://localhost/claude-sessions/",
    usage: {
      ok: true, plan: "max", fetchedAt: now - 40,
      session: { pct: 38, resetsAt: iso(2.4 * 3600) },
      week: { pct: 61, resetsAt: iso(3.2 * 86400) },
      weekStartedAt: iso(-3.8 * 86400),
      models: [{ name: "Opus", pct: 44, resetsAt: iso(3.2 * 86400) }],
      spent: [{ name: "Claude Code", pct: 81 }, { name: "Chats", pct: 12 }, { name: "Cowork", pct: 7 }],
    },
  };
};
