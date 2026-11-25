"""Como o dock chama o `claude -p`: binário, ambiente e as flags comuns.

Tudo que o dock roda (comando rápido, "onde parei" com IA, resumo do dia) passa
por aqui, pra nenhum filho carregar os hooks do usuário (um SessionStart que
injeta lembretes contaminava as respostas) nem herdar marcas da sessão de quem
abriu o dock.
"""

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

from .sessions import CLAUDE_DIR

CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "claude-dock"

# marcas de "estou dentro de uma sessão do Claude": se o dock foi aberto de dentro
# de uma, o `claude -p` filho não pode herdar isso
_SESSION_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
                "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_CHILD_NOTES_DIR", "CLAUDE_CODE_MESSAGING_SOCKET",
                "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "AI_AGENT")

# pids dos `claude -p` do dock: eles também criam ~/.claude/sessions/<pid>.json
# e não podem aparecer como sessões abertas
_children = set()
_lock = threading.Lock()


def claude_bin():
    found = shutil.which("claude")
    if found:
        return found
    local = Path.home() / ".local" / "bin" / "claude"
    return str(local) if local.exists() else None


def child_env():
    return {k: v for k, v in os.environ.items() if k not in _SESSION_ENV}


def base_argv(binary, light=False):
    """`claude -p` sem hooks. light = texto puro (recap, resumo): sem ferramentas,
    MCP, skills, CLAUDE.md do usuário nem transcript salvo; sobe mais rápido."""
    settings = {"disableAllHooks": True}
    if light:
        settings["claudeMdExcludes"] = [str(CLAUDE_DIR / "CLAUDE.md")]
    argv = [binary, "-p", "--settings", json.dumps(settings)]
    if light:
        argv += ["--strict-mcp-config", "--no-session-persistence", "--tools", "",
                 "--disable-slash-commands"]
    return argv


def track(pid):
    with _lock:
        _children.add(pid)


def untrack(pid):
    with _lock:
        _children.discard(pid)


def children():
    with _lock:
        return set(_children)


def run_text(prompt, system, model=None, timeout=120):
    """Roda um `claude -p` leve e devolve (texto, erro). Bloqueante: chamar numa thread.

    Roda numa pasta neutra (o cache do dock) pra não puxar CLAUDE.md nem memória
    de projeto nenhum; o pedido vai pelo stdin (pode ser grande)."""
    binary = claude_bin()
    if not binary:
        return None, "noClaude"
    argv = base_argv(binary, light=True) + ["--system-prompt", system]
    if model:
        argv += ["--model", model]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.Popen(argv, cwd=str(CACHE_DIR), env=child_env(), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as e:
        return None, str(e)
    track(proc.pid)
    try:
        out, err = proc.communicate(prompt.encode("utf-8"), timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return None, "timeout"
    finally:
        untrack(proc.pid)
    text = out.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not text:
        msg = (err.decode("utf-8", "replace").strip() or text or f"exit {proc.returncode}")
        return None, msg[-300:]
    return text, None
