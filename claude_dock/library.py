"""Biblioteca de sessões: todas as conversas, com nomes, notas, favoritos e lixeira.

Os metadados ficam no mesmo ``metadata.json`` do Claude Sessions Manager quando
ele está instalado, então os dois mostram os mesmos nomes e favoritos. Sem ele,
o dock usa um arquivo próprio no mesmo formato.

Nada aqui grava em ``~/.claude``: a lixeira só marca a sessão nos metadados.
"""

import fcntl
import json
import os
import re
import subprocess
import time
from pathlib import Path

from .sessions import PROJECTS_DIR, transcript_info

OWN_DATA_DIR = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "claude-dock"
LOCK_FILE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "claude-dock" / "metadata.lock"
DEFAULT_MANAGER_DIRS = ("/var/www/html/claude-sessions",)
APACHE_CONF_GLOBS = ("/etc/apache2/conf-enabled/*.conf", "/etc/apache2/sites-enabled/*.conf",
                     "/etc/httpd/conf.d/*.conf")
AUTO_TRASH_MAX_DAYS = 3650
SEARCH_MAX_HITS = 40          # linhas casadas lidas por arquivo na busca no conteúdo
SNIPPET = 70                  # caracteres de contexto de cada lado do trecho achado
_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


class MetadataUnreadable(Exception):
    """metadata.json existe mas não deu pra ler. Gravar por cima apagaria
    todos os nomes e notas, então quem grava tem que recusar."""


# ------------------------------------------------------------ onde ficam os dados

def _manager_from_apache():
    """Pasta de instalação do Sessions Manager lida da config do Apache."""
    import glob
    for pattern in APACHE_CONF_GLOBS:
        for conf in glob.glob(pattern):
            try:
                text = Path(conf).read_text(errors="replace")
            except OSError:
                continue
            for m in re.finditer(r"^\s*WSGIScriptAlias\s+(\S+)/api\s+(\S+)/app\.wsgi", text, re.M):
                yield m.group(2), m.group(1)


def find_manager(override=None):
    """{'dir', 'url'} do Sessions Manager instalado, ou None."""
    candidates = []
    if override:
        candidates.append((override, None))
    candidates += list(_manager_from_apache())
    candidates += [(d, "/claude-sessions") for d in DEFAULT_MANAGER_DIRS]
    for base, url_path in candidates:
        base = Path(base)
        if (base / "app.wsgi").is_file() and (base / "data").is_dir():
            url = f"http://localhost{url_path}/" if url_path else None
            return {"dir": str(base), "url": url}
    return None


class Store:
    def __init__(self, manager_dir=None):
        self.manager = find_manager(manager_dir)
        if self.manager and os.access(Path(self.manager["dir"]) / "data", os.W_OK):
            data = Path(self.manager["dir"]) / "data"
            self.shared = True
        else:
            data = OWN_DATA_DIR
            self.shared = False
        self.meta_file = data / "metadata.json"
        self.settings_file = data / "settings.json"

    # -------------------------------------------------------------- arquivos

    def load_metadata(self):
        if not self.meta_file.exists():
            return {}
        try:
            raw = self.meta_file.read_text(encoding="utf-8")
        except OSError as e:
            raise MetadataUnreadable(str(e))
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except ValueError as e:
            raise MetadataUnreadable(f"{self.meta_file}: {e}")
        if not isinstance(data, dict):
            raise MetadataUnreadable(f"{self.meta_file} is not a JSON object")
        return data

    def _write(self, path, data):
        # mesmo formato do Sessions Manager (indent 2, sem escapar acentos)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.dock.tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise

    def _locked(self):
        LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
        f = open(LOCK_FILE, "w")
        fcntl.flock(f, fcntl.LOCK_EX)
        return f

    def load_settings(self):
        try:
            data = json.loads(self.settings_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        try:
            days = int(data.get("auto_trash_days", 0)) if isinstance(data, dict) else 0
        except (TypeError, ValueError):
            days = 0
        return {"auto_trash_days": max(0, min(days, AUTO_TRASH_MAX_DAYS))}

    def save_settings(self, days):
        days = max(0, min(int(days), AUTO_TRASH_MAX_DAYS))
        try:
            current = json.loads(self.settings_file.read_text(encoding="utf-8"))
            if not isinstance(current, dict):
                current = {}
        except (OSError, ValueError):
            current = {}
        current["auto_trash_days"] = days
        self._write(self.settings_file, current)
        return days

    # --------------------------------------------------------------- edição

    def patch(self, ids, fields):
        """Aplica name/description/favorite/deleted em uma ou mais sessões.
        Mesmas regras do Sessions Manager (kept_at, auto_trashed_at)."""
        ids = [i for i in ids if isinstance(i, str) and _UUID.match(i)]
        if not ids:
            return False
        lock = self._locked()
        try:
            metadata = self.load_metadata()  # MetadataUnreadable sobe: nunca grava por cima
            for sid in ids:
                entry = metadata.get(sid, {})
                for key in ("name", "description", "favorite", "deleted"):
                    if key not in fields:
                        continue
                    val = fields[key]
                    if key in ("favorite", "deleted"):
                        val = bool(val)
                    elif isinstance(val, str):
                        val = val.strip()
                    else:
                        continue
                    entry[key] = val
                if "deleted" in fields:
                    entry.pop("auto_trashed_at", None)
                    if not entry.get("deleted"):
                        entry["kept_at"] = time.time()
                if not any(entry.get(k) for k in ("name", "description", "favorite", "deleted", "kept_at")):
                    metadata.pop(sid, None)
                else:
                    metadata[sid] = entry
            self._write(self.meta_file, metadata)
            return True
        finally:
            lock.close()

    def restore_snapshot(self, snapshot):
        """Desfazer: volta as entradas guardadas antes de uma ação."""
        lock = self._locked()
        try:
            metadata = self.load_metadata()
            for sid, entry in snapshot.items():
                if not _UUID.match(sid):
                    continue
                if entry:
                    metadata[sid] = entry
                else:
                    metadata.pop(sid, None)
            self._write(self.meta_file, metadata)
        finally:
            lock.close()

    # -------------------------------------------------------------- listagem

    def list_all(self):
        """(sessões, erro_de_metadados)."""
        try:
            metadata = self.load_metadata()
            meta_error = None
        except MetadataUnreadable as e:
            metadata, meta_error = {}, str(e)
        out = []
        try:
            files = list(PROJECTS_DIR.glob("*/*.jsonl"))
        except OSError:
            files = []
        for p in files:
            info = transcript_info(p)
            if not info:
                continue
            sid = p.stem
            meta = metadata.get(sid, {})
            if not (info.get("first") or info.get("title") or meta.get("name")):
                continue  # sessão vazia (abriu e fechou sem conversar)
            cwd = info.get("cwd") or ""
            out.append({
                "id": sid,
                "cwd": cwd,
                "folder": p.parent.name,
                "project": os.path.basename(cwd.rstrip("/")) or p.parent.name,
                "title": info.get("custom_title") or info.get("title") or "",
                "first": info.get("first") or "",
                "branch": info.get("branch"),
                "tokens": info.get("tokens"),
                "size": info.get("size") or 0,
                "mtime": info["mtime"],
                "exists": bool(cwd) and os.path.isdir(cwd),
                "name": meta.get("name", "") if isinstance(meta.get("name"), str) else "",
                "notes": meta.get("description", "") if isinstance(meta.get("description"), str) else "",
                "favorite": bool(meta.get("favorite")),
                "deleted": bool(meta.get("deleted")),
                "keptAt": meta.get("kept_at") or 0,
                "autoTrashedAt": meta.get("auto_trashed_at"),
            })
        out.sort(key=lambda s: s["mtime"], reverse=True)
        if not meta_error:
            self._auto_trash(out)
        return out, meta_error

    def _auto_trash(self, items):
        """Mesma regra do Sessions Manager: manda pra lixeira o que está parado há
        mais de N dias (favoritas nunca) e tira de lá o que voltou a ser usado."""
        days = self.load_settings()["auto_trash_days"]
        now = time.time()
        cutoff = now - days * 86400
        changes = {}
        for s in items:
            kept = s["keptAt"] if isinstance(s["keptAt"], (int, float)) else 0
            if s["deleted"] and s["autoTrashedAt"] and s["mtime"] > s["autoTrashedAt"]:
                changes[s["id"]] = "restore"
                s["deleted"] = False
            elif days and not s["deleted"] and not s["favorite"] and max(s["mtime"], kept) < cutoff:
                changes[s["id"]] = "trash"
                s["deleted"] = True
        if not changes:
            return
        lock = self._locked()
        try:
            metadata = self.load_metadata()
            for sid, what in changes.items():
                entry = metadata.get(sid, {})
                if what == "restore":
                    entry["deleted"] = False
                    entry.pop("auto_trashed_at", None)
                else:
                    entry["deleted"] = True
                    entry["auto_trashed_at"] = now
                metadata[sid] = entry
            self._write(self.meta_file, metadata)
        except (MetadataUnreadable, OSError):
            pass
        finally:
            lock.close()

    def names(self):
        """id -> {name, deleted}: usado pela aba Recentes do painel."""
        try:
            md = self.load_metadata()
        except MetadataUnreadable:
            return {}
        return {k: v for k, v in md.items() if isinstance(v, dict)}


# ----------------------------------------------------------- busca no conteúdo

def _text_parts(obj):
    if obj.get("type") not in ("user", "assistant") or obj.get("isMeta"):
        return []
    msg = obj.get("message") or {}
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return [content]
    out = []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                out.append(part.get("text") or "")
    return out


def _snippet(text, q):
    low = text.lower()
    i = low.find(q)
    if i < 0:
        return None
    a, b = max(0, i - SNIPPET), min(len(text), i + len(q) + SNIPPET)
    s = " ".join(text[a:b].split())
    return ("…" if a else "") + s + ("…" if b < len(text) else "")


def search_content(q, ids=None):
    """{sessionId: trecho} das conversas cujo texto (seu ou do Claude) contém q."""
    q = (q or "").strip().lower()
    if len(q) < 2:
        return {}
    try:
        files = [str(p) for p in PROJECTS_DIR.glob("*/*.jsonl")]
    except OSError:
        return {}
    if ids is not None:
        files = [f for f in files if Path(f).stem in ids]
    if not files:
        return {}
    try:
        r = subprocess.run(["grep", "-l", "-i", "-F", "--", q, *files],
                           capture_output=True, text=True, timeout=20)
        candidates = r.stdout.splitlines()
    except (OSError, subprocess.TimeoutExpired):
        candidates = files
    hits = {}
    if not candidates:
        return hits
    # uma chamada só; -Z separa o nome do arquivo com \0
    try:
        r = subprocess.run(["grep", "-i", "-F", "-H", "-Z", "-m", str(SEARCH_MAX_HITS), "--", q, *candidates],
                           capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return hits
    for raw in r.stdout.split(b"\n"):
        name, sep, line = raw.partition(b"\0")
        if not sep:
            continue
        sid = Path(name.decode(errors="replace")).stem
        if sid in hits:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        for text in _text_parts(obj):
            snip = _snippet(text, q)
            if snip and not text.lstrip().startswith("<"):
                hits[sid] = snip
                break
    return hits


if __name__ == "__main__":
    st = Store()
    print("manager:", st.manager, "shared:", st.shared, st.meta_file)
    items, err = st.list_all()
    print(len(items), "sessions", "meta_error:", err)
    print([s for s in items if s["name"]][:2])
    t0 = time.time()
    print(list(search_content("rubymine").items())[:3], round(time.time() - t0, 2), "s")
