"""Janela flutuante: uma cápsula colada embaixo do top bar que abre o painel no hover.

A janela é transparente e de tamanho fixo; o que recebe clique é só a região
que o JS informa (cápsula quando fechado, painel quando aberto), via input
shape do X11. O resto deixa o clique passar pra quem estiver embaixo.
"""

import json
import os
import sys
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

from . import alerts, ask, cli, hotkey, insights, launch, library, sessions, updater, usage, windows  # noqa: E402


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
PLACE_CHECK_S = 3
ASK_TURNS_MAX = 20          # pedidos anteriores que ficam na tela da conversa
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
    "terminal": None,             # None = o primeiro de launch.TERMINALS instalado
    "language": "auto",           # auto (idioma do sistema), en ou pt
    "clickAction": "open",        # ao clicar numa sessão recente: open, copyCli, copySlash
    "islandUsage": True,          # % de uso na ilha minimizada
    "checkUpdates": True,         # avisa quando sai release nova no GitHub
    "notify": {                   # notificações do sistema
        "waiting": True,          # sessão parou pedindo algo
        "done": True,             # sessão terminou (se você não está olhando pra ela)
        "forgotten": True,        # parada há horas com alterações sem commit
        "forgottenHours": 2,
        "limit": True,            # ritmo indica que o limite acaba antes de reiniciar
        "sound": False,
    },
    "ask": {                      # comando rápido
        "shortcut": "<Control><Alt>space",   # formato do GNOME; "off" desativa
        "mode": "read",           # read (só ler), edit (editar arquivos), full (tudo sem perguntar)
        "cwd": "auto",            # auto = projeto da sessão aberta mais recente, ou um caminho
        "model": "auto",          # auto = haiku no modo read; haiku, sonnet, opus
    },
    "recap": {"mode": "simple"},  # "onde parei": simple, ai ou off
    "summary": {"enabled": True}, # botão "Resumo de hoje"
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


def _choice(*opts):
    return lambda v: any(v == o and type(v) is type(o) for o in opts)


def _is_bool(v):
    return isinstance(v, bool)


def _valid_accel(v):
    if not isinstance(v, str) or len(v) > 64:
        return False
    key, mods = Gtk.accelerator_parse(v)
    need = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.MOD1_MASK | Gdk.ModifierType.SUPER_MASK
    return bool(key) and bool(mods & need)


# o que a UI pode gravar: chave -> validador (o resto é ignorado)
CONFIG_SCHEMA = {
    "language": _choice("auto", *LANGS),
    "clickAction": _choice(*launch.CLICK_ACTIONS),
    "terminal": lambda v: v is None or (isinstance(v, str) and v in launch.TERMINALS),
    "islandUsage": _is_bool,
    "checkUpdates": _is_bool,
    **{f"usage.{k}": _is_bool for k in DEFAULT_CONFIG["usage"]},
    "notify.waiting": _is_bool,
    "notify.done": _is_bool,
    "notify.forgotten": _is_bool,
    "notify.forgottenHours": _choice(1, 2, 4),
    "notify.limit": _is_bool,
    "notify.sound": _is_bool,
    "ask.shortcut": lambda v: v == "off" or _valid_accel(v),
    "ask.mode": _choice("read", "edit", "full"),
    "ask.cwd": lambda v: v == "auto" or (isinstance(v, str) and os.path.isabs(v) and os.path.isdir(v)),
    "ask.model": _choice("auto", "haiku", "sonnet", "opus"),
    "recap.mode": _choice("simple", "ai", "off"),
    "summary.enabled": _is_bool,
}


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
        self.settings = None       # janela de configurações, quando aberta
        self.tracker = alerts.Tracker()
        self.notifier = alerts.Notifier()
        self.unseen = {}           # sessionId -> {"at", "wid"}: terminou e você ainda não viu
        self.live_sig = None
        self.store = library.Store(self.config.get("sessionsManagerDir"))
        self.ready = False         # a página já respondeu "ready"
        self.ask = None            # ask.Run do comando rápido (um por vez)
        self.ask_unseen = False    # terminou com o painel fechado e você ainda não viu
        self.ask_open_pending = False
        self.ask_flush = None
        self.ask_history = ask.load_history()
        # ajudas do dia a dia
        self.recapper = insights.Recapper(on_done=lambda: GLib.idle_add(self._recap_done))
        self.git = insights.GitDirty(on_change=lambda: GLib.idle_add(lambda: self.push() and False))
        self.limit = insights.LimitWatch()
        self.forecast_at = None    # horário previsto pra acabar a janela de 5h (ou None)
        self.forgot_notified = self._load_forgot()
        self.summary = None        # resumo do dia: {"status", "text", "error", "at", "lang"}

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
        # No login o dock pode subir antes do GNOME reservar a faixa da barra de cima
        # (área de trabalho ainda começa em y=0); reconfere a posição de tempos em tempos.
        GLib.timeout_add_seconds(PLACE_CHECK_S, lambda: self._place() or True)
        win.show_all()
        threading.Thread(target=self._warm, daemon=True).start()
        GLib.timeout_add(LIVE_INTERVAL_MS, self._tick)
        self.refresh_usage()
        GLib.timeout_add_seconds(UPDATE_FIRST_S, lambda: self.check_update() and False)
        GLib.timeout_add_seconds(UPDATE_INTERVAL_S, self._update_tick)
        GLib.idle_add(lambda: self._apply_hotkey() and False)

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
        pos = (geo.x + (geo.width - WIDTH) // 2, top)
        if pos != getattr(self, "_placed", None):
            self._placed = pos
            self.win.move(*pos)

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
            self._check_limit(result.get("session"))
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
        if self.settings:
            self.settings.refresh()  # prévia ao vivo do painel de uso
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
        # os `claude -p` do próprio dock (comando rápido, recap, resumo) também
        # aparecem como sessões abertas: ficam de fora
        mine = cli.children()
        self.live = [s for s in sessions.live_sessions() if s["pid"] not in mine]
        self._check_alerts()
        sig = [(s["sessionId"], s["status"]) for s in self.live]
        if self.library and sig != self.live_sig:
            self.library.live_changed()
        self.live_sig = sig
        now = GLib.get_monotonic_time() / 1e6
        every = HISTORY_INTERVAL_S if self.expanded else HISTORY_IDLE_S
        if force_history or now - self.history_at > every:
            self._load_history()
        live = self._decorate(self.live)
        payload = json.dumps({
            "live": live,
            "history": self.history,
            "folders": sessions.recent_folders(self.history, self.live),
            "home": str(Path.home()),
            "usage": {**self.usage, "forecastAt": self.forecast_at} if self.usage else None,
            "config": self.config,
            "lang": self.lang(),
            "usageLoading": self.usage_loading,
            "update": self.update if self.config.get("checkUpdates", True) else None,
            "updateState": self.update_state,
            "librarySynced": self.store.shared,
            "summary": self.summary,
            "ask": {
                "history": self.ask_history,
                "default": self._ask_default(),
                "shortcut": (self.config.get("ask") or {}).get("shortcut"),
                "unseen": self.ask_unseen,
            },
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

    # ---------------------------------------------------------------- avisos

    def _check_alerts(self):
        events = self.tracker.step(self.live)
        if self.unseen:
            # "pronta, não vista" acaba quando ela volta a trabalhar, fecha ou você olha pra janela dela
            by_id = {s["sessionId"]: s for s in self.live}
            active = self._active_xid()
            for sid, u in list(self.unseen.items()):
                s = by_id.get(sid)
                if not s or s["status"] != "idle" or (u["wid"] and u["wid"] == active):
                    del self.unseen[sid]
        if events:
            # achar a janela usa wmctrl: fora da thread da interface
            def work():
                found = []
                for kind, s in events:
                    try:
                        wid = windows.find_window(s)
                    except Exception:  # noqa: BLE001
                        wid = None
                    found.append((kind, s, int(wid, 16) if wid else None))
                GLib.idle_add(self._deliver_alerts, found)
            threading.Thread(target=work, daemon=True).start()

    @staticmethod
    def _active_xid():
        try:
            win = Gdk.Screen.get_default().get_active_window()
            return win.get_xid() if win is not None else None
        except Exception:  # noqa: BLE001
            return None

    def _deliver_alerts(self, found):
        cfg = self.config.get("notify") or {}
        active = self._active_xid()
        out = []
        for kind, s, wid in found:
            looking = wid is not None and wid == active
            if looking:
                continue  # você já está vendo: nada de aviso nem marca
            if kind == "done":
                self.unseen[s["sessionId"]] = {"at": time.time(), "wid": wid}
            if cfg.get(kind, True):
                out.append((kind, s))
        if out:
            self.notifier.show(out, self.lang(), self._go_to, sound=bool(cfg.get("sound")),
                               icon=str(UI_DIR / "icon.svg"))
        self.push()
        return False

    def _go_to(self, session):
        live = next((s for s in self.live if s["sessionId"] == session.get("sessionId")), session)
        self.unseen.pop(live.get("sessionId"), None)
        windows.focus(live)
        self.push()

    def test_alert(self):
        cfg = self.config.get("notify") or {}
        self.notifier.test(self.lang(), sound=bool(cfg.get("sound")), icon=str(UI_DIR / "icon.svg"))

    # ------------------------------------------------------ ajudas do dia a dia

    def recap_mode(self):
        mode = (self.config.get("recap") or {}).get("mode")
        return mode if mode in ("simple", "ai", "off") else "simple"

    def recap_for(self, sid, last_id, last):
        """Texto do "onde parei": o da IA se já existe pra essa versão da conversa, senão o simples."""
        mode = self.recap_mode()
        if mode == "off":
            return None
        if mode == "ai":
            return self.recapper.text(sid, last_id, self.lang()) or last
        return last

    def _decorate(self, live):
        """Acrescenta o que a UI mostra na linha de baixo: pronta não vista, onde parei, esquecida."""
        now = time.time()
        mode = self.recap_mode()
        out = []
        for s in live:
            sid = s["sessionId"]
            extra = {}
            if sid in self.unseen:
                extra["unseenAt"] = self.unseen[sid]["at"]
            recap = self.recap_for(sid, s.get("lastId"), s.get("last"))
            if recap:
                extra["recap"] = recap
            if mode == "ai" and s["status"] == "idle" and now - (s.get("statusSince") or now) >= insights.RECAP_IDLE_S:
                self.recapper.want(sid, s.get("lastId"), self.lang())
            forgot = self._forgotten(s, now)
            if forgot:
                extra["forgotten"] = forgot
            out.append({**s, **extra} if extra else s)
        return out

    def _recap_done(self):
        self.push()
        if self.library:
            self.library.refresh(reload=False)
        return False

    def _forgotten(self, s, now):
        """Parada há horas com alterações sem commit: {"since", "files"} ou None."""
        cfg = self.config.get("notify") or {}
        if not cfg.get("forgotten", True) or s["status"] != "idle" or not s.get("cwd"):
            return None
        hours = cfg.get("forgottenHours") or 2
        since = s.get("statusSince") or now
        if now - since < hours * 3600:
            return None
        files = self.git.count(s["cwd"])
        if not files:
            return None
        sid = s["sessionId"]
        today = time.strftime("%Y-%m-%d")
        if self.forgot_notified.get(sid) != today:
            # no máximo um aviso por sessão por dia
            self.forgot_notified = {k: v for k, v in self.forgot_notified.items() if v == today}
            self.forgot_notified[sid] = today
            self._save_forgot()
            self.notifier.forgotten(s, now - since, files, self.lang(), self._go_to,
                                    sound=bool(cfg.get("sound")), icon=str(UI_DIR / "icon.svg"))
        return {"since": since, "files": files}

    @staticmethod
    def _load_forgot():
        try:
            data = json.loads((cli.CACHE_DIR / "forgotten.json").read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_forgot(self):
        try:
            cli.CACHE_DIR.mkdir(parents=True, exist_ok=True)
            (cli.CACHE_DIR / "forgotten.json").write_text(json.dumps(self.forgot_notified))
        except OSError:
            pass

    def _check_limit(self, session):
        eta, warn = self.limit.feed(session)
        self.forecast_at = eta
        cfg = self.config.get("notify") or {}
        if warn and cfg.get("limit", True):
            self.notifier.limit(eta, self.lang(), sound=bool(cfg.get("sound")), icon=str(UI_DIR / "icon.svg"))

    def summary_run(self):
        """Resumo do dia: só roda quando você pede (botão "Resumo de hoje")."""
        if self.summary and self.summary.get("status") == "running":
            return
        lang = self.lang()
        self.summary = {"status": "running", "at": time.time(), "lang": lang, "text": None, "error": None}
        self.push()
        ai = self.recap_mode() == "ai"

        def recap_text(sid, info):
            return self.recapper.text(sid, info.get("lastId"), lang) if ai else None

        def work():
            try:
                text, err = insights.run_summary(lang, recap_text)
            except Exception as e:  # noqa: BLE001 - nunca derrubar o dock
                text, err = None, str(e)
            GLib.idle_add(self._summary_done, text, err)
        threading.Thread(target=work, daemon=True).start()

    def _summary_done(self, text, err):
        self.summary = {**(self.summary or {}), "status": "error" if err else "done",
                        "text": text, "error": err, "at": time.time()}
        self.push()
        cfg = self.config.get("notify") or {}
        if not self.expanded and err != "empty" and cfg.get("done", True):
            # você fechou o painel enquanto escrevia: avisa que ficou pronto
            body = text or err or ""
            body = " ".join(body.replace("*", "").split())
            body = body if len(body) <= 140 else body[:139] + "…"
            self.notifier.summary_done(not err, body, self.lang(), self._summary_view,
                                       sound=bool(cfg.get("sound")), icon=str(UI_DIR / "icon.svg"))
        return False

    def _summary_view(self):
        self._grab_focus()
        self.view.run_javascript("window.dockSumOpen && window.dockSumOpen()", None, None, None)

    # ---------------------------------------------------------- comando rápido

    def _apply_hotkey(self):
        try:
            hotkey.apply((self.config.get("ask") or {}).get("shortcut"))
        except Exception as e:  # noqa: BLE001 - sem GNOME/dconf: o campo no painel continua valendo
            print("[dock] atalho:", e, file=sys.stderr, flush=True)

    def _ask_default(self):
        """Pasta do comando rápido: a fixada nas configurações ou o projeto da sessão aberta mais recente."""
        cfg = (self.config.get("ask") or {}).get("cwd") or "auto"
        cwd = cfg if cfg != "auto" and os.path.isdir(cfg) else None
        if not cwd:
            for s in sorted(self.live, key=lambda s: s.get("startedAt") or 0, reverse=True):
                if s.get("cwd") and os.path.isdir(s["cwd"]):
                    cwd = s["cwd"]
                    break
        if not cwd:
            cwd = next((h["cwd"] for h in self.history if h.get("cwd") and os.path.isdir(h["cwd"])), None)
        cwd = cwd or str(Path.home())
        return {"cwd": cwd, "project": os.path.basename(cwd.rstrip("/")) or "~",
                "short": cwd.replace(str(Path.home()), "~", 1)}

    def open_ask(self):
        """Atalho global / `claude-dock --ask`: abre o painel com o cursor no campo."""
        if not self.ready:
            self.ask_open_pending = True
            return
        self._grab_focus()
        self.view.run_javascript("window.dockAskOpen && window.dockAskOpen()", None, None, None)

    def ask_send(self, prompt, cwd):
        prompt = (prompt or "").strip()
        if not prompt or (self.ask and self.ask.status == "running"):
            return
        if not (isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isdir(cwd)):
            cwd = self._ask_default()["cwd"]
        cfg = self.config.get("ask") or {}
        self.ask_history = ask.add_history(self.ask_history, prompt)
        self.ask_unseen = False
        # com uma conversa na tela (mesma pasta), o pedido novo continua nela
        prev = self.ask
        resume, turns = None, None
        if prev and prev.status != "running" and prev.cwd == cwd and prev.stream.session_id:
            resume, turns = prev.stream.session_id, prev.thread()[-ASK_TURNS_MAX:]
        run = ask.Run(prompt, cwd, cfg.get("mode") or "read", cfg.get("model") or "auto",
                      on_change=lambda: GLib.idle_add(self._ask_changed, run),
                      on_end=lambda: GLib.idle_add(self._ask_ended, run), resume=resume, turns=turns)
        self.ask = run
        run.start()
        self._ask_push()
        self.push()

    def _ask_changed(self, run):
        # pedaços chegam rápido: junta numa atualização a cada ~60 ms
        if run is self.ask and not self.ask_flush:
            self.ask_flush = GLib.timeout_add(60, self._ask_flush_now)
        return False

    def _ask_flush_now(self):
        self.ask_flush = None
        self._ask_push()
        return False

    def _ask_push(self):
        snap = self.ask.snapshot() if self.ask else None
        self.view.run_javascript(f"window.dockAsk && window.dockAsk({json.dumps(snap, ensure_ascii=False)})",
                                 None, None, None)

    def _ask_ended(self, run):
        if run is not self.ask:
            return False
        if self.ask_flush:
            GLib.source_remove(self.ask_flush)
            self.ask_flush = None
        self._ask_push()
        if not self.expanded and run.status in ("done", "error"):
            # você fechou o painel enquanto rodava: a ilha marca e a notificação chama
            self.ask_unseen = True
            cfg = self.config.get("notify") or {}
            if cfg.get("done", True):
                text = run.text() if run.status == "done" else (run.error or "")
                body = " ".join(text.split())
                body = body if len(body) <= 140 else body[:139] + "…"
                self.notifier.ask_done(run.status == "done", body, self.lang(), self._ask_view,
                                       sound=bool(cfg.get("sound")), icon=str(UI_DIR / "icon.svg"))
        self.push()
        return False

    def _ask_view(self):
        self.ask_unseen = False
        self.open_ask()
        self.push()

    def ask_stop(self):
        if self.ask:
            self.ask.stop()

    def ask_clear(self):
        if self.ask and self.ask.status == "running":
            return
        self.ask = None
        self.ask_unseen = False
        self._ask_push()
        self.push()

    def _ask_pick_folder(self):
        pt = self.lang() == "pt"
        dialog = Gtk.FileChooserNative.new("Pasta do pedido" if pt else "Folder for this request", None,
                                           Gtk.FileChooserAction.SELECT_FOLDER,
                                           "Usar esta pasta" if pt else "Use this folder",
                                           "Cancelar" if pt else "Cancel")
        dialog.set_current_folder(self._ask_default()["cwd"])
        if dialog.run() == Gtk.ResponseType.ACCEPT:
            cwd = dialog.get_filename()
            folder = {"cwd": cwd, "project": os.path.basename(cwd.rstrip("/")) or "~",
                      "short": cwd.replace(str(Path.home()), "~", 1)}
            self.open_ask()
            self.view.run_javascript(f"window.dockAskFolder && window.dockAskFolder({json.dumps(folder)})",
                                     None, None, None)
        dialog.destroy()
        return False

    # ---------------------------------------------------------- configurações

    def open_settings(self, section=None):
        if self.settings:
            self.settings.present(section)
            return
        from .settings_window import SettingsWindow
        self.settings = SettingsWindow(self, section)

    def settings_closed(self):
        self.settings = None

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
            self.ready = True
            self.last_payload = None
            self.push(force_history=True)
            if self.ask:
                self._ask_push()
            if self.ask_open_pending:
                self.ask_open_pending = False
                GLib.timeout_add(200, lambda: self.open_ask() and False)
            peek = os.environ.get("CLAUDE_DOCK_PEEK", "")  # debug: abre sozinho (valor = aba)
            if peek.startswith("library"):
                GLib.idle_add(lambda: self.open_library() and False)
            elif peek.startswith("settings"):  # settings ou settings:<seção>
                GLib.idle_add(lambda: self.open_settings(peek[9:] or None) and False)
            elif peek:
                GLib.timeout_add(700, lambda: self.view.run_javascript(
                    f"window.dockDebugOpen({json.dumps(peek)})", None, None, None) and False)
        elif kind == "shape":
            self._set_shape(msg["x"], msg["y"], msg["w"], msg["h"])
        elif kind == "expanded":
            self.expanded = bool(msg.get("value"))
            if self.expanded:
                self.ask_unseen = False
                self.push(force_history=True)
                if not self.usage or time.time() - self.usage.get("fetchedAt", 0) > USAGE_STALE_S:
                    self.refresh_usage()
                if time.time() - self.update_at > UPDATE_INTERVAL_S:
                    self.check_update()
        elif kind == "focus":
            s = next((s for s in self.live if s["pid"] == msg.get("pid")), None)
            if s:
                if self.unseen.pop(s["sessionId"], None):
                    self.push()
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
        elif kind == "openSettings":
            self.open_settings(msg.get("section"))
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
        elif kind == "focusLost":
            self.focus_prev = None  # você foi pra outra janela: nada a devolver
        elif kind == "askSend":
            self.ask_send(msg.get("prompt"), msg.get("cwd"))
        elif kind == "askStop":
            self.ask_stop()
        elif kind == "askClear":
            self.ask_clear()
        elif kind == "askCopy":
            if self.ask:
                copy_to_clipboard(self.ask.text())
        elif kind == "askResume":
            a = self.ask
            if a and a.status != "running" and a.stream.session_id:
                launch.resume(a.stream.session_id, a.cwd, self.config.get("terminal"))
        elif kind == "askPickFolder":
            GLib.idle_add(self._ask_pick_folder)
        elif kind == "pickFolder":
            GLib.idle_add(self._pick_folder)
        elif kind == "summaryRun":
            if (self.config.get("summary") or {}).get("enabled", True):
                self.summary_run()
        elif kind == "summaryCopy":
            if self.summary and self.summary.get("text"):
                copy_to_clipboard(self.summary["text"])

    def click_action(self):
        mode = self.config.get("clickAction")
        return mode if mode in launch.CLICK_ACTIONS else "open"

    def lang(self):
        choice = self.config.get("language") or "auto"
        return choice if choice in LANGS else system_language()

    def _set_config(self, key, value):
        # chave com ponto = aninhada ("usage.rings"); só entra o que está no CONFIG_SCHEMA
        check = CONFIG_SCHEMA.get(key)
        if not check or not check(value):
            return False
        node, *rest = key.split(".")
        if rest:
            sub = self.config.get(node)
            if not isinstance(sub, dict):
                sub = self.config[node] = {}
            sub[rest[0]] = value
        else:
            self.config[node] = value
        save_config(self.config)
        self.push()
        if key == "checkUpdates" and value:
            self.check_update()
        if key == "ask.shortcut":
            self._apply_hotkey()
        if key == "recap.mode" and value != "ai":
            self.recapper.clear()
        if self.library:
            self.library.refresh(reload=False)
        if self.settings:
            self.settings.refresh(lang_changed=key == "language")
        return True

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
    # instância única: `claude-dock --ask` numa segunda instância só avisa a primeira
    app = Gtk.Application(application_id="io.github.claudedock",
                          flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
    state = {}

    def ensure(a):
        if "dock" not in state:
            state["dock"] = Dock(a)
        return state["dock"]

    def on_command_line(a, cmdline):
        dock = ensure(a)
        if "--ask" in cmdline.get_arguments()[1:]:
            dock.open_ask()
        return 0

    app.connect("activate", ensure)
    app.connect("command-line", on_command_line)
    return app.run(sys.argv)
