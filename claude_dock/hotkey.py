"""Atalho global do comando rápido: um custom keybinding do GNOME só nosso.

Mexe só na entrada .../custom-keybindings/claude-dock/ e na presença dela na lista
custom-keybindings; as entradas dos outros ficam como estão.
"""

import shlex
from pathlib import Path

from gi.repository import Gio

MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys"
CUSTOM = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/claude-dock/"
NAME = "Claude Dock: comando rápido"
LAUNCHER = Path(__file__).resolve().parent.parent / "claude-dock"


def command():
    return f"{shlex.quote(str(LAUNCHER))} --ask"


def _schemas_ok():
    src = Gio.SettingsSchemaSource.get_default()
    return bool(src and src.lookup(MEDIA_KEYS, True) and src.lookup(CUSTOM, True))


def apply(shortcut):
    """Deixa o GNOME igual à configuração ("off" remove). Só grava o que mudou.
    Devolve False quando não é GNOME (schemas ausentes)."""
    if not _schemas_ok():
        return False
    keys = Gio.Settings.new(MEDIA_KEYS)
    paths = list(keys.get_strv("custom-keybindings"))
    entry = Gio.Settings.new_with_path(CUSTOM, PATH)
    if not shortcut or shortcut == "off":
        if PATH in paths:
            keys.set_strv("custom-keybindings", [p for p in paths if p != PATH])
        for k in ("name", "command", "binding"):
            entry.reset(k)
    else:
        for k, v in (("name", NAME), ("command", command()), ("binding", shortcut)):
            if entry.get_string(k) != v:
                entry.set_string(k, v)
        if PATH not in paths:
            keys.set_strv("custom-keybindings", paths + [PATH])
    Gio.Settings.sync()
    return True
