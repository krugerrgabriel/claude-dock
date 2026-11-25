"""Consumo do plano Claude (janela de 5h, semana, por modelo) via endpoint OAuth.

Usa o token que o próprio Claude Code mantém em ~/.claude/.credentials.json.
Sem o User-Agent claude-code o endpoint cai num rate limit agressivo (429).
"""

import json
import time
import urllib.error
import urllib.request

from .sessions import CLAUDE_DIR

CREDS_PATH = CLAUDE_DIR / ".credentials.json"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
HEADERS = {
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.172",
}


def _creds():
    try:
        return json.loads(CREDS_PATH.read_text()).get("claudeAiOauth") or {}
    except (OSError, ValueError):
        return {}


def _window(raw):
    if not isinstance(raw, dict) or raw.get("utilization") is None:
        return None
    # util = valor sem arredondar, usado na previsão de limite
    return {"pct": round(raw["utilization"]), "util": raw["utilization"], "resetsAt": raw.get("resets_at")}


def _parse(data, creds):
    week = _window(data.get("seven_day"))
    breakdown = data.get("seven_day_breakdown") or {}

    models = []
    for lim in data.get("limits") or []:
        model = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
        if lim.get("kind") == "weekly_scoped" and model:
            models.append({"name": model, "pct": lim.get("percent") or 0,
                           "resetsAt": lim.get("resets_at")})
    for key, name in (("seven_day_opus", "Opus"), ("seven_day_sonnet", "Sonnet")):
        w = _window(data.get(key))
        if w and not any(m["name"] == name for m in models):
            models.append({"name": name, **w})

    spent = [{"name": r.get("display_name") or r.get("key"), "pct": r.get("percent") or 0}
             for r in breakdown.get("rows") or [] if (r.get("percent") or 0) > 0]

    extra = data.get("extra_usage") or {}
    return {
        "ok": True,
        "plan": creds.get("subscriptionType"),
        "session": _window(data.get("five_hour")),
        "week": week,
        "weekStartedAt": breakdown.get("window_started_at"),
        "models": models,
        "spent": spent,
        "extra": ({"pct": round(extra["utilization"])}
                  if extra.get("is_enabled") and extra.get("utilization") is not None else None),
    }


def fetch():
    """Bloqueante (chamar fora da thread do GTK). Sempre devolve um dict."""
    now = time.time()
    creds = _creds()
    token = creds.get("accessToken")
    if not token:
        return {"ok": False, "error": "login", "fetchedAt": now}
    req = urllib.request.Request(USAGE_URL, headers={**HEADERS, "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            stale = (creds.get("expiresAt") or 0) / 1000 < now - 3600
            msg = "stale" if stale else "expired"
        elif e.code == 429:
            msg = "rate"
        else:
            msg = f"http:{e.code}"
        return {"ok": False, "error": msg, "fetchedAt": now, "plan": creds.get("subscriptionType")}
    except (OSError, ValueError):
        return {"ok": False, "error": "offline", "fetchedAt": now, "plan": creds.get("subscriptionType")}
    out = _parse(data, creds)
    out["fetchedAt"] = now
    return out


if __name__ == "__main__":
    print(json.dumps(fetch(), indent=1, ensure_ascii=False))
