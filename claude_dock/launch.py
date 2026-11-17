"""Abrir um terminal com o Claude (sessão nova ou --resume)."""

import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# ordem de preferência quando o config não define "terminal"
TERMINALS = {
    "ghostty":        lambda cwd, cmd: ["ghostty", f"--working-directory={cwd}", "-e", *cmd],
    "kitty":          lambda cwd, cmd: ["kitty", "--directory", cwd, *cmd],
    "wezterm":        lambda cwd, cmd: ["wezterm", "start", "--cwd", cwd, "--", *cmd],
    "alacritty":      lambda cwd, cmd: ["alacritty", "--working-directory", cwd, "-e", *cmd],
    "ptyxis":         lambda cwd, cmd: ["ptyxis", "--new-window", "-d", cwd, "--", *cmd],
    "gnome-terminal": lambda cwd, cmd: ["gnome-terminal", f"--working-directory={cwd}", "--", *cmd],
    "konsole":        lambda cwd, cmd: ["konsole", "--workdir", cwd, "-e", *cmd],
}


def pick_terminal(preferred=None):
    if preferred and preferred in TERMINALS and shutil.which(preferred):
        return preferred
    for name in TERMINALS:
        if shutil.which(name):
            return name
    return None


def _claude_cmd(extra):
    # shell interativo pra carregar o PATH do usuário (~/.local/bin etc.);
    # ao sair do Claude o terminal continua aberto no shell
    shell = os.environ.get("SHELL") or "/bin/bash"
    line = " ".join(["claude", *map(shlex.quote, extra)])
    return [shell, "-ic", f'{line}; exec "{shell}"']


def _spawn(cwd, extra, terminal=None):
    cwd = cwd if cwd and os.path.isdir(cwd) else str(Path.home())
    term = pick_terminal(terminal)
    if not term:
        return False
    argv = TERMINALS[term](cwd, _claude_cmd(extra))
    subprocess.Popen(argv, cwd=cwd, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def new_session(cwd, terminal=None):
    return _spawn(cwd, [], terminal)


def resume(session_id, cwd, terminal=None):
    if not _UUID.match(session_id or ""):
        return False
    return _spawn(cwd, ["--resume", session_id], terminal)
