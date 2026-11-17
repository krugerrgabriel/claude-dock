"""Achar e focar a janela X11 onde uma sessão está rodando (via wmctrl)."""

import os
import re
import shutil
import subprocess

_SPINNER = re.compile(r"^[^\w\s]{1,3}\s+")  # "◐ ", "✳ " etc. que o Claude põe no título


def _windows():
    if not shutil.which("wmctrl"):
        return []
    try:
        out = subprocess.run(["wmctrl", "-lp"], capture_output=True, text=True,
                             timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    wins = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        # id, desktop, pid, hostname, título
        wid, _desk, pid = parts[0], parts[1], parts[2]
        title = parts[4] if len(parts) == 5 else ""
        try:
            pid = int(pid)
        except ValueError:
            continue
        wins.append({"id": wid, "pid": pid, "title": title})
    return wins


def _norm(title):
    return _SPINNER.sub("", title or "").strip().lower()


def find_window(session):
    host = session.get("host") or {}
    hpid = host.get("pid")
    wins = [w for w in _windows() if hpid and w["pid"] == hpid]
    if not wins:
        return None
    if len(wins) == 1:
        return wins[0]["id"]

    kind = host.get("kind")
    project = (session.get("project") or "").lower()
    if kind == "jetbrains" and project:
        # "meu-projeto – arquivo.rb" / "meu-projeto [~/caminho] – arquivo.rb"
        for w in wins:
            head = w["title"].split(" – ")[0].split(" [")[0].strip().lower()
            if head == project:
                return w["id"]
        for w in wins:
            if project in w["title"].lower():
                return w["id"]

    # terminais: o título da janela é o título da aba ativa, que o Claude
    # preenche com o título da sessão
    for key in (session.get("aiTitle"), session.get("title")):
        k = _norm(key)
        if not k:
            continue
        for w in wins:
            if _norm(w["title"]) == k:
                return w["id"]
        for w in wins:
            t = _norm(w["title"])
            if t and (k.startswith(t) or t.startswith(k[:40])):
                return w["id"]
    return wins[0]["id"]


def focus(session):
    wid = find_window(session)
    if not wid:
        return False
    try:
        subprocess.run(["wmctrl", "-ia", wid], timeout=2)
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def available():
    return shutil.which("wmctrl") is not None and os.environ.get("DISPLAY")
