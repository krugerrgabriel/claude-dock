"""Janela de configurações: um lugar só pra tudo que o dock deixa mudar.

Aberta pela engrenagem do painel e pela da janela de sessões. Fechar só esconde;
abrir de novo traz pra frente. Cada mudança é salva na hora (Dock._set_config).
"""

import json
import os
import shutil
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GdkX11, Gio, GLib, Gtk, WebKit2  # noqa: E402

from . import launch, sessions, updater  # noqa: E402

UI_DIR = Path(__file__).parent / "ui"

TERMINAL_LABELS = {
    "ghostty": "Ghostty", "kitty": "kitty", "wezterm": "WezTerm", "alacritty": "Alacritty",
    "ptyxis": "Ptyxis", "gnome-terminal": "GNOME Terminal", "konsole": "Konsole",
}


def _title(lang):
    return "Claude Dock · Configurações" if lang == "pt" else "Claude Dock · Settings"


class SettingsWindow:
    def __init__(self, dock, section=None):
        self.dock = dock
        self.closed = False
        self.last_payload = None
        self.section = section

        settings = Gtk.Settings.get_default()
        if settings:
            settings.set_property("gtk-application-prefer-dark-theme", True)

        win = Gtk.Window(title=_title(dock.lang()))
        win.set_wmclass("claude-dock-settings", "Claude Dock")
        win.set_default_size(880, 640)
        win.set_size_request(420, 420)
        win.set_position(Gtk.WindowPosition.CENTER)
        icon = UI_DIR / "icon.svg"
        if icon.exists():
            try:
                win.set_icon_from_file(str(icon))
            except GLib.Error:
                pass
        win.connect("destroy", self._on_destroy)
        win.connect("delete-event", self._on_close)
        self.win = win

        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler("settings")
        ucm.connect("script-message-received::settings", self._on_message)
        view = WebKit2.WebView.new_with_user_content_manager(ucm)
        view.set_background_color(Gdk.RGBA(0.12, 0.12, 0.14, 1))
        view.connect("context-menu", lambda *_: True)
        ws = view.get_settings()
        ws.set_enable_developer_extras(bool(os.environ.get("CLAUDE_DOCK_DEBUG")))
        ws.set_hardware_acceleration_policy(
            WebKit2.HardwareAccelerationPolicy.NEVER if os.environ.get("CLAUDE_DOCK_NO_GPU")
            else WebKit2.HardwareAccelerationPolicy.ALWAYS)
        view.load_uri((UI_DIR / "settings.html").as_uri())
        win.add(view)
        self.view = view
        win.show_all()

    # -------------------------------------------------------------- janela

    def present(self, section=None):
        if not self.win.get_visible():
            self.win.show()
            self.refresh()
        if section:
            self._js(f"window.setSection && window.setSection({json.dumps(section)})")
        gdkwin = self.win.get_window()
        ts = GdkX11.x11_get_server_time(gdkwin) if gdkwin else Gdk.CURRENT_TIME
        self.win.present_with_time(ts)

    def _on_close(self, *_):
        self.win.hide()
        return True

    def _on_destroy(self, *_):
        self.closed = True
        self.dock.settings_closed()

    def _js(self, code):
        if not self.closed:
            self.view.run_javascript(code, None, None, None)

    # --------------------------------------------------------------- dados

    def refresh(self, lang_changed=False):
        if lang_changed:
            self.win.set_title(_title(self.dock.lang()))
        if not self.win.get_visible():
            return
        d = self.dock
        store = d.store
        terminals = [{"id": t, "label": TERMINAL_LABELS.get(t, t)} for t in launch.TERMINALS if shutil.which(t)]
        payload = json.dumps({
            "config": d.config,
            "lang": d.lang(),
            "home": str(Path.home()),
            "terminals": terminals,
            "autoTerminal": launch.pick_terminal(None),
            "folders": sessions.recent_folders(d.history, d.live),
            "autoTrashDays": store.load_settings()["auto_trash_days"],
            "shared": store.shared,
            "managerUrl": (store.manager or {}).get("url"),
            "usage": d.usage,
            "version": updater.current_version(),
            "notifyOk": d.notifier.ok,
        }, ensure_ascii=False)
        if payload != self.last_payload:
            self.last_payload = payload
            self._js(f"window.settingsUpdate && window.settingsUpdate({payload})")

    # ---------------------------------------------------------------- ações

    def _pick_folder(self):
        pt = self.dock.lang() == "pt"
        dialog = Gtk.FileChooserNative.new("Pasta do comando rápido" if pt else "Folder for quick commands",
                                           self.win, Gtk.FileChooserAction.SELECT_FOLDER,
                                           "Usar esta pasta" if pt else "Use this folder",
                                           "Cancelar" if pt else "Cancel")
        cur = (self.dock.config.get("ask") or {}).get("cwd")
        dialog.set_current_folder(cur if cur and cur != "auto" and os.path.isdir(cur) else str(Path.home()))
        if dialog.run() == Gtk.ResponseType.ACCEPT:
            self.dock._set_config("ask.cwd", dialog.get_filename())
        dialog.destroy()
        # cancelar também precisa redesenhar (o seletor voltou pro valor antigo)
        self.last_payload = None
        self.refresh()
        return False

    def _on_message(self, _ucm, result):
        try:
            msg = json.loads(result.get_js_value().to_string())
        except (ValueError, AttributeError):
            return
        kind = msg.get("type")
        if os.environ.get("CLAUDE_DOCK_DEBUG"):
            print("[settings]", msg, flush=True)
        if kind == "ready":
            self.last_payload = None
            self.refresh()
            if self.section:
                self._js(f"window.setSection && window.setSection({json.dumps(self.section)})")
        elif kind == "setConfig":
            if not self.dock._set_config(msg.get("key", ""), msg.get("value")):
                self.last_payload = None  # recusado: a UI volta pro valor salvo
                self.refresh()
        elif kind == "autoTrash":
            try:
                self.dock.store.save_settings(int(msg.get("days") or 0))
            except (OSError, ValueError, TypeError):
                pass
            if self.dock.library:
                self.dock.library.refresh()
            self.refresh()
        elif kind == "pickFolder":
            GLib.idle_add(self._pick_folder)
        elif kind == "testAlert":
            self.dock.test_alert()
        elif kind == "openManager":
            url = (self.dock.store.manager or {}).get("url")
            if url:
                Gio.AppInfo.launch_default_for_uri(url, None)
