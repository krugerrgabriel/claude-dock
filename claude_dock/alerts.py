"""Avisos: percebe quando uma sessão passa a esperar você ou termina um trabalho.

A detecção é pura (``Tracker.step``) pra dar pra testar sem GTK; quem mostra a
notificação é ``Notifier`` (libnotify), chamado pelo dock na thread da interface.
"""

import shutil
import subprocess
import time

import gi

DONE_MIN_BUSY_S = 20     # respostas mais curtas que isso não avisam "terminou"
GROUP_WINDOW_S = 3       # avisos nessa janela viram uma notificação só
SOUND_NAME = "message-new-instant"

WAIT_REASONS = {
    "permission": "permission",
    "input needed": "input",
    "dialog open": "dialog",
    "sandbox request": "sandbox",
}

TEXTS = {
    "en": {
        "permission": "Asking for permission",
        "input": "Has a question for you",
        "dialog": "Opened a dialog",
        "sandbox": "Asking for network access",
        "other": "Waiting for you",
        "needsYou": "{title} needs you",
        "finished": "{title} finished",
        "nWaiting": "{n} sessions need you",
        "nDone": "{n} sessions finished",
        "nMixed": "{n} sessions need your attention",
        "doneLine": "finished",
        "go": "Go to session",
        "untitled": "New session",
        "testTitle": "Alerts are on",
        "testBody": "This is how the dock lets you know a session needs you.",
        "askReady": "Request ready",
        "askFailed": "Request failed",
        "sumReady": "Today's summary is ready",
        "sumFailed": "Today's summary failed",
        "view": "View",
        "forgotTitle": "Forgotten session: {title}",
        "forgotBody": "Idle for {h} h · {n} uncommitted files",
        "forgotBody1": "Idle for {h} h · 1 uncommitted file",
        "limitTitle": "Limit running out",
        "limitBody": "At this pace, your 5-hour limit runs out at {hm}.",
    },
    "pt": {
        "permission": "Pede permissão",
        "input": "Tem uma pergunta pra você",
        "dialog": "Abriu um diálogo",
        "sandbox": "Pede acesso de rede",
        "other": "Espera você",
        "needsYou": "{title} precisa de você",
        "finished": "{title} terminou",
        "nWaiting": "{n} sessões precisam de você",
        "nDone": "{n} sessões terminaram",
        "nMixed": "{n} sessões pedem sua atenção",
        "doneLine": "terminou",
        "go": "Ir pra sessão",
        "untitled": "Nova sessão",
        "testTitle": "Avisos ligados",
        "testBody": "É assim que o dock avisa quando uma sessão precisa de você.",
        "askReady": "Pedido pronto",
        "askFailed": "O pedido falhou",
        "sumReady": "Resumo de hoje pronto",
        "sumFailed": "O resumo de hoje falhou",
        "view": "Ver",
        "forgotTitle": "Sessão esquecida: {title}",
        "forgotBody": "Parada há {h} h · {n} arquivos sem commit",
        "forgotBody1": "Parada há {h} h · 1 arquivo sem commit",
        "limitTitle": "Limite chegando",
        "limitBody": "No ritmo atual, o limite de 5h acaba às {hm}.",
    },
}


def reason_key(waiting_for):
    return WAIT_REASONS.get((waiting_for or "").strip().lower(), "other")


class Tracker:
    """Guarda o último estado de cada sessão e devolve as transições de cada tick."""

    def __init__(self):
        self.prev = {}   # sessionId -> {"status", "busySince"}

    def step(self, live, now=None):
        """[(kind, session)] com kind "waiting" ou "done". Sessão vista pela 1ª vez
        não gera aviso (ao abrir o dock nada dispara)."""
        now = time.time() if now is None else now
        events, cur = [], {}
        for s in live:
            sid = s.get("sessionId")
            if not sid:
                continue
            st = s.get("status") or "idle"
            old = self.prev.get(sid)
            busy_since = old["busySince"] if old else None
            if st == "busy" and (not old or old["status"] == "idle"):
                # começou a trabalhar agora (ou já estava quando o dock abriu)
                busy_since = s.get("statusSince") or now
            elif st == "idle":
                busy_since = None
            if old:
                if st == "waiting" and old["status"] != "waiting":
                    events.append(("waiting", s))
                elif st == "idle" and old["status"] == "busy" and old["busySince"] \
                        and now - old["busySince"] >= DONE_MIN_BUSY_S:
                    events.append(("done", s))
            cur[sid] = {"status": st, "busySince": busy_since}
        self.prev = cur
        return events


def summarize(events, lang):
    """(título, corpo) de uma notificação que junta um ou mais avisos."""
    tx = TEXTS.get(lang, TEXTS["en"])

    def title_of(s):
        t = s.get("title") or tx["untitled"]
        return t if len(t) <= 60 else t[:59] + "…"

    if len(events) == 1:
        kind, s = events[0]
        if kind == "waiting":
            return tx["needsYou"].format(title=title_of(s)), f'{tx[reason_key(s.get("waitingFor"))]} · {s.get("project") or ""}'.strip(" ·")
        return tx["finished"].format(title=title_of(s)), s.get("project") or ""
    kinds = {k for k, _ in events}
    n = len(events)
    head = tx["nWaiting"] if kinds == {"waiting"} else tx["nDone"] if kinds == {"done"} else tx["nMixed"]
    lines = []
    for kind, s in events[:5]:
        why = tx[reason_key(s.get("waitingFor"))] if kind == "waiting" else tx["doneLine"]
        lines.append(f"• {title_of(s)}: {why}" if kinds != {"done"} else f"• {title_of(s)}")
    if n > 5:
        lines.append("…")
    return head.format(n=n), "\n".join(lines)


class Notifier:
    """Mostra notificações do sistema (libnotify) com a ação "Ir pra sessão"."""

    def __init__(self):
        self.ok = False
        self.caps = []
        self.current = None      # notificação aberta, pra juntar avisos próximos
        self.current_at = 0
        self.events = []
        try:
            gi.require_version("Notify", "0.7")
            from gi.repository import Notify
            self.Notify = Notify
            self.ok = Notify.init("Claude Dock")
            self.caps = (Notify.get_server_caps() or []) if self.ok else []
        except (ValueError, ImportError):
            self.ok = False

    def show(self, events, lang, on_go, sound=False, icon=None):
        """events: [(kind, session)]. on_go(session) é chamado pela ação."""
        if not self.ok or not events:
            return
        now = time.time()
        if self.current is not None and now - self.current_at <= GROUP_WINDOW_S:
            # mesma rajada: atualiza a notificação em vez de empilhar outra
            known = {s.get("sessionId") for _, s in self.events}
            self.events += [e for e in events if e[1].get("sessionId") not in known]
            n = self.current
            sound = False  # já tocou na primeira
        else:
            self.events = list(events)
            n = self.Notify.Notification.new("", "", icon)
            n.set_app_name("Claude Dock")
            n.connect("closed", self._closed)
        self.current, self.current_at = n, now
        title, body = summarize(self.events, lang)
        n.update(title, body, icon)
        n.set_hint("desktop-entry", _variant_str("claude-dock"))
        n.set_urgency(self.Notify.Urgency.NORMAL)
        if "actions" in self.caps:
            n.clear_actions()
            # vai pra que mais importa: a primeira que espera, senão a primeira que terminou
            target = next((s for k, s in self.events if k == "waiting"), self.events[0][1])
            tx = TEXTS.get(lang, TEXTS["en"])
            # "default" = clicar no corpo da notificação
            n.add_action("default", tx["go"], lambda *_a: on_go(target))
            n.add_action("go", tx["go"], lambda *_a: on_go(target))
        if sound:
            self._sound(n)
        try:
            n.show()
        except Exception:  # noqa: BLE001 - servidor de notificação sumiu: não derruba o dock
            pass

    def test(self, lang, sound=False, icon=None):
        if not self.ok:
            return False
        tx = TEXTS.get(lang, TEXTS["en"])
        n = self.Notify.Notification.new(tx["testTitle"], tx["testBody"], icon)
        n.set_app_name("Claude Dock")
        if sound:
            self._sound(n)
        try:
            n.show()
        except Exception:  # noqa: BLE001
            return False
        return True

    def ask_done(self, ok, body, lang, on_view, sound=False, icon=None):
        """Comando rápido terminou com o painel fechado: "Pedido pronto" com a ação "Ver"."""
        self.ready("askReady" if ok else "askFailed", body, lang, on_view, sound, icon)

    def summary_done(self, ok, body, lang, on_view, sound=False, icon=None):
        """Resumo de hoje ficou pronto com o painel fechado."""
        self.ready("sumReady" if ok else "sumFailed", body, lang, on_view, sound, icon)

    def ready(self, title_key, body, lang, on_view, sound=False, icon=None):
        if not self.ok:
            return
        tx = TEXTS.get(lang, TEXTS["en"])
        n = self.Notify.Notification.new(tx[title_key], body or "", icon)
        n.set_app_name("Claude Dock")
        n.set_hint("desktop-entry", _variant_str("claude-dock"))
        if "actions" in self.caps:
            n.add_action("default", tx["view"], lambda *_a: on_view())
            n.add_action("view", tx["view"], lambda *_a: on_view())
        if sound:
            self._sound(n)
        self.ask_note = n  # sem referência viva o callback da ação some
        try:
            n.show()
        except Exception:  # noqa: BLE001
            pass

    def forgotten(self, session, idle_s, files, lang, on_go, sound=False, icon=None):
        """Sessão parada há horas com alterações sem commit (no máximo 1x por dia, quem decide é o dock)."""
        if not self.ok:
            return
        tx = TEXTS.get(lang, TEXTS["en"])
        title = session.get("title") or tx["untitled"]
        title = title if len(title) <= 60 else title[:59] + "…"
        body = tx["forgotBody1" if files == 1 else "forgotBody"].format(h=max(1, int(idle_s // 3600)), n=files)
        n = self.Notify.Notification.new(tx["forgotTitle"].format(title=title),
                                         f"{body} · {session.get('project') or ''}".rstrip(" ·"), icon)
        n.set_app_name("Claude Dock")
        n.set_hint("desktop-entry", _variant_str("claude-dock"))
        if "actions" in self.caps:
            n.add_action("default", tx["go"], lambda *_a: on_go(session))
            n.add_action("go", tx["go"], lambda *_a: on_go(session))
        if sound:
            self._sound(n)
        self.forgot_note = n  # sem referência viva o callback da ação some
        try:
            n.show()
        except Exception:  # noqa: BLE001
            pass

    def limit(self, eta, lang, sound=False, icon=None):
        """Faltam ~30 min pro limite de 5h no ritmo atual (1x por janela)."""
        if not self.ok:
            return
        tx = TEXTS.get(lang, TEXTS["en"])
        hm = time.strftime("%H:%M", time.localtime(eta))
        n = self.Notify.Notification.new(tx["limitTitle"], tx["limitBody"].format(hm=hm), icon)
        n.set_app_name("Claude Dock")
        n.set_hint("desktop-entry", _variant_str("claude-dock"))
        if sound:
            self._sound(n)
        try:
            n.show()
        except Exception:  # noqa: BLE001
            pass

    def _sound(self, n):
        if "sound" in self.caps:
            n.set_hint("sound-name", _variant_str(SOUND_NAME))
        elif shutil.which("canberra-gtk-play"):
            subprocess.Popen(["canberra-gtk-play", "-i", SOUND_NAME], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _closed(self, n):
        if n is self.current:
            self.current = None
            self.events = []


def _variant_str(s):
    from gi.repository import GLib
    return GLib.Variant("s", s)
