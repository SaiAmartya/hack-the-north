"""The authoritative host: serial in, rules applied, one state stream out.

Pipeline, in one place so it is easy to reason about:

    serial line -> parse_radio_line -> PacketDeduper -> game.apply_event
                -> effects buffer -> ArenaEnvelope -> every browser

``ArenaHost.handle_line`` is the seam. Real serial input and tests both go
through it, so a test never needs a fake badge.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import queue
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from phantom_host import game
from phantom_host.arena_director import ArenaDirector
from phantom_host.broadcaster import ArenaBroadcaster
from phantom_host.config import Settings
from phantom_host.contracts import (
    ArenaDirective,
    ArenaEnvelope,
    ArenaState,
    Effect,
    MarkerPose,
)
from phantom_host.dedup import PacketDeduper
from phantom_host.protocol import parse_radio_line
from phantom_host.serial_gateway import SerialGateway
from phantom_host.vision import CameraWorker, MarkerTracker

logger = logging.getLogger(__name__)

MAX_BUFFERED_EFFECTS = 64


def neutral_markers() -> dict[str, MarkerPose]:
    """Both players present but unlocated, which is the safe default.

    Reporting ``visible=False`` is deliberately better than reusing a stale
    position: attributing a health bar to the wrong player is worse than not
    anchoring it at all.
    """
    return {
        player_id: MarkerPose(player_id=player_id, x=0.5, y=0.5, visible=False)
        for player_id in game.PLAYER_IDS
    }


class ArenaHost:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._boot_monotonic = time.monotonic()
        self._frozen_ms: int | None = None

        self.state: ArenaState = game.new_match(self.now_ms())
        self.markers: dict[str, MarkerPose] = neutral_markers()
        self.frame_jpeg_base64: str | None = None
        self.director_commentary: str | None = None

        self._deduper = PacketDeduper()
        self._effects: list[Effect] = []
        self._lines: queue.SimpleQueue[str] = queue.SimpleQueue()

        self.gateway: SerialGateway | None = None
        self.camera: CameraWorker | None = None
        self.director: ArenaDirector | None = None
        self.director_task: asyncio.Task[None] | None = None
        self.packets_applied = 0
        self.duplicates_dropped = 0
        self.lines_rejected = 0

    # -- clock ---------------------------------------------------------------

    def now_ms(self) -> int:
        if self._frozen_ms is not None:
            return self._frozen_ms
        return int((time.monotonic() - self._boot_monotonic) * 1000)

    def uptime_ms(self) -> int:
        return int((time.monotonic() - self._boot_monotonic) * 1000)

    def advance(self, to_ms: int) -> list[Effect]:
        """Freeze the clock at ``to_ms`` and tick. A seam for tests and replays."""
        self._frozen_ms = to_ms
        return self.tick()

    # -- ingest --------------------------------------------------------------

    def enqueue_line(self, line: str) -> None:
        """Called from the serial thread. Thread-safe by construction."""
        self._lines.put(line)

    def drain_serial_queue(self) -> int:
        count = 0
        while True:
            try:
                line = self._lines.get_nowait()
            except queue.Empty:
                return count
            self.handle_line(line)
            count += 1

    def handle_line(self, line: str) -> list[Effect]:
        now = self.now_ms()

        event = parse_radio_line(line, now)
        if event is None:
            self.lines_rejected += 1
            return []

        if not self._deduper.accept(event):
            self.duplicates_dropped += 1
            return []

        self.packets_applied += 1
        effects = game.apply_event(self.state, event, now)

        if event.kind == "EVT" and event.value == game.RESET_VALUE:
            # A badge keeps counting sequences across a reset, so the next match's
            # first packets must not look like duplicates. Re-accept this event so
            # its own two retries are still suppressed.
            self._deduper.reset()
            self._deduper.accept(event)

        self._record(effects)
        return effects

    def reset_match(self) -> list[Effect]:
        effects = game.reset_match(self.state, self.now_ms())
        self._deduper.reset()
        self.director_commentary = None
        if self.director is not None:
            self.director.reset()
        self._record(effects)
        return effects

    def apply_directive(self, directive: ArenaDirective) -> list[Effect]:
        """Route a Director proposal through the engine, which is authoritative."""
        effects = game.apply_directive(self.state, directive, self.now_ms())
        if effects:
            self.director_commentary = directive.commentary
            self._record(effects)
        return effects

    def tick(self) -> list[Effect]:
        effects = game.tick(self.state, self.now_ms())
        self._record(effects)
        return effects

    def _record(self, effects: list[Effect]) -> None:
        if not effects:
            return
        self._effects.extend(effects)
        if len(self._effects) > MAX_BUFFERED_EFFECTS:
            # A browser that is not listening must not grow the buffer forever.
            del self._effects[:-MAX_BUFFERED_EFFECTS]

    # -- egress --------------------------------------------------------------

    @property
    def gateway_connected(self) -> bool:
        return bool(self.gateway and self.gateway.connected)

    @property
    def camera_available(self) -> bool:
        return bool(self.camera and self.camera.available)

    def sync_camera(self) -> None:
        """Copy the camera thread's latest output into the published state.

        The camera runs at its own cadence, so state updates never wait for a
        frame. A dropped capture already reports ``visible=False``.
        """
        if self.camera is None:
            return
        self.markers = self.camera.markers
        self.frame_jpeg_base64 = self.camera.frame_jpeg_base64

    def build_envelope(self, drain: bool = True) -> ArenaEnvelope:
        effects = list(self._effects)
        if drain:
            self._effects.clear()

        return ArenaEnvelope(
            state=self.state,
            markers=self.markers,
            effects=effects,
            director_commentary=self.director_commentary,
            frame_jpeg_base64=self.frame_jpeg_base64,
            gateway_connected=self.gateway_connected,
            server_now_ms=self.now_ms(),
        )

    def envelope_payload(self, drain: bool = True) -> dict[str, Any]:
        return self.build_envelope(drain=drain).model_dump(by_alias=True)

    def health_payload(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "phase": self.state.phase,
            "gatewayConnected": self.gateway_connected,
            "gatewayPort": self.gateway.port if self.gateway else None,
            "cameraAvailable": self.camera_available,
            "markersVisible": {
                player_id: pose.visible for player_id, pose in self.markers.items()
            },
            "uptimeMs": self.uptime_ms(),
            "packetsApplied": self.packets_applied,
            "duplicatesDropped": self.duplicates_dropped,
            "linesRejected": self.lines_rejected,
            "directorLive": bool(self.director and self.director.live),
            "directorRequests": self.director.requests_made if self.director else 0,
            "directorFallbacks": self.director.fallbacks_used if self.director else 0,
            "winner": self.state.winner,
        }


def create_app(
    settings: Settings | None = None, host: ArenaHost | None = None
) -> FastAPI:
    settings = settings or Settings.from_env()
    arena = host or ArenaHost(settings)
    broadcaster = ArenaBroadcaster()

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        stop_serial: threading.Event | None = None
        stop_camera: threading.Event | None = None

        if settings.serial_enabled:
            arena.gateway = SerialGateway(
                on_line=arena.enqueue_line,
                port=settings.serial_port,
                baudrate=settings.serial_baudrate,
            )
            _thread, stop_serial = arena.gateway.start()
            logger.info("serial gateway thread started")

        if settings.camera_enabled:
            arena.camera = CameraWorker(
                MarkerTracker(settings.marker_ids),
                camera_index=settings.camera_index,
                fps=settings.camera_fps,
                max_width=settings.camera_max_width,
            )
            _camera_thread, stop_camera = arena.camera.start()
            logger.info("camera thread started")

        if arena.director is None:
            # Pre-set by tests to inject a fake OpenAI client.
            arena.director = ArenaDirector(settings)
        logger.info(
            "arena director %s",
            "live" if arena.director.live else "fallback only (no API key)",
        )

        tick_task = asyncio.create_task(_tick_loop(arena, broadcaster, settings))

        try:
            yield
        finally:
            tick_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await tick_task
            if arena.director_task is not None:
                arena.director_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await arena.director_task
            if stop_serial is not None:
                stop_serial.set()
            if stop_camera is not None:
                stop_camera.set()

    app = FastAPI(title="Phantom Arena", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return arena.health_payload()

    @app.post("/match/reset")
    async def reset() -> dict[str, Any]:
        """Operator path that does not depend on the judge badge being alive."""
        arena.reset_match()
        payload = arena.envelope_payload(drain=False)
        await broadcaster.publish(arena.envelope_payload())
        return payload

    @app.websocket("/ws/arena")
    async def arena_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        # Send a snapshot immediately so a browser joining mid-match is not blank
        # until the next tick. Does not drain effects owned by other clients.
        await websocket.send_json(arena.envelope_payload(drain=False))
        await broadcaster.add(websocket)

        try:
            while True:
                # The client never drives the match; this only detects a close.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception as error:  # pragma: no cover - transport level
            logger.debug("arena socket error: %s", error)
        finally:
            await broadcaster.remove(websocket)

    app.state.arena = arena
    app.state.broadcaster = broadcaster
    return app


async def _tick_loop(
    arena: ArenaHost, broadcaster: ArenaBroadcaster, settings: Settings
) -> None:
    interval = 1.0 / max(1, settings.tick_hz)
    while True:
        try:
            arena.drain_serial_queue()
            arena.sync_camera()
            arena.tick()
            _pump_director(arena)
            await broadcaster.publish(arena.envelope_payload())
        except asyncio.CancelledError:
            raise
        except Exception as error:  # pragma: no cover - keep the match alive
            logger.exception("tick failed: %s", error)
        await asyncio.sleep(interval)


def _pump_director(arena: ArenaHost) -> None:
    """Start a Director request if one is due and none is already in flight.

    The OpenAI call is synchronous and can take seconds, so it runs in a worker
    thread. Blocking the tick loop would freeze the whole arena for every
    spectator, which is a far worse failure than a late modifier.
    """
    director = arena.director
    if director is None:
        return
    if arena.director_task is not None and not arena.director_task.done():
        return
    if not director.should_request(arena.state, arena.now_ms()):
        return

    director.schedule_next(arena.now_ms())
    arena.director_task = asyncio.create_task(_request_directive(arena, director))


async def _request_directive(arena: ArenaHost, director: ArenaDirector) -> None:
    try:
        directive = await asyncio.to_thread(
            director.request_directive, arena.state, arena.markers
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:  # pragma: no cover - request_directive never raises
        logger.warning("director task failed: %s", error)
        return

    arena.apply_directive(directive)


# Module level app for `uvicorn phantom_host.main:app`. Construction is cheap and
# side effect free; the serial thread only starts when the lifespan runs.
app = create_app()


def main() -> None:
    """Entrypoint that honours the configured bind address.

    Exists so bind_host/bind_port are not decorative: this socket streams webcam
    frames and has no authentication, so the default must be loopback whether the
    operator remembers the uvicorn flag or not.
    """
    import uvicorn

    settings = Settings.from_env()
    uvicorn.run(app, host=settings.bind_host, port=settings.bind_port)


if __name__ == "__main__":
    main()
