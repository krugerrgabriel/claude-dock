"""Checa se saiu uma release nova no GitHub e aplica a atualização.

- Cópia instalada (install.sh): roda o install.sh de novo, que baixa a release,
  troca os arquivos, fecha este dock e abre o novo.
- Clone git (desenvolvimento): git pull --ff-only e reinicia.
"""

import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

REPO = "krugerrgabriel/claude-dock"
ROOT = Path(__file__).resolve().parent.parent
API = f"https://api.github.com/repos/{REPO}/releases/latest"
INSTALL_SH = f"https://raw.githubusercontent.com/{REPO}/main/install.sh"
LOG = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "claude-dock" / "update.log"


def current_version():
    # CLAUDE_DOCK_FAKE_VERSION simula uma versão antiga (testar o aviso)
    fake = os.environ.get("CLAUDE_DOCK_FAKE_VERSION")
    if fake:
        return fake
    try:
        return (ROOT / "VERSION").read_text().strip()
    except OSError:
        return "0.0.0"


def _parse(v):
    nums = [int(n) for n in re.findall(r"\d+", v or "")[:3]]
    return tuple(nums + [0] * (3 - len(nums)))


def method():
    return "git" if (ROOT / ".git").exists() else "installer"


def check():
    """Bloqueante. None se não deu pra consultar (sem rede, rate limit...)."""
    cur = current_version()
    req = urllib.request.Request(API, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": f"claude-dock/{cur}",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except (OSError, ValueError):
        return None
    latest = (data.get("tag_name") or "").lstrip("vV")
    if not latest:
        return None
    return {
        "current": cur,
        "latest": latest,
        "available": _parse(latest) > _parse(cur),
        "url": data.get("html_url") or f"https://github.com/{REPO}/releases/latest",
        "method": method(),
    }


def _detached(cmd):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    log = open(LOG, "ab")
    # o dock reaberto não herda as variáveis de teste (PEEK=applyUpdate viraria loop)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_DOCK_")}
    subprocess.Popen(["sh", "-c", cmd], start_new_session=True, env=env,
                     stdin=subprocess.DEVNULL, stdout=log, stderr=log)


def restart_later():
    """Abre o dock de novo depois que este sair (o app é de instância única)."""
    _detached(f'sleep 1; cd "{ROOT}" && exec python3 -m claude_dock')


def apply():
    """Bloqueante. Devolve (ok, precisa_sair). No modo instalador o próprio
    install.sh fecha este processo e abre o novo."""
    if method() == "git":
        r = subprocess.run(["git", "-C", str(ROOT), "pull", "--ff-only"],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, False
        restart_later()
        return True, True
    _detached(f"curl -fsSL {INSTALL_SH} | sh")
    return True, False


if __name__ == "__main__":
    print(json.dumps(check(), indent=1))
