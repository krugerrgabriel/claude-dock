"""Leitura das sessões do Claude Code direto do disco, sem hooks.

- Ao vivo: ``~/.claude/sessions/<pid>.json`` é mantido pelo próprio Claude Code
  enquanto a sessão roda (cwd, sessionId, status busy/idle...). Arquivo de PID
  morto ou reaproveitado é descartado comparando ``procStart`` com /proc.
- Histórico: ``~/.claude/projects/<pasta>/<sessionId>.jsonl``.
"""

import json
import os
from pathlib import Path

CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
SESSIONS_DIR = CLAUDE_DIR / "sessions"
PROJECTS_DIR = CLAUDE_DIR / "projects"

HEAD_LINES = 400          # linhas lidas do começo do transcript (cwd, 1ª mensagem)
HEAD_SCAN_MAX = 3000      # teto pra sessões sem nenhuma mensagem do usuário
TAIL_BYTES = 256 * 1024   # bytes lidos do fim (título mais recente)
HISTORY_LIMIT = 60

# comm do processo ancestral -> (chave, rótulo)
HOSTS = {
    "ghostty": ("ghostty", "Ghostty"),
    "rubymine": ("jetbrains", "RubyMine"),
    "idea": ("jetbrains", "IntelliJ"),
    "pycharm": ("jetbrains", "PyCharm"),
    "webstorm": ("jetbrains", "WebStorm"),
    "goland": ("jetbrains", "GoLand"),
    "phpstorm": ("jetbrains", "PhpStorm"),
    "clion": ("jetbrains", "CLion"),
    "datagrip": ("jetbrains", "DataGrip"),
    "rider": ("jetbrains", "Rider"),
    "android-studio": ("jetbrains", "Android Studio"),
    "code": ("vscode", "VS Code"),
    "cursor": ("vscode", "Cursor"),
    "gnome-terminal-": ("terminal", "Terminal"),
    "ptyxis": ("terminal", "Ptyxis"),
    "kitty": ("terminal", "kitty"),
    "alacritty": ("terminal", "Alacritty"),
    "wezterm-gui": ("terminal", "WezTerm"),
    "konsole": ("terminal", "Konsole"),
    "tilix": ("terminal", "Tilix"),
    "terminator": ("terminal", "Terminator"),
    "xterm": ("terminal", "xterm"),
    "tmux: server": ("tmux", "tmux"),
}


# ---------------------------------------------------------------- /proc

def _stat_fields(pid):
    """Campos de /proc/<pid>/stat a partir do 3º (o comm pode ter espaços)."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return raw.rsplit(")", 1)[1].split()


def _alive(pid, proc_start):
    fields = _stat_fields(pid)
    if not fields:
        return False
    # campo 22 (starttime) => índice 19 depois do comm
    return proc_start is None or fields[19] == str(proc_start)


def _comm(pid):
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


def find_host(pid):
    """Sobe a árvore de processos até achar o terminal/IDE que hospeda a sessão."""
    seen = 0
    cur = pid
    while cur and cur > 1 and seen < 40:
        seen += 1
        comm = _comm(cur)
        for prefix, (kind, label) in HOSTS.items():
            if comm == prefix or comm.startswith(prefix):
                return {"kind": kind, "label": label, "pid": cur}
        fields = _stat_fields(cur)
        if not fields:
            break
        cur = int(fields[1])  # ppid
    return {"kind": "unknown", "label": "Terminal", "pid": None}


# ----------------------------------------------------------- transcripts

_cache = {}  # path -> (mtime, size, info)
_cache_dirty = False
CACHE_FILE = Path.home() / ".cache" / "claude-dock" / "transcripts.json"
CACHE_VERSION = 2


def load_cache():
    """Traz do disco o que já foi lido em execuções anteriores (abre sem reler tudo)."""
    try:
        data = json.loads(CACHE_FILE.read_text())
    except (OSError, ValueError):
        return
    if not isinstance(data, dict) or data.get("v") != CACHE_VERSION:
        return
    for key, entry in (data.get("files") or {}).items():
        try:
            mtime, size, info = entry
        except (TypeError, ValueError):
            continue
        if isinstance(info, dict):
            _cache.setdefault(Path(key), (mtime, size, info))


def save_cache():
    global _cache_dirty
    if not _cache_dirty:
        return
    _cache_dirty = False
    files = {str(k): list(v) for k, v in list(_cache.items()) if k.exists()}
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"v": CACHE_VERSION, "files": files}, ensure_ascii=False))
        os.replace(tmp, CACHE_FILE)
    except OSError:
        pass


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                return part.get("text", "")
    return ""


def _clean_prompt(text):
    text = (text or "").strip()
    if not text or text.startswith("<") or text.startswith("Caveat:"):
        # comandos internos (<command-name>, <local-command-stdout>...) e avisos
        return ""
    return " ".join(text.split())[:160]


def transcript_info(path):
    """cwd, branch, 1ª mensagem e título (ai-title/custom-title) de um .jsonl."""
    try:
        st = path.stat()
    except OSError:
        return None
    hit = _cache.get(path)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]

    info = {"cwd": None, "branch": None, "first": None, "title": None,
            "custom_title": None, "tokens": None, "mtime": st.st_mtime, "size": st.st_size}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if info["first"] and info["cwd"] and (info["branch"] or i >= HEAD_LINES):
                    break
                if i >= HEAD_SCAN_MAX:
                    break
                # só decodifica o que pode trazer algo que ainda falta (linhas de
                # ferramenta chegam a ter megabytes)
                if info["cwd"] and info["branch"] and '"user"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                info["cwd"] = info["cwd"] or obj.get("cwd")
                info["branch"] = info["branch"] or obj.get("gitBranch")
                if not info["first"] and obj.get("type") == "user" and not obj.get("isMeta"):
                    msg = obj.get("message") or {}
                    if isinstance(msg, dict):
                        info["first"] = _clean_prompt(_text_of(msg.get("content"))) or None
        with open(path, "rb") as f:
            f.seek(max(0, st.st_size - TAIL_BYTES))
            tail = f.read().decode("utf-8", errors="replace").splitlines()
        for line in reversed(tail):
            if info["tokens"] is None and '"usage"' in line and '"assistant"' in line:
                # contexto ocupado no fim da conversa = entrada + cache da última resposta
                try:
                    msg = json.loads(line).get("message") or {}
                    u = msg.get("usage") if isinstance(msg, dict) else None
                    if isinstance(u, dict):
                        info["tokens"] = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) \
                            + (u.get("cache_creation_input_tokens") or 0) or None
                except (ValueError, AttributeError):
                    pass
            if '"ai-title"' not in line and '"custom-title"' not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("type") == "custom-title" and not info["custom_title"]:
                info["custom_title"] = obj.get("customTitle")
            if obj.get("type") == "ai-title" and not info["title"]:
                info["title"] = obj.get("aiTitle")
            if info["title"] and info["custom_title"] and info["tokens"] is not None:
                break
    except OSError:
        return None

    global _cache_dirty
    _cache[path] = (st.st_mtime, st.st_size, info)
    _cache_dirty = True
    return info


def warm_all():
    """Lê (ou confirma no cache) todos os transcripts; roda numa thread."""
    try:
        files = list(PROJECTS_DIR.glob("*/*.jsonl"))
    except OSError:
        return
    for p in files:
        try:
            transcript_info(p)
        except Exception:  # noqa: BLE001
            pass


def _transcript_path(session_id):
    for p in PROJECTS_DIR.glob(f"*/{session_id}.jsonl"):
        return p
    return None


def _display_title(info, fallback):
    if info:
        return info.get("custom_title") or info.get("title") or info.get("first") or fallback
    return fallback


# ------------------------------------------------------------------ API

def live_sessions():
    out = []
    try:
        files = list(SESSIONS_DIR.glob("*.json"))
    except OSError:
        files = []
    for f in files:
        try:
            d = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        pid = d.get("pid")
        if not isinstance(pid, int) or not _alive(pid, d.get("procStart")):
            continue
        sid = d.get("sessionId")
        tpath = _transcript_path(sid) if sid else None
        info = transcript_info(tpath) if tpath else None
        cwd = d.get("cwd") or (info or {}).get("cwd") or ""
        out.append({
            "pid": pid,
            "sessionId": sid,
            "cwd": cwd,
            "project": os.path.basename(cwd.rstrip("/")) or "~",
            "title": _display_title(info, None),  # None = a UI mostra "Nova sessão"
            "aiTitle": (info or {}).get("title"),
            "branch": (info or {}).get("branch"),
            "status": d.get("status") or "idle",
            "statusSince": (d.get("statusUpdatedAt") or d.get("startedAt") or 0) / 1000,
            "startedAt": (d.get("startedAt") or 0) / 1000,
            "kind": d.get("kind"),
            "host": find_host(pid),
        })
    out.sort(key=lambda s: s["startedAt"])
    return out


def history(exclude_ids=()):
    exclude = set(exclude_ids)
    try:
        files = [p for p in PROJECTS_DIR.glob("*/*.jsonl")]
    except OSError:
        return []
    files.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    out = []
    for p in files:
        if len(out) >= HISTORY_LIMIT:
            break
        sid = p.stem
        if sid in exclude:
            continue
        info = transcript_info(p)
        if not info or not info.get("first") and not info.get("title"):
            continue  # sessão vazia / só comandos
        cwd = info.get("cwd") or ""
        if cwd and not os.path.isdir(cwd):
            continue
        out.append({
            "sessionId": sid,
            "cwd": cwd,
            "project": os.path.basename(cwd.rstrip("/")) or "~",
            "title": _display_title(info, sid[:8]),
            "branch": info.get("branch"),
            "mtime": info["mtime"],
        })
    return out


def recent_folders(hist, live, limit=8):
    seen, out = set(), []
    for s in list(live) + list(hist):
        cwd = s.get("cwd")
        if cwd and cwd not in seen and os.path.isdir(cwd):
            seen.add(cwd)
            out.append({"cwd": cwd, "project": s["project"],
                        "short": cwd.replace(str(Path.home()), "~", 1)})
        if len(out) >= limit:
            break
    return out


if __name__ == "__main__":
    import pprint
    live = live_sessions()
    pprint.pprint(live)
    h = history([s["sessionId"] for s in live])
    pprint.pprint(h[:5])
    pprint.pprint(recent_folders(h, live))
