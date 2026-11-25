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
    config: { islandUsage: true, language: "auto", clickAction: "open", recap: { mode: "simple" }, summary: { enabled: true },
      usage: { plan: true, rings: true, session: true, week: true, paceMarker: true, resetTime: true, models: false, spent: false } },
    usage: {
      ok: true, plan: "max", fetchedAt: now - 40,
      session: { pct: 64, resetsAt: iso(2.4 * 3600) },
      forecastAt: now + 1.7 * 3600,   // previsão de limite: acaba antes do reset
      week: { pct: 61, resetsAt: iso(3.2 * 86400) },
      weekStartedAt: iso(-3.8 * 86400),
      models: [{ name: "Opus", pct: 44, resetsAt: iso(3.2 * 86400) }],
      spent: [{ name: "Claude Code", pct: 81 }, { name: "Chats", pct: 12 }, { name: "Cowork", pct: 7 }],
    },
    live: [
      { pid: 1, title: L("Fix flaky checkout tests", "Corrigir testes instáveis do checkout"), project: "storefront", status: "busy", statusSince: now - 274, host: JB },
      { pid: 2, title: L("Migrate auth to OAuth 2.1", "Migrar autenticação pro OAuth 2.1"), project: "api-gateway", status: "idle", statusSince: now - 200, unseenAt: now - 190, host: GH,
        recap: L("Refresh token rotation is done; PKCE on the mobile client is still missing.", "Rotação do refresh token pronta; falta o PKCE no app mobile.") },
      { pid: 3, title: L("Dark mode for the settings page", "Modo escuro na tela de configurações"), project: "web-app", status: "busy", statusSince: now - 61, host: VS },
      { pid: 4, title: L("Review PR #482 (rate limiter)", "Revisar PR #482 (rate limiter)"), project: "api-gateway", status: "waiting", waitingFor: "permission", statusSince: now - 30, host: GH },
      { pid: 5, title: L("Write the release notes", "Escrever as notas da versão"), project: "docs", status: "idle", statusSince: now - 3000, host: GH,
        recap: L("Drafted the 2.4 notes from 18 merged PRs, waiting for your review.", "Rascunhei as notas da 2.4 a partir de 18 PRs, falta sua revisão.") },
      { pid: 6, title: L("Speed up the image pipeline", "Acelerar o pipeline de imagens"), project: "media-worker", status: "idle", statusSince: now - 3.3 * 3600, host: JB,
        recap: L("Moved resizing to a worker pool; benchmarks still to run.", "Passei o resize pra um pool de workers; falta rodar o benchmark."),
        forgotten: { since: now - 3.3 * 3600, files: 4 } },
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
    ask: {
      history: [L("which tests broke in the last CI run?", "quais testes quebraram no último CI?"), L("where is the coupon discount computed?", "onde o desconto do cupom é calculado?")],
      default: { cwd: "/home/you/code/storefront", project: "storefront", short: "~/code/storefront" },
      shortcut: "<Control><Alt>space",
      unseen: false,
    },
    folders: [
      { cwd: "/home/you/code/storefront", project: "storefront", short: "~/code/storefront" },
      { cwd: "/x", project: "api-gateway", short: "~/code/api-gateway" },
      { cwd: "/x", project: "web-app", short: "~/code/web-app" },
      { cwd: "/x", project: "media-worker", short: "~/code/media-worker" },
      { cwd: "/x", project: "docs", short: "~/code/docs" },
    ],
  };
};

// Resposta fictícia do comando rápido, em pedaços, pra simular a transmissão.
window.dockAskDemo = (lang, prompt) => {
  const pt = lang === "pt";
  const text = pt
    ? "3 testes falharam em `spec/checkout_spec.rb`, todos ligados ao cupom:\n\n" +
      "- **aplica cupom expirado** (linha 88): espera erro, mas o desconto entra\n" +
      "- **cupom com valor mínimo** (linha 112): o total é comparado antes do frete\n" +
      "- **dois cupons no mesmo pedido** (linha 140): o segundo não é recusado\n\n" +
      "A causa provável é `Coupon#valid?`, que ignora `expires_at` quando o fuso é UTC:\n\n" +
      "```ruby\nreturn true if expires_at.nil? || expires_at > Time.current\n```\n\n" +
      "Quer que eu corrija? Continue no terminal pra eu poder editar."
    : "3 tests failed in `spec/checkout_spec.rb`, all related to coupons:\n\n" +
      "- **applies an expired coupon** (line 88): expects an error, but the discount goes through\n" +
      "- **coupon with a minimum amount** (line 112): the total is checked before shipping\n" +
      "- **two coupons on one order** (line 140): the second one isn't rejected\n\n" +
      "The likely cause is `Coupon#valid?`, which skips `expires_at` when the zone is UTC:\n\n" +
      "```ruby\nreturn true if expires_at.nil? || expires_at > Time.current\n```\n\n" +
      "Want me to fix it? Continue in the terminal so I can edit files.";
  const now = Date.now() / 1000;
  return {
    prompt: prompt || (pt ? "quais testes quebraram no último CI?" : "which tests broke in the last CI run?"),
    cwd: "/home/you/code/storefront", project: "storefront", short: "~/code/storefront",
    mode: "read", model: "haiku", sessionId: "3f2a9c1e-7d4b-4e21-9a8f-1c2b3d4e5f60",
    startedAt: now - 9, endedAt: null, status: "running", streaming: false, error: null,
    tools: [
      { kind: "tool", tool: "Glob", arg: "spec/**/*_spec.rb" },
      { kind: "tool", tool: "Read", arg: "ci-latest.log" },
      { kind: "tool", tool: "Read", arg: "checkout_spec.rb" },
    ],
    text,
  };
};

// Resumo de hoje fictício (botão "Resumo de hoje" na prévia).
window.dockSumDemo = (lang) => (lang === "pt"
  ? "**storefront**\n- Corrigi os testes instáveis do checkout: o cupom expirado passava quando o fuso era UTC\n- Falta rodar a suíte completa no CI\n\n" +
    "**api-gateway**\n- Terminei a rotação do refresh token no OAuth 2.1; falta o PKCE no app mobile\n- Revisei o PR #482 do rate limiter e apontei duas condições de corrida\n\n" +
    "**media-worker**\n- Passei o resize pra um pool de workers (3 commits); o benchmark ficou pra amanhã\n\n" +
    "**docs**\n- Rascunhei as notas da versão 2.4 a partir dos PRs mergeados"
  : "**storefront**\n- Fixed the flaky checkout tests: expired coupons went through when the zone was UTC\n- Still need to run the full suite on CI\n\n" +
    "**api-gateway**\n- Finished refresh token rotation for OAuth 2.1; PKCE on the mobile client is next\n- Reviewed PR #482 (rate limiter) and flagged two race conditions\n\n" +
    "**media-worker**\n- Moved resizing to a worker pool (3 commits); benchmarks are for tomorrow\n\n" +
    "**docs**\n- Drafted the 2.4 release notes from the merged PRs");
