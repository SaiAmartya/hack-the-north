"""FastAPI server: ingests base-station lines, streams arena state to the web view,
and runs the AI commentator loop."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import sys
import time
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from .arena import Arena
from .deck import default_deck, parse as parse_deck
from .narrator import ElevenLabsVoice, Narrator

WEB_DIR = Path(__file__).resolve().parents[1] / "web"


class Hub:
    def __init__(self, arena: Arena, narrator: Narrator | None, voice: ElevenLabsVoice | None, source=None):
        self.arena = arena
        self.narrator = narrator
        self.voice = voice
        self.source = source
        self.clients: set[WebSocket] = set()
        self.queue: asyncio.Queue[str] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.pending_events: list[dict] = []
        self.hooks: list[Callable[[dict], None]] = []  # e.g. the Oracle Altar tag writer
        self.lines = 0
        self.last_line_at = 0.0
        self.commentary: list[dict] = []

    # ---------- input ----------
    def push_line(self, line: str) -> None:
        """Thread-safe: called by a source thread."""
        if self.loop is None or self.queue is None:
            return
        self.loop.call_soon_threadsafe(self.queue.put_nowait, line)

    def ingest_now(self, line: str) -> list[dict]:
        """Synchronous ingest (tests, HTTP injection)."""
        self.lines += 1
        self.last_line_at = time.time()
        events = self.arena.ingest_line(line)
        self.pending_events.extend(events)
        for ev in events:
            for hook in self.hooks:
                try:
                    hook(ev)
                except Exception as e:  # a broken accessory must never stall the arena
                    print(f"[hook] {e}", file=sys.stderr)
        return events

    # ---------- output ----------
    async def broadcast(self, msg: dict) -> None:
        dead = []
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def state_message(self) -> dict:
        snap = self.arena.snapshot()
        snap["type"] = "state"
        snap["gateway_connected"] = bool(getattr(self.source, "connected", False)) or (time.time() - self.last_line_at < 5)
        snap["lines"] = self.lines
        snap["commentary"] = self.commentary[-6:]
        return snap

    # ---------- loops ----------
    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue()
        if self.source is not None:
            self.source.start(self.push_line)
        last_state = 0.0
        while True:
            try:
                line = await asyncio.wait_for(self.queue.get(), timeout=0.25)
                for ev in self.ingest_now(line):
                    await self.broadcast({"type": "event", "event": ev})
            except asyncio.TimeoutError:
                pass
            now = time.time()
            for ev in self.arena.prune(now):
                await self.broadcast({"type": "event", "event": ev})
            if now - last_state >= 0.5:
                last_state = now
                await self.broadcast(self.state_message())
            if self.narrator and self.pending_events and self.narrator.ready(now):
                events, self.pending_events = self.pending_events, []
                asyncio.create_task(self._narrate(events))

    async def _narrate(self, events: list[dict]) -> None:
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, self.narrator.commentate, events, self.arena.summary_for_ai())
        except Exception as e:  # pragma: no cover
            print(f"[narrator] {e}", file=sys.stderr)
            return
        if not text:
            return
        audio = None
        if self.voice and self.voice.available:
            audio = await loop.run_in_executor(None, self.voice.speak, text)
        msg = {"type": "say", "text": text, "t": time.time(), "audio": base64.b64encode(audio).decode() if audio else None}
        self.commentary.append({"text": text, "t": msg["t"]})
        await self.broadcast(msg)


def create_app(source=None, deck_path: str | Path | None = None, ai: bool = True, narrator: Narrator | None = None,
               voice: ElevenLabsVoice | None = None) -> FastAPI:
    arena = Arena()
    if deck_path and Path(deck_path).exists():
        arena.deck = [c.__dict__ for c in parse_deck(Path(deck_path).read_text(encoding="utf-8"))]
    else:
        arena.deck = [c.__dict__ for c in default_deck()]
    if narrator is None:
        narrator = Narrator(allow_network=ai)  # --no-ai keeps the templated commentator, no network calls
    if voice is None and ai:
        voice = ElevenLabsVoice()
    hub = Hub(arena, narrator, voice, source)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(hub.run())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            if source is not None:
                source.stop()

    app = FastAPI(title="Phantom Arena", lifespan=lifespan)
    app.state.hub = hub

    @app.get("/")
    async def index():
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/health")
    async def health():
        st = hub.state_message()
        return JSONResponse({"ok": True, "phase": st["phase"], "gateway_connected": st["gateway_connected"],
                             "badges": st["stats"]["badges"], "lines": hub.lines,
                             "ai": bool(narrator and narrator.client), "voice": bool(voice and voice.available)})

    @app.get("/api/state")
    async def state():
        return JSONResponse(hub.state_message())

    @app.post("/api/line")
    async def post_line(body: dict):
        """Inject a base-station line (tests, or a second relay badge on another laptop)."""
        events = hub.ingest_now(str(body.get("line", "")))
        for ev in events:
            await hub.broadcast({"type": "event", "event": ev})
        return {"events": events}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        hub.clients.add(websocket)
        try:
            await websocket.send_text(json.dumps(hub.state_message()))
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(websocket)

    return app
