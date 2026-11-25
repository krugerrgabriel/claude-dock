"""Comando rápido: roda `claude -p` em segundo plano e transmite a resposta pro painel.

``Stream`` é puro (recebe os eventos do stream-json e monta a resposta) pra dar
pra testar sem processo; ``Run`` cuida do processo numa thread e avisa o dock.
"""

import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import cli

STATE_DIR = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "claude-dock"
HISTORY_PATH = STATE_DIR / "asks.json"
HISTORY_MAX = 50

READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
EDIT_TOOLS = READ_TOOLS + ["Edit", "Write"]
MODELS = ("haiku", "sonnet", "opus")


def model_for(mode, model):
    """auto = haiku no modo só ler; nos outros, o modelo padrão do Claude (None)."""
    if model in MODELS:
        return model
    return "haiku" if mode == "read" else None


def build_argv(binary, prompt, mode, model, resume=None):
    argv = cli.base_argv(binary) + ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    if resume:
        argv += ["--resume", resume]   # mesma conversa: o Claude lembra dos pedidos anteriores
    m = model_for(mode, model)
    if m:
        argv += ["--model", m]
    if mode == "full":
        argv += ["--permission-mode", "bypassPermissions"]
    elif mode == "edit":
        # o que pediria permissão (Bash etc.) é negado na hora, sem travar
        argv += ["--permission-mode", "acceptEdits", "--allowedTools", " ".join(EDIT_TOOLS),
                 "--permission-prompts", "none"]
    else:
        # modo explícito: o defaultMode do usuário (ex.: auto) não pode liberar nada aqui
        argv += ["--permission-mode", "dontAsk", "--allowedTools", " ".join(READ_TOOLS),
                 "--permission-prompts", "none"]
    # "--" pra um pedido que começa com "-" não virar opção
    return argv + ["--", prompt]


def _short(s, n=60):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n - 1] + "…"


def tool_arg(name, inp):
    """O pedaço que interessa de cada ferramenta, pra linha "Lendo README.md…"."""
    inp = inp if isinstance(inp, dict) else {}
    if name in ("Read", "Edit", "Write", "NotebookEdit"):
        p = inp.get("file_path") or inp.get("notebook_path") or ""
        return os.path.basename(str(p).rstrip("/")) or _short(p)
    if name in ("Glob", "Grep"):
        return _short(inp.get("pattern"), 40)
    if name == "WebSearch":
        return _short(inp.get("query"), 50)
    if name == "WebFetch":
        url = str(inp.get("url") or "")
        return url.split("//", 1)[-1].split("/", 1)[0]
    if name == "Bash":
        return _short(inp.get("description") or inp.get("command"), 50)
    return ""


class Stream:
    """Monta a resposta a partir dos eventos do `claude -p --output-format stream-json`.

    items: [{"kind": "text", "text"}, {"kind": "tool", "tool", "arg", "denied"}], na ordem
    em que aconteceram. Texto chega aos pedaços (text_delta) e é trocado pelo bloco
    completo quando a mensagem `assistant` correspondente chega.
    """

    def __init__(self):
        self.items = []
        self.session_id = None
        self.streaming = None     # índice do item de texto sendo escrito agora
        self.tools = {}           # tool_use_id -> índice
        self.result = None        # {"error": bool, "text": str}
        self.model = None

    def feed(self, ev):
        t = ev.get("type")
        if ev.get("parent_tool_use_id"):
            return False          # subagente: fica de fora
        if t == "system" and ev.get("subtype") == "init":
            self.session_id = ev.get("session_id") or self.session_id
            self.model = ev.get("model")
            return False
        if t == "stream_event":
            e = ev.get("event") or {}
            et = e.get("type")
            if et == "content_block_start" and (e.get("content_block") or {}).get("type") == "text":
                self.items.append({"kind": "text", "text": ""})
                self.streaming = len(self.items) - 1
                return False
            if et == "content_block_delta" and (e.get("delta") or {}).get("type") == "text_delta":
                if self.streaming is None:
                    self.items.append({"kind": "text", "text": ""})
                    self.streaming = len(self.items) - 1
                self.items[self.streaming]["text"] += e["delta"].get("text") or ""
                return True
            return False
        if t == "assistant":
            changed = False
            for block in (ev.get("message") or {}).get("content") or []:
                bt = block.get("type")
                if bt == "text":
                    text = block.get("text") or ""
                    if self.streaming is not None:
                        self.items[self.streaming]["text"] = text
                        self.streaming = None
                    elif text:
                        self.items.append({"kind": "text", "text": text})
                    changed = True
                elif bt == "tool_use" and block.get("id") not in self.tools:
                    self.streaming = None
                    self.tools[block.get("id")] = len(self.items)
                    self.items.append({"kind": "tool", "tool": block.get("name") or "",
                                       "arg": tool_arg(block.get("name"), block.get("input"))})
                    changed = True
            return changed
        if t == "user":
            changed = False
            for block in (ev.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error"):
                    i = self.tools.get(block.get("tool_use_id"))
                    content = block.get("content")
                    text = content if isinstance(content, str) else json.dumps(content)
                    if i is not None and "denied" in text.lower():
                        self.items[i]["denied"] = True
                        changed = True
            return changed
        if t == "result":
            self.session_id = ev.get("session_id") or self.session_id
            text = ev.get("result") if isinstance(ev.get("result"), str) else ""
            err = bool(ev.get("is_error")) or ev.get("subtype") not in (None, "success")
            self.result = {"error": err, "text": text}
            if not err and text and not self.text():
                self.items.append({"kind": "text", "text": text})
            self.items = [it for it in self.items if it["kind"] != "text" or it["text"].strip()]
            self.streaming = None
            return True
        return False

    def text(self):
        return "\n\n".join(it["text"].strip() for it in self.items if it["kind"] == "text" and it["text"].strip())


class Run:
    """Um pedido rodando. on_change() e on_end() são chamados da thread de leitura:
    quem recebe agenda o trabalho na thread da interface."""

    def __init__(self, prompt, cwd, mode, model, on_change, on_end, resume=None, turns=None):
        self.prompt = prompt
        self.resume = resume
        self.turns = turns or []     # pedidos anteriores da mesma conversa: [{"prompt", "items"}]
        self.cwd = cwd
        self.mode = mode
        self.model = model_for(mode, model)
        self.stream = Stream()
        self.stream.session_id = resume
        self.status = "running"      # running | done | error | stopped
        self.error = None
        self.started_at = time.time()
        self.ended_at = None
        self.proc = None
        self.lock = threading.Lock()
        self._on_change = on_change
        self._on_end = on_end
        self._stopping = False

    def start(self):
        binary = cli.claude_bin()
        if not binary:
            self._finish("error", "noClaude")
            return
        try:
            self.proc = subprocess.Popen(
                build_argv(binary, self.prompt, self.mode, self.model, self.resume), cwd=self.cwd, env=cli.child_env(),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                start_new_session=True)
        except OSError as e:
            self._finish("error", str(e))
            return
        cli.track(self.proc.pid)
        threading.Thread(target=self._read, daemon=True).start()

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def _read(self):
        last_noise = ""
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                last_noise = line   # aviso no stderr: vira a mensagem de erro se nada vier
                continue
            if not isinstance(ev, dict):
                continue
            try:
                with self.lock:
                    changed = self.stream.feed(ev)
            except Exception:  # noqa: BLE001 - evento num formato inesperado: ignora, o pedido segue
                continue
            if changed:
                self._on_change()
        code = self.proc.wait()
        cli.untrack(self.proc.pid)
        res = self.stream.result
        if self._stopping:
            self._finish("stopped")
        elif res and not res["error"]:
            self._finish("done")
        elif res:
            self._finish("error", res["text"] or last_noise or f"exit {code}")
        else:
            self._finish("error", last_noise or f"exit {code}")

    def _finish(self, status, error=None):
        with self.lock:
            self.status = status
            self.error = _short(error, 300) if error else None
            self.ended_at = time.time()
        self._on_end()

    def stop(self):
        if self.status != "running" or not self.proc:
            return
        self._stopping = True
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    def snapshot(self):
        with self.lock:
            return {
                "prompt": self.prompt,
                "cwd": self.cwd,
                "project": os.path.basename(self.cwd.rstrip("/")) or "~",
                "short": self.cwd.replace(str(Path.home()), "~", 1),
                "mode": self.mode,
                "model": self.model,
                "status": self.status,
                "error": self.error,
                "sessionId": self.stream.session_id,
                "turns": [{"prompt": t["prompt"], "items": [dict(it) for it in t["items"]]} for t in self.turns],
                "items": [dict(it) for it in self.stream.items],
                "streaming": self.stream.streaming is not None,
                "startedAt": self.started_at,
                "endedAt": self.ended_at,
            }

    def text(self):
        with self.lock:
            return self.stream.text()

    def thread(self):
        """Os pedidos dessa conversa até aqui (pra continuar no próximo)."""
        with self.lock:
            items = [dict(it) for it in self.stream.items]
        if self.status == "stopped":
            items.append({"kind": "note", "text": "stopped"})
        return self.turns + [{"prompt": self.prompt, "items": items}]


# --------------------------------------------------------------- histórico

def load_history():
    try:
        data = json.loads(HISTORY_PATH.read_text())
    except (OSError, ValueError):
        return []
    return [s for s in data if isinstance(s, str)][:HISTORY_MAX] if isinstance(data, list) else []


def add_history(hist, prompt):
    """Mais recente primeiro, sem repetir. Grava e devolve a lista nova."""
    out = [prompt] + [h for h in hist if h != prompt]
    out = out[:HISTORY_MAX]
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = HISTORY_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, ensure_ascii=False, indent=0))
        tmp.replace(HISTORY_PATH)
    except OSError:
        pass
    return out
