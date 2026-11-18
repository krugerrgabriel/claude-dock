"""Janela flutuante: uma cápsula colada embaixo do top bar que abre o painel no hover.

A janela é transparente e de tamanho fixo; o que recebe clique é só a região
que o JS informa (cápsula quando fechado, painel quando aberto), via input
shape do X11. O resto deixa o clique passar pra quem estiver embaixo.
"""

import json
import os
import time
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("GdkX11", "3.0")
import threading  # noqa: E402

import cairo  # noqa: E402
from gi.repository import Gdk, GdkX11, Gio, GLib, Gtk, WebKit2  # noqa: E402

from . import launch, library, sessions, updater, usage, windows  # noqa: E402


UI_DIR = Path(__file__).parent / "ui"
CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "claude-dock" / "config.json"

WIDTH, HEIGHT = 880, 720
USAGE_INTERVAL_S = 120     # a extensão de uso já consulta a cada 60 s; não dobrar a pressão
USAGE_STALE_S = 60         # ao abrir o painel, atualiza se o dado for mais velho que isso
USAGE_MAX_BACKOFF_S = 600
UPDATE_FIRST_S = 20           # primeira checagem de versão depois de abrir
UPDATE_INTERVAL_S = 6 * 3600
UPDATE_TIMEOUT_S = 120        # sem reabrir nesse tempo, considera que a atualização falhou
LIVE_INTERVAL_MS = 1500
HISTORY_INTERVAL_S = 8
HISTORY_IDLE_S = 30        # fechado: mantém o histórico morno sem pesar


LANGS = ("en", "pt")


def copy_to_clipboard(text):
    if not text:
        return
    cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    cb.set_text(text, -1)
    cb.store()


def system_language():
    for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        val = os.environ.get(var, "")
        if val and val not in ("C", "POSIX", "C.UTF-8"):
            code = val.split(":")[0].split("_")[0].split(".")[0].lower()
            return code if code in LANGS else "en"
    return "en"


DEFAULT_CONFIG = {
    "terminal": None,
    "language": "auto",           # auto (idioma do sistema), en ou pt
    "islandUsage": True,          # % de uso na ilha minimizada
    "checkUpdates": True,         # avisa quando sai release nova no GitHub
    "usage": {                    # blocos da coluna de uso
        "plan": True,
        "rings": True,
        "session": True,
        "week": True,
        "paceMarker": True,
        "resetTime": True,
        "models": False,          # opcionais: ligam pela engrenagem
        "spent": False,
    },
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        saved = json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError):
        return cfg
    for k, v in saved.items():
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v
    return cfg


def save_config(cfg):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
    tmp.replace(CONFIG_PATH)


class Dock:
    def __init__(self, app):
        self.config = load_config()
        self.expanded = False
        self.live = []
        self.history = []
        self.last_payload = None
        self.history_at = 0
        self.history_busy = False
        self.focus_prev = None
        self.usage = None
        self.usage_loading = False
        self.usage_failures = 0
        self.usage_timer = None
        self.update = None
        self.update_at = 0
        self.update_state = None   # None | "running" | "error"
        self.library = None        # janela "todas as sessões", quando aberta
        self.live_sig = None
        self.store = library.Store(self.config.get("sessionsManagerDir"))

        win = Gtk.ApplicationWindow(application=app, title="Claude Dock")
        win.set_decorated(False)
        win.set_resizable(False)
        win.set_app_paintable(True)
        win.set_type_hint(Gdk.WindowTypeHint.DOCK)
        win.set_keep_above(True)
        win.set_skip_taskbar_hint(True)
        win.set_skip_pager_hint(True)
        win.stick()
        visual = win.get_screen().get_rgba_visual()
        if visual:
            win.set_visual(visual)
        win.set_default_size(WIDTH, HEIGHT)
        win.connect("draw", self._clear)
        win.connect("realize", lambda *_: self._set_shape(0, 0, 1, 1))
        self.win = win

        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler("dock")
        ucm.connect("script-message-received::dock", self._on_message)
        view = WebKit2.WebView.new_with_user_content_manager(ucm)
        view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        view.connect("context-menu", lambda *_: True)
        settings = view.get_settings()
        settings.set_enable_developer_extras(bool(os.environ.get("CLAUDE_DOCK_DEBUG")))
        settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
        view.load_uri((UI_DIR / "index.html").as_uri())
        win.add(view)
        self.view = view

        self._place()
        Gdk.Screen.get_default().connect("monitors-changed", lambda *_: self._place())
        win.show_all()
        threading.Thread(target=self._warm, daemon=True).start()
        GLib.timeout_add(LIVE_INTERVAL_MS, self._tick)
        self.refresh_usage()
        GLib.timeout_add_seconds(UPDATE_FIRST_S, lambda: self.check_update() and False)
        GLib.timeout_add_seconds(UPDATE_INTERVAL_S, self._update_tick)

    def _warm(self):
        # cache do disco + leitura de tudo em segundo plano: quando o painel ou a
        # janela de sessões abrir, os transcripts já estão em memória
        sessions.load_cache()
        GLib.idle_add(lambda: self.push(force_history=True) and False)
        sessions.warm_all()
        sessions.save_cache()

    # ------------------------------------------------------------ janela

    @staticmethod
    def _clear(_w, cr):
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.paint()
        return False

    def _place(self):
        display = Gdk.Display.get_default()
        mon = display.get_primary_monitor() or display.get_monitor(0)
        geo, work = mon.get_geometry(), mon.get_workarea()
        top = work.y if work.y > geo.y else geo.y
        self.win.move(geo.x + (geo.width - WIDTH) // 2, top)

    # ---------------------------------------------------------------- uso

    def refresh_usage(self):
        if self.usage_loading:
            return
        self.usage_loading = True
        self.push()

        def work():
            result = usage.fetch()
            GLib.idle_add(self._usage_done, result)

        threading.Thread(target=work, daemon=True).start()

    def _usage_done(self, result):
        self.usage_loading = False
        if result.get("ok"):
            self.usage_failures = 0
            self.usage = result
        else:
            self.usage_failures += 1
            # mantém o último dado bom e só anexa o erro
            if self.usage and self.usage.get("ok"):
                self.usage = {**self.usage, "error": result["error"], "errorAt": result["fetchedAt"]}
            else:
                self.usage = result
        delay = USAGE_INTERVAL_S if not self.usage_failures else \
            min(USAGE_MAX_BACKOFF_S, USAGE_INTERVAL_S * 2 ** (self.usage_failures - 1))
        if self.usage_timer:
            GLib.source_remove(self.usage_timer)
        self.usage_timer = GLib.timeout_add_seconds(delay, self._usage_tick)
        self.push()
        return False

    def _usage_tick(self):
        self.usage_timer = None
        self.refresh_usage()
        return False

    # ---------------------------------------------------------- atualização

    def _update_tick(self):
        self.check_update()
        return True  # o timer de 6 h continua; o de 20 s é removido abaixo

    def check_update(self):
        if not self.config.get("checkUpdates", True):
            return
        self.update_at = time.time()

        def work():
            result = updater.check()
            GLib.idle_add(self._update_checked, result)

        threading.Thread(target=work, daemon=True).start()

    def _update_checked(self, result):
        if result is not None:  # falha de rede mantém o último resultado
            self.update = result
            self.push()
        return False

    def apply_update(self):
        if self.update_state == "running":
            return
        self.update_state = "running"
        self.push()

        def work():
            ok, must_quit = updater.apply()
            GLib.idle_add(self._update_applied, ok, must_quit)

        threading.Thread(target=work, daemon=True).start()

    def _update_applied(self, ok, must_quit):
        if not ok:
            self.update_state = "error"
            self.push()
        elif must_quit:
            self.win.get_application().quit()
        else:
            # o install.sh fecha este dock e abre o novo; se nada acontecer, avisa
            GLib.timeout_add_seconds(UPDATE_TIMEOUT_S, self._update_timeout)
        return False

    def _update_timeout(self):
        if self.update_state == "running":
            self.update_state = "error"
            self.push()
        return False

    # janela tipo dock não ganha teclado sozinha: pede o foco ao clicar na busca
    # e devolve pra janela anterior quando o painel fecha
    def _grab_focus(self):
        gdkwin = self.win.get_window()
        if not gdkwin or self.focus_prev is not None:
            return
        screen = Gdk.Screen.get_default()
        prev = screen.get_active_window()
        self.focus_prev = prev if prev is not None else False
        gdkwin.focus(GdkX11.x11_get_server_time(gdkwin))

    def _release_focus(self):
        prev, self.focus_prev = self.focus_prev, None
        if prev:
            gdkwin = self.win.get_window()
            prev.focus(GdkX11.x11_get_server_time(gdkwin) if gdkwin else 0)

    def _set_shape(self, x, y, w, h):
        gdkwin = self.win.get_window()
        if not gdkwin:
            return
        region = cairo.Region(cairo.RectangleInt(int(x), int(y), max(1, int(w)), max(1, int(h))))
        gdkwin.input_shape_combine_region(region, 0, 0)

    # ------------------------------------------------------------- dados

    def _tick(self):
        self.push()
        return True

    def push(self, force_history=False):
        self.live = sessions.live_sessions()
        sig = [(s["sessionId"], s["status"]) for s in self.live]
        if self.library and sig != self.live_sig:
            self.library.live_changed()
        self.live_sig = sig
        now = GLib.get_monotonic_time() / 1e6
        every = HISTORY_INTERVAL_S if self.expanded else HISTORY_IDLE_S
        if force_history or now - self.history_at > every:
            self._load_history()
        payload = json.dumps({
            "live": self.live,
            "history": self.history,
            "folders": sessions.recent_folders(self.history, self.live),
            "home": str(Path.home()),
            "usage": self.usage,
            "config": self.config,
            "lang": self.lang(),
            "usageLoading": self.usage_loading,
            "update": self.update if self.config.get("checkUpdates", True) else None,
            "updateState": self.update_state,
            "librarySynced": self.store.shared,
        }, ensure_ascii=False)
        if payload != self.last_payload:
            self.last_payload = payload
            self.view.run_javascript(f"window.dockUpdate && window.dockUpdate({payload})", None, None, None)

    def _load_history(self):
        # lê os transcripts fora da thread da interface: o painel abre na hora com
        # o que já tem e se atualiza quando a leitura termina
        if self.history_busy:
            return
        self.history_busy = True
        self.history_at = GLib.get_monotonic_time() / 1e6
        exclude = [s["sessionId"] for s in self.live]

        def work():
            try:
                hist = self._named(sessions.history(exclude))
                sessions.save_cache()
            except Exception:  # noqa: BLE001 - nunca derrubar o dock por um transcript estranho
                hist = None
            GLib.idle_add(self._history_done, hist)
        threading.Thread(target=work, daemon=True).start()

    def _history_done(self, hist):
        self.history_busy = False
        if hist is not None and hist != self.history:
            self.history = hist
            self.push()
        return False

    def _named(self, hist):
        # nomes dados no gerenciador valem aqui também; o que está na lixeira some
        meta = self.store.names()
        out = []
        for h in hist:
            m = meta.get(h["sessionId"]) or {}
            if m.get("deleted"):
                continue
            if isinstance(m.get("name"), str) and m["name"].strip():
                h = {**h, "title": m["name"].strip()}
            out.append(h)
        return out

    # ------------------------------------------------------- todas as sessões

    def open_library(self):
        if self.library:
            self.library.present()
            return
        from .library_window import LibraryWindow
        self.library = LibraryWindow(self)

    def library_closed(self):
        self.library = None

    def save(self):
        save_config(self.config)

    # ------------------------------------------------------------ bridge

    def _on_message(self, _ucm, result):
        try:
            msg = json.loads(result.get_js_value().to_string())
        except (ValueError, AttributeError):
            return
        kind = msg.get("type")
        if os.environ.get("CLAUDE_DOCK_DEBUG"):
            print("[dock]", msg, flush=True)
        if kind == "ready":
            self.last_payload = None
            self.push(force_history=True)
            peek = os.environ.get("CLAUDE_DOCK_PEEK", "")  # debug: abre sozinho (valor = aba)
            if peek.startswith("library"):
                GLib.idle_add(lambda: self.open_library() and False)
            elif peek:
                GLib.timeout_add(700, lambda: self.view.run_javascript(
                    f"window.dockDebugOpen({json.dumps(peek)})", None, None, None) and False)
        elif kind == "shape":
            self._set_shape(msg["x"], msg["y"], msg["w"], msg["h"])
        elif kind == "expanded":
            self.expanded = bool(msg.get("value"))
            if self.expanded:
                self.push(force_history=True)
                if not self.usage or time.time() - self.usage.get("fetchedAt", 0) > USAGE_STALE_S:
                    self.refresh_usage()
                if time.time() - self.update_at > UPDATE_INTERVAL_S:
                    self.check_update()
        elif kind == "focus":
            s = next((s for s in self.live if s["pid"] == msg.get("pid")), None)
            if s:
                windows.focus(s)
        elif kind == "resume":
            mode = self.click_action()
            if mode == "open" or msg.get("force"):
                launch.resume(msg.get("sessionId"), msg.get("cwd"), self.config.get("terminal"))
            else:
                copy_to_clipboard(launch.resume_text(msg.get("sessionId"), msg.get("cwd"), mode))
        elif kind == "new":
            launch.new_session(msg.get("cwd"), self.config.get("terminal"))
        elif kind == "setConfig":
            self._set_config(msg.get("key", ""), msg.get("value"))
        elif kind == "openLibrary":
            self.open_library()
        elif kind == "applyUpdate":
            self.apply_update()
        elif kind == "openUrl":
            url = msg.get("url") or ""
            if url.startswith("https://github.com/"):
                Gio.AppInfo.launch_default_for_uri(url, None)
        elif kind == "refreshUsage":
            self.refresh_usage()
        elif kind == "grabFocus":
            self._grab_focus()
        elif kind == "releaseFocus":
            self._release_focus()
        elif kind == "pickFolder":
            GLib.idle_add(self._pick_folder)

    def click_action(self):
        mode = self.config.get("clickAction")
        return mode if mode in launch.CLICK_ACTIONS else "open"

    def lang(self):
        choice = self.config.get("language") or "auto"
        return choice if choice in LANGS else system_language()

    def _set_config(self, key, value):
        # chave com ponto = aninhada ("usage.rings"); da UI vêm booleanos e o idioma
        if key == "language":
            if value in ("auto", *LANGS):
                self.config["language"] = value
                save_config(self.config)
                self.push()
            return
        if key == "clickAction":
            if value in launch.CLICK_ACTIONS:
                self.config["clickAction"] = value
                save_config(self.config)
                self.push()
                if self.library:
                    self.library.refresh(reload=False)
            return
        if not isinstance(value, bool) or not key:
            return
        node, *rest = key.split(".")
        if rest:
            sub = self.config.setdefault(node, {})
            if not isinstance(sub, dict):
                return
            sub[rest[0]] = value
        else:
            self.config[node] = value
        save_config(self.config)
        self.push()

    def _pick_folder(self):
        pt = self.lang() == "pt"
        dialog = Gtk.FileChooserNative.new("Pasta da nova sessão" if pt else "Folder for the new session", None,
                                           Gtk.FileChooserAction.SELECT_FOLDER,
                                           "Abrir Claude aqui" if pt else "Open Claude here",
                                           "Cancelar" if pt else "Cancel")
        dialog.set_current_folder(str(Path.home()))
        if dialog.run() == Gtk.ResponseType.ACCEPT:
            launch.new_session(dialog.get_filename(), self.config.get("terminal"))
        dialog.destroy()
        return False


def main():
    app = Gtk.Application(application_id="io.github.claudedock",
                          flags=Gio.ApplicationFlags.FLAGS_NONE)
    state = {}

    def on_activate(a):
        if "dock" not in state:
            state["dock"] = Dock(a)

    app.connect("activate", on_activate)
    return app.run(None)
