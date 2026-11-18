// Dados fictícios pra abrir a janela num navegador (prints do README, desenvolvimento).
// Só é usado quando a página roda fora do app (sem a ponte do WebKit).
window.libDemo = (lang) => {
  const now = Date.now() / 1000;
  const pt = lang === "pt";
  const L = (en, ptText) => (pt ? ptText : en);
  const H = "/home/you/code/";
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const s = (project, title, first, ago, extra = {}) => ({
    id: id(), cwd: H + project, folder: "-home-you-code-" + project, project,
    title, first, branch: extra.branch || "main", tokens: extra.tokens || 0, size: extra.size || 0,
    mtime: now - ago, exists: true, name: extra.name || "", notes: extra.notes || "",
    favorite: !!extra.favorite, deleted: !!extra.deleted, keptAt: 0, autoTrashedAt: null,
  });

  const items = [
    s("storefront", L("Fix flaky checkout tests", "Corrigir testes instáveis do checkout"),
      L("the checkout specs fail about one run in five on CI, can you find out why", "os testes do checkout falham uma vez a cada cinco no CI, descobre o porquê"),
      120, { branch: "fix/checkout-flaky", tokens: 96400, size: 3.1e6 }),
    s("api-gateway", L("Migrate auth to OAuth 2.1", "Migrar autenticação pro OAuth 2.1"),
      L("we need to drop the implicit flow before the audit", "precisamos tirar o implicit flow antes da auditoria"),
      900, { branch: "feat/oauth21", tokens: 188200, size: 9.4e6, favorite: true, name: L("OAuth 2.1 migration", "Migração OAuth 2.1"),
        notes: L("Refresh token rotation done. Still missing: PKCE on the mobile client.", "Rotação do refresh token pronta. Falta: PKCE no app mobile.") }),
    s("web-app", L("Dark mode for the settings page", "Modo escuro na tela de configurações"),
      L("add a dark theme to settings using the existing tokens", "coloca tema escuro nas configurações usando os tokens que já existem"),
      61, { branch: "feat/dark-settings", tokens: 41800, size: 1.2e6 }),
    s("api-gateway", L("Review PR #482 (rate limiter)", "Revisar PR #482 (rate limiter)"),
      L("review the rate limiter PR and point out race conditions", "revisa o PR do rate limiter e aponta condições de corrida"),
      30, { branch: "review/482", tokens: 22900, size: 0.6e6 }),
    s("media-worker", L("Speed up the image pipeline", "Acelerar o pipeline de imagens"),
      L("thumbnails take 4s each, profile the worker and suggest fixes", "as miniaturas levam 4s cada, faz o profile do worker e sugere correções"),
      1500, { branch: "perf/thumbs", tokens: 152300, size: 6.8e6, favorite: true }),
    s("api-gateway", L("Add Stripe webhooks", "Adicionar webhooks do Stripe"),
      L("handle invoice.paid and customer.subscription.deleted", "tratar invoice.paid e customer.subscription.deleted"),
      5200, { branch: "feat/stripe-webhooks", tokens: 73100, size: 2.4e6 }),
    s("web-app", L("Refactor the API client", "Refatorar o cliente da API"),
      L("split the API client into one module per resource", "separa o cliente da API num módulo por recurso"),
      9800, { tokens: 205400, size: 11.2e6, notes: L("Paused: waiting for the backend to ship v2 routes.", "Pausado: esperando o backend subir as rotas v2.") }),
    s("media-worker", L("Investigate memory leak in workers", "Investigar vazamento de memória nos workers"),
      L("RSS grows 200MB an hour on the resize worker", "o RSS cresce 200MB por hora no worker de resize"),
      90000, { branch: "fix/leak", tokens: 118000, size: 4.9e6 }),
    s("api-gateway", L("API pagination with cursors", "Paginação da API com cursores"),
      L("replace offset pagination with cursors on /orders", "troca a paginação por offset por cursores no /orders"),
      100000, { tokens: 64000, size: 2.1e6 }),
    s("growth", L("Onboarding emails", "E-mails de boas-vindas"),
      L("write a 3 email onboarding sequence", "escreve uma sequência de 3 e-mails de boas-vindas"),
      260000, { tokens: 18700, size: 0.4e6 }),
    s("infra", L("Terraform for the staging cluster", "Terraform do cluster de staging"),
      L("port the staging cluster to terraform modules", "passa o cluster de staging pra módulos do terraform"),
      400000, { branch: "infra/staging", tokens: 131000, size: 5.6e6, favorite: true }),
    s("docs", L("Write the release notes", "Escrever as notas da versão"),
      L("draft the 2.4 release notes from the merged PRs", "rascunha as notas da 2.4 a partir dos PRs mergeados"),
      3000, { tokens: 12000, size: 0.3e6 }),
    s("storefront", L("Coupon codes at checkout", "Cupons no checkout"),
      L("support percentage and fixed coupons", "suportar cupons de porcentagem e valor fixo"),
      700000, { tokens: 54000, size: 1.9e6 }),
    s("infra", L("Old CI experiments", "Experimentos antigos de CI"),
      L("try running the suite on arm runners", "testa a suíte em runners arm"),
      2600000, { tokens: 9000, size: 0.2e6, deleted: true }),
  ];
  const GH = { kind: "ghostty", label: "Ghostty" };
  const JB = { kind: "jetbrains", label: "RubyMine" };
  const VS = { kind: "vscode", label: "VS Code" };
  return {
    items,
    live: {
      [items[0].id]: { pid: 1, status: "busy", host: JB },
      [items[1].id]: { pid: 2, status: "idle", host: GH },
      [items[2].id]: { pid: 3, status: "busy", host: VS },
      [items[3].id]: { pid: 4, status: "waiting", host: GH },
    },
    hits: { [items[7].id]: L("…the heap snapshot shows the sharp image buffers are never released after the resize, so the webhook retries keep…",
      "…o heap snapshot mostra que os buffers do sharp nunca são liberados depois do resize, então os retries do webhook continuam…") },
    metaError: null, shared: true, managerUrl: "http://localhost/claude-sessions/",
    autoTrashDays: 60, lang: pt ? "pt" : "en", home: "/home/you", undo: false, prefs: {},
  };
};
