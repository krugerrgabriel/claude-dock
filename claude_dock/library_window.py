"""Janela "Todas as sessões": o gerenciador completo, aberto pelo painel.

É uma janela normal (aparece no Alt+Tab). Abrir de novo só traz ela pra frente.
"""

import json
import os
import threading
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GdkX11, GLib, Gtk, WebKit2  # noqa: E402

from . import launch, library, sessions, windows  # noqa: E402

UI_DIR = Path(__file__).parent / "ui"
REFRESH_S = 10


class LibraryWindow:
    def __init__(self, dock):
        self.dock = dock
        self.store = library.Store(dock.config.get("sessionsManagerDir"))
        self.items = []
        self.meta_error = None
        self.search_gen = 0
        self.last_payload = None
        self.undo = None
        self.closed = False
        self.loading = False
        self.reload_again = False

        settings = Gtk.Settings.get_default()
        if settings:
            settings.set_property("gtk-application-prefer-dark-theme", True)

        pt = dock.lang() == "pt"
        win = Gtk.Window(title="Claude · Sessões" if pt else "Claude · Sessions")
        win.set_wmclass("claude-dock-sessions", "Claude Dock")
        win.set_default_size(1180, 780)
        win.set_position(Gtk.WindowPosition.CENTER)
        icon = UI_DIR / "icon.svg"
        if icon.exists():
            try:
                win.set_icon_from_file(str(icon))
            except GLib.Error:
                pass
        win.connect("destroy", self._on_destroy)
        # fechar só esconde: reabrir fica instantâneo (o WebKit já está de pé)
        win.connect("delete-event", self._on_close)
        self.win = win

        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler("lib")
        ucm.connect("script-message-received::lib", self._on_message)
        view = WebKit2.WebView.new_with_user_content_manager(ucm)
        view.set_background_color(Gdk.RGBA(0.12, 0.12, 0.14, 1))
        view.connect("context-menu", lambda *_: True)
        ws = view.get_settings()
        ws.set_enable_developer_extras(bool(os.environ.get("CLAUDE_DOCK_DEBUG")))
        # janela opaca normal: com GPU a rolagem da grade fica em ~60 fps (sem ela,
        # ~40). O dock continua sem GPU por causa da transparência.
        # CLAUDE_DOCK_NO_GPU=1 desliga se algum driver der problema.
        ws.set_hardware_acceleration_policy(
            WebKit2.HardwareAccelerationPolicy.NEVER if os.environ.get("CLAUDE_DOCK_NO_GPU")
            else WebKit2.HardwareAccelerationPolicy.ALWAYS)
        view.load_uri((UI_DIR / "library.html").as_uri())
        win.add(view)
        self.view = view
        win.show_all()
        self.timer = GLib.timeout_add_seconds(REFRESH_S, self._tick)

    # -------------------------------------------------------------- janela

    def present(self):
        if not self.win.get_visible():
            self.win.show()
            self.refresh()
            self._js("window.libShown && window.libShown()")
        if not self.timer:
            self.timer = GLib.timeout_add_seconds(REFRESH_S, self._tick)
        gdkwin = self.win.get_window()
        ts = GdkX11.x11_get_server_time(gdkwin) if gdkwin else Gdk.CURRENT_TIME
        self.win.present_with_time(ts)

    def _on_close(self, *_):
        self.win.hide()
        if self.timer:
            GLib.source_remove(self.timer)
            self.timer = None
        return True

    def _on_destroy(self, *_):
        self.closed = True
        if self.timer:
            GLib.source_remove(self.timer)
            self.timer = None
        self.dock.library_closed()

    def _tick(self):
        self.refresh()
        return True

    # --------------------------------------------------------------- dados

    def refresh(self, reload=True):
        if not reload:
            self._send()
            return
        # leitura dos transcripts numa thread; a janela nunca trava esperando disco
        if self.loading:
            self.reload_again = True
            return
        self.loading = True

        def work():
            try:
                result = self.store.list_all()
                sessions.save_cache()
            except Exception as e:  # noqa: BLE001
                result = (self.items, str(e))
            GLib.idle_add(self._loaded, result)
        threading.Thread(target=work, daemon=True).start()

    def _loaded(self, result):
        self.loading = False
        self.items, self.meta_error = result
        self._send()
        if self.reload_again:
            self.reload_again = False
            self.refresh()
        return False

    def _send(self):
        live = {s["sessionId"]: s for s in self.dock.live}
        payload = json.dumps({
            "items": self.items,
            "live": {sid: {"pid": s["pid"], "status": s["status"], "host": s["host"]} for sid, s in live.items()},
            "metaError": self.meta_error,
            "shared": self.store.shared,
            "managerUrl": (self.store.manager or {}).get("url"),
            "lang": self.dock.lang(),
            "home": str(Path.home()),
            "undo": bool(self.undo),
            "prefs": self.dock.config.get("library") or {},
            "clickAction": self.dock.click_action(),
            "recapMode": self.dock.recap_mode(),
            "recaps": self._recaps(),
        }, ensure_ascii=False)
        if payload != self.last_payload:
            self.last_payload = payload
            self._js(f"window.libUpdate && window.libUpdate({payload})")

    def _recaps(self):
        """Modo IA: id -> resumo, só dos que valem pra versão atual da conversa."""
        if self.dock.recap_mode() != "ai":
            return {}
        lang = self.dock.lang()
        out = {}
        for s in self.items:
            text = self.dock.recapper.text(s["id"], s.get("lastId"), lang)
            if text:
                out[s["id"]] = text
        return out

    def _js(self, code):
        if not self.closed:
            self.view.run_javascript(code, None, None, None)

    def live_changed(self):
        if not self.closed:
            self.refresh(reload=False)

    # ---------------------------------------------------------------- ações

    def _patch(self, ids, fields, undoable=True):
        try:
            if undoable:
                before = self.store.load_metadata()
                self.undo = {sid: before.get(sid) for sid in ids}
            self.store.patch(ids, fields)
        except library.MetadataUnreadable as e:
            self._js(f"window.libToast && window.libToast({json.dumps({'error': 'metaUnreadable', 'detail': str(e)})})")
            return
        except OSError as e:
            self._js(f"window.libToast && window.libToast({json.dumps({'error': 'writeFailed', 'detail': str(e)})})")
            return
        self.refresh()

    def _search(self, q, gen):
        def work():
            hits = library.search_content(q)
            GLib.idle_add(self._search_done, q, gen, hits)
        threading.Thread(target=work, daemon=True).start()

    def _search_done(self, q, gen, hits):
        if gen == self.search_gen:
            self._js(f"window.libSearchResult && window.libSearchResult({json.dumps({'q': q, 'gen': gen, 'hits': hits}, ensure_ascii=False)})")
        return False

    def _on_message(self, _ucm, result):
        try:
            msg = json.loads(result.get_js_value().to_string())
        except (ValueError, AttributeError):
            return
        kind = msg.get("type")
        if os.environ.get("CLAUDE_DOCK_DEBUG"):
            print("[lib]", msg, flush=True)
        if kind == "ready":
            self.last_payload = None
            self.refresh()
            peek = os.environ.get("CLAUDE_DOCK_PEEK", "")  # debug: library:q:termo
            if peek.startswith("library:"):
                GLib.timeout_add(600, lambda: self._js(f"window.libDebug && window.libDebug({json.dumps(peek[8:])})") and False)
        elif kind == "refresh":
            self.refresh()
        elif kind == "patch":
            ids = msg.get("ids") or []
            fields = {k: v for k, v in (msg.get("fields") or {}).items()
                      if k in ("name", "description", "favorite", "deleted")}
            if fields:
                self._patch(ids, fields, undoable=bool(msg.get("undoable", True)))
        elif kind == "undo":
            if self.undo:
                try:
                    self.store.restore_snapshot(self.undo)
                except (library.MetadataUnreadable, OSError):
                    pass
                self.undo = None
                self.refresh()
        elif kind == "open":
            sid = msg.get("id")
            live = next((s for s in self.dock.live if s["sessionId"] == sid), None)
            if live:
                windows.focus(live)
            else:
                item = next((s for s in self.items if s["id"] == sid), None)
                if item:
                    launch.resume(sid, item["cwd"], self.dock.config.get("terminal"))
        elif kind == "search":
            self.search_gen = int(msg.get("gen") or 0)
            self._search(msg.get("q") or "", self.search_gen)
        elif kind == "pref":
            key, value = msg.get("key"), msg.get("value")
            if key in ("sort", "collapsed", "groupBy") and isinstance(value, (str, list)):
                lib = self.dock.config.setdefault("library", {})
                lib[key] = value
                self.dock.save()
        elif kind == "copy":
            item = next((s for s in self.items if s["id"] == msg.get("id")), None)
            mode = msg.get("mode")
            if item:
                from .app import copy_to_clipboard
                text = item["id"] if mode == "id" else launch.resume_text(
                    item["id"], item["cwd"], "copySlash" if mode == "copySlash" else "copyCli")
                copy_to_clipboard(text)
        elif kind == "openSettings":
            self.dock.open_settings(msg.get("section"))

