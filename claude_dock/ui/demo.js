// Dados fictícios pra abrir a interface num navegador (prints do README, desenvolvimento).
// Só é usado quando a página roda fora do app (sem a ponte do WebKit).
window.dockDemo = (lang) => {
  const now = Date.now() / 1000;
  const iso = (sec) => new Date((now + sec) * 1000).toISOString();
  const pt = lang === "pt";
  const L = (en, ptText) => (pt ? ptText : en);
  const JB = { kind: "jetbrains", label: "RubyMine" };
  const GH = { kind: "ghostty", label: "Ghostty" };
  const VS = { kind: "vscode", label: "VS Code" };

  return {
    lang: pt ? "pt" : "en",
    home: "/home/you",
    config: { islandUsage: true, language: "auto",
      usage: { plan: true, rings: true, session: true, week: true, paceMarker: true, resetTime: true, models: false, spent: false } },
    usage: {
      ok: true, plan: "max", fetchedAt: now - 40,
      session: { pct: 38, resetsAt: iso(2.4 * 3600) },
      week: { pct: 61, resetsAt: iso(3.2 * 86400) },
      weekStartedAt: iso(-3.8 * 86400),
      models: [{ name: "Opus", pct: 44, resetsAt: iso(3.2 * 86400) }],
      spent: [{ name: "Claude Code", pct: 81 }, { name: "Chats", pct: 12 }, { name: "Cowork", pct: 7 }],
    },
    live: [
      { pid: 1, title: L("Fix flaky checkout tests", "Corrigir testes instáveis do checkout"), project: "storefront", status: "busy", statusSince: now - 274, host: JB },
      { pid: 2, title: L("Migrate auth to OAuth 2.1", "Migrar autenticação pro OAuth 2.1"), project: "api-gateway", status: "idle", statusSince: now - 900, host: GH },
      { pid: 3, title: L("Dark mode for the settings page", "Modo escuro na tela de configurações"), project: "web-app", status: "busy", statusSince: now - 61, host: VS },
      { pid: 4, title: L("Review PR #482 (rate limiter)", "Revisar PR #482 (rate limiter)"), project: "api-gateway", status: "waiting", statusSince: now - 30, host: GH },
      { pid: 5, title: L("Write the release notes", "Escrever as notas da versão"), project: "docs", status: "idle", statusSince: now - 3000, host: GH },
    ],
    history: [
      { sessionId: "a", cwd: "/x", title: L("Speed up the image pipeline", "Acelerar o pipeline de imagens"), project: "media-worker", mtime: now - 1500 },
      { sessionId: "b", cwd: "/x", title: L("Add Stripe webhooks", "Adicionar webhooks do Stripe"), project: "api-gateway", mtime: now - 5200 },
      { sessionId: "c", cwd: "/x", title: L("Refactor the API client", "Refatorar o cliente da API"), project: "web-app", mtime: now - 9800 },
      { sessionId: "d", cwd: "/x", title: L("Investigate memory leak in workers", "Investigar vazamento de memória nos workers"), project: "media-worker", mtime: now - 90000 },
      { sessionId: "e", cwd: "/x", title: L("API pagination with cursors", "Paginação da API com cursores"), project: "api-gateway", mtime: now - 100000 },
      { sessionId: "f", cwd: "/x", title: L("Onboarding emails", "E-mails de boas-vindas"), project: "growth", mtime: now - 260000 },
      { sessionId: "g", cwd: "/x", title: L("Terraform for the staging cluster", "Terraform do cluster de staging"), project: "infra", mtime: now - 400000 },
    ],
    folders: [
      { cwd: "/x", project: "api-gateway", short: "~/code/api-gateway" },
      { cwd: "/x", project: "web-app", short: "~/code/web-app" },
      { cwd: "/x", project: "storefront", short: "~/code/storefront" },
      { cwd: "/x", project: "media-worker", short: "~/code/media-worker" },
      { cwd: "/x", project: "docs", short: "~/code/docs" },
    ],
  };
};
