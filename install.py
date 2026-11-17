#!/usr/bin/env python3
"""Installs or removes Claude Dock for the current user (no root needed).

  python3 install.py              # command, app menu entry, autostart, then starts the dock
  python3 install.py --uninstall  # removes all of the above (your config is kept)
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path.home()
DATA = Path(os.environ.get("XDG_DATA_HOME") or HOME / ".local" / "share")
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config")

LAUNCHER = HOME / ".local" / "bin" / "claude-dock"
AUTOSTART = CONFIG / "autostart" / "claude-dock.desktop"
MENU_ENTRY = DATA / "applications" / "claude-dock.desktop"
ICON = ROOT / "claude_dock" / "ui" / "icon.svg"

APT_PACKAGES = "python3-gi gir1.2-webkit2-4.1 wmctrl"


def desktop_entry(autostart):
    lines = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Claude Dock",
        "Comment=Your Claude Code sessions and plan usage, one hover away",
        f"Exec={LAUNCHER}",
        f"Icon={ICON}",
        "Terminal=false",
        "Categories=Development;Utility;",
        "StartupNotify=false",
    ]
    if autostart:
        # espera o top bar subir antes de a ilha se posicionar embaixo dele
        lines += ["X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-Delay=4"]
    return "\n".join(lines) + "\n"


def missing_deps():
    problems = []
    probe = (
        "import gi;"
        "gi.require_version('Gtk','3.0');"
        "gi.require_version('WebKit2','4.1');"
        "from gi.repository import Gtk, WebKit2"
    )
    if subprocess.run([sys.executable, "-c", probe], capture_output=True).returncode != 0:
        problems.append("GTK 3 / WebKit2GTK 4.1 for Python")
    if subprocess.run(["sh", "-c", "command -v wmctrl"], capture_output=True).returncode != 0:
        problems.append("wmctrl (used to focus windows)")
    return problems


def install():
    problems = missing_deps()
    if problems:
        print("Missing: " + ", ".join(problems))
        print(f"Install them with:\n\n  sudo apt install {APT_PACKAGES}\n")
        print("Then run this installer again.")
        sys.exit(1)

    if os.environ.get("XDG_SESSION_TYPE") == "wayland":
        print("Heads up: you are on Wayland. Claude Dock needs an X11 session")
        print('("Ubuntu on Xorg" on the login screen) to place itself and focus windows.\n')

    LAUNCHER.parent.mkdir(parents=True, exist_ok=True)
    LAUNCHER.write_text(f'#!/bin/sh\ncd "{ROOT}" && exec python3 -m claude_dock "$@"\n')
    LAUNCHER.chmod(0o755)
    print(f"command:   {LAUNCHER}")

    MENU_ENTRY.parent.mkdir(parents=True, exist_ok=True)
    MENU_ENTRY.write_text(desktop_entry(autostart=False))
    print(f"app menu:  {MENU_ENTRY}")

    AUTOSTART.parent.mkdir(parents=True, exist_ok=True)
    AUTOSTART.write_text(desktop_entry(autostart=True))
    print(f"autostart: {AUTOSTART}")

    if "--no-start" not in sys.argv:
        # se já estiver rodando, a instância nova só sai (o app é de instância única)
        subprocess.Popen([str(LAUNCHER)], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("\nDone. Look right below your top bar, next to the clock. ✳")
    else:
        print("\nDone. Run `claude-dock` to start it.")


def uninstall():
    subprocess.run(["pkill", "-f", "^python3 -m claude_dock"], capture_output=True)
    for p in (AUTOSTART, MENU_ENTRY, LAUNCHER):
        if p.exists():
            p.unlink()
            print(f"removed: {p}")
    print(f"\nYour settings are still in {CONFIG / 'claude-dock'} (delete it if you want).")


if __name__ == "__main__":
    uninstall() if "--uninstall" in sys.argv else install()
