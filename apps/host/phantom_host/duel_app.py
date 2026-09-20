"""Isolated HTTP and WebSocket entrypoint for the Wand Duel runtime."""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, Response, WebSocket
from fastapi.websockets import WebSocketDisconnect
from pydantic import ValidationError

from phantom_host.duel_engine import ALL_SPELLS, CORE_SPELLS, TICK_MS
from phantom_host.duel_models import (
    AuthMessage,
    CastMessage,
    ErrorMessage,
    GAME_MESSAGE_ADAPTER,
    HealthResponse,
    HeartbeatMessage,
    LeaveMessage,
    PairResponse,
    ReadyMessage,
    RELAY_AUTH_ADAPTER,
    RELAY_OWNER_MESSAGE_ADAPTER,
    RELAY_PHONE_MESSAGE_ADAPTER,
    RelayOwnerAuth,
    RelayPhoneAuth,
    SessionRequest,
    SessionResponse,
    SignalMessage,
    Spell,
    wire_dict,
)
from phantom_host.duel_relay import DevWandRelay, RelayPeer
from phantom_host.duel_room import DuelRoom, GamePeer, OutboundMailbox, RoomError

GAME_MESSAGE_LIMIT = 32_768
RELAY_MESSAGE_LIMIT = 4_096
AUTH_TIMEOUT_SECONDS = 5.0
DEFAULT_ALLOWED_ORIGINS = frozenset(
    {"http://127.0.0.1:5173", "http://localhost:5173"}
)


def _monotonic_ms() -> int:
    return time.monotonic_ns() // 1_000_000


def _environment_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean flag")


def _environment_spells(name: str) -> frozenset[Spell]:
    """Comma-separated spell allowlist; unset or empty means every spell."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return ALL_SPELLS
    chosen: set[Spell] = set()
    for item in raw.split(","):
        value = item.strip().lower()
        if not value:
            continue
        try:
            chosen.add(Spell(value))
        except ValueError:
            raise ValueError(f"{name} names an unknown spell: {value!r}") from None
    if not CORE_SPELLS <= chosen:
        raise ValueError(f"{name} must include stupefy and protego")
    return frozenset(chosen)


@dataclass(frozen=True)
class DuelSettings:
    host: str = "127.0.0.1"
    allowed_origins: frozenset[str] = DEFAULT_ALLOWED_ORIGINS
    dev_relay_enabled: bool = False
    allow_replay: bool = False
    enabled_spells: frozenset[Spell] = ALL_SPELLS
    start_background_tick: bool = True

    @classmethod
    def from_environment(cls) -> DuelSettings:
        origins_raw = os.getenv("WAND_ALLOWED_ORIGINS")
        origins = (
            frozenset(
                origin.strip()
                for origin in origins_raw.split(",")
                if origin.strip()
            )
            if origins_raw is not None
            else DEFAULT_ALLOWED_ORIGINS
        )
        if not origins:
            raise ValueError("WAND_ALLOWED_ORIGINS must contain an exact origin")
        return cls(
            host=os.getenv("WAND_HOST", "127.0.0.1"),
            allowed_origins=origins,
            dev_relay_enabled=_environment_flag("WAND_DEV_RELAY"),
            allow_replay=_environment_flag("WAND_ALLOW_REPLAY"),
            enabled_spells=_environment_spells("WAND_SPELLS"),
        )


def create_app(
    settings: DuelSettings | None = None,
    *,
    clock_ms: Callable[[], int] | None = None,
) -> FastAPI:
    active_settings = settings or DuelSettings.from_environment()
    active_clock = clock_ms or _monotonic_ms
    room = DuelRoom(
        clock_ms=active_clock,
        allow_phone=active_settings.dev_relay_enabled,
        allow_replay=active_settings.allow_replay,
        enabled_spells=active_settings.enabled_spells,
    )
    relay = DevWandRelay(
        clock_ms=active_clock,
        session_lookup=room.session_for_token,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        tick_task: asyncio.Task[None] | None = None
        if active_settings.start_background_tick:
            tick_task = asyncio.create_task(_tick_loop(room))
        try:
            yield
        finally:
            if tick_task is not None:
                tick_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await tick_task

    app = FastAPI(
        title="Wand Duel",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.duel_settings = active_settings
    app.state.duel_room = room
    app.state.duel_relay = relay

    @app.get("/api/game/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(
            dev_relay_enabled=active_settings.dev_relay_enabled,
            allow_replay=active_settings.allow_replay,
        )

    @app.get("/api/game/rules")
    async def game_rules():
        return room.rules

    @app.post("/api/game/session", response_model=SessionResponse)
    async def create_session(
        payload: SessionRequest,
        request: Request,
    ) -> SessionResponse:
        _require_origin(request.headers.get("origin"), active_settings)
        try:
            return await room.create_session(name=payload.name, source=payload.source)
        except RoomError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail=error.code,
            ) from None

    @app.delete("/api/game/session", status_code=204)
    async def release_session(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> Response:
        _require_origin(request.headers.get("origin"), active_settings)
        token = _bearer_token(authorization)
        try:
            await room.release_session(token=token, now_ms=active_clock())
        except RoomError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail=error.code,
            ) from None
        return Response(status_code=204)

    @app.post("/api/game/pair", response_model=PairResponse)
    async def create_pair(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> PairResponse:
        _require_origin(request.headers.get("origin"), active_settings)
        if not active_settings.dev_relay_enabled:
            raise HTTPException(status_code=404, detail="dev_relay_disabled")
        token = _bearer_token(authorization)
        try:
            code, expires_at_ms = await relay.create_grant(token)
        except RoomError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail=error.code,
            ) from None
        return PairResponse(code=code, expires_at_ms=expires_at_ms)

    @app.websocket("/ws/game")
    async def game_socket(websocket: WebSocket) -> None:
        if not _origin_allowed(websocket.headers.get("origin"), active_settings):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        peer = GamePeer()
        writer: asyncio.Task[None] | None = None
        explicitly_left = False
        try:
            raw_auth = await asyncio.wait_for(
                websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS
            )
            if len(raw_auth.encode("utf-8")) > GAME_MESSAGE_LIMIT:
                await websocket.close(code=1009)
                return
            auth = AuthMessage.model_validate_json(raw_auth)
            welcome = await room.attach(
                token=auth.token,
                peer=peer,
                now_ms=active_clock(),
            )
            await websocket.send_json(wire_dict(welcome))
            writer = asyncio.create_task(_socket_writer(websocket, peer.mailbox))

            while True:
                raw_message = await websocket.receive_text()
                receipt_ms = active_clock()
                if len(raw_message.encode("utf-8")) > GAME_MESSAGE_LIMIT:
                    await websocket.close(code=1009)
                    return
                try:
                    message = GAME_MESSAGE_ADAPTER.validate_json(raw_message)
                except ValidationError:
                    if not peer.mailbox.offer_reliable(
                        wire_dict(ErrorMessage(code="invalid_message"))
                    ):
                        return
                    continue

                response: Any | None = None
                if isinstance(message, HeartbeatMessage):
                    response = await room.heartbeat(
                        peer=peer,
                        message=message,
                        receipt_ms=receipt_ms,
                    )
                elif isinstance(message, ReadyMessage):
                    response = await room.submit_ready(
                        peer=peer,
                        message=message,
                        receipt_ms=receipt_ms,
                    )
                elif isinstance(message, CastMessage):
                    response = await room.submit_cast(
                        peer=peer,
                        message=message,
                        receipt_ms=receipt_ms,
                    )
                elif isinstance(message, SignalMessage):
                    response = await room.forward_signal(peer=peer, message=message)
                elif isinstance(message, LeaveMessage):
                    explicitly_left = True
                    await room.leave(peer=peer, now_ms=receipt_ms)
                    break

                if response is not None and not peer.mailbox.offer_reliable(
                    wire_dict(response)
                ):
                    return
        except asyncio.TimeoutError:
            await websocket.close(code=1008)
        except (ValidationError, RoomError):
            with contextlib.suppress(RuntimeError):
                await websocket.send_json(wire_dict(ErrorMessage(code="auth_failed")))
                await websocket.close(code=1008)
        except WebSocketDisconnect:
            pass
        finally:
            if not explicitly_left:
                await room.detach(peer=peer, now_ms=active_clock())
            if writer is not None:
                writer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await writer

    @app.websocket("/ws/dev-wand")
    async def dev_wand_socket(websocket: WebSocket) -> None:
        if (
            not active_settings.dev_relay_enabled
            or not _origin_allowed(websocket.headers.get("origin"), active_settings)
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        peer: RelayPeer | None = None
        writer: asyncio.Task[None] | None = None
        try:
            raw_auth = await asyncio.wait_for(
                websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS
            )
            if len(raw_auth.encode("utf-8")) > RELAY_MESSAGE_LIMIT:
                await websocket.close(code=1009)
                return
            auth = RELAY_AUTH_ADAPTER.validate_json(raw_auth)
            if isinstance(auth, RelayOwnerAuth):
                peer = RelayPeer(role="owner")
                await relay.authenticate_owner(auth.token, peer)
            elif isinstance(auth, RelayPhoneAuth):
                peer = RelayPeer(role="phone")
                await relay.authenticate_phone(auth.code, peer)
            writer = asyncio.create_task(_socket_writer(websocket, peer.mailbox))

            while True:
                raw_message = await websocket.receive_text()
                if len(raw_message.encode("utf-8")) > RELAY_MESSAGE_LIMIT:
                    await websocket.close(code=1009)
                    return
                try:
                    if peer.role == "owner":
                        owner_message = RELAY_OWNER_MESSAGE_ADAPTER.validate_json(
                            raw_message
                        )
                        await relay.route_owner(peer, owner_message)
                    else:
                        phone_message = RELAY_PHONE_MESSAGE_ADAPTER.validate_json(
                            raw_message
                        )
                        await relay.route_phone(peer, phone_message)
                except ValidationError:
                    if not peer.mailbox.offer_reliable(
                        wire_dict(ErrorMessage(code="invalid_message"))
                    ):
                        return
                except RoomError:
                    if not peer.mailbox.offer_reliable(
                        wire_dict(ErrorMessage(code="stale_pair"))
                    ):
                        return
        except asyncio.TimeoutError:
            await websocket.close(code=1008)
        except (ValidationError, RoomError):
            with contextlib.suppress(RuntimeError):
                await websocket.send_json(wire_dict(ErrorMessage(code="auth_failed")))
                await websocket.close(code=1008)
        except WebSocketDisconnect:
            pass
        finally:
            if peer is not None:
                await relay.disconnect(peer)
            if writer is not None:
                writer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await writer

    return app


async def _tick_loop(room: DuelRoom) -> None:
    while True:
        await asyncio.sleep(TICK_MS / 1_000)
        await room.tick()


async def _socket_writer(
    websocket: WebSocket,
    mailbox: OutboundMailbox,
) -> None:
    try:
        while True:
            message = await mailbox.next_message()
            if message is None:
                with contextlib.suppress(RuntimeError):
                    await websocket.close(code=1001)
                return
            await websocket.send_json(message)
    except Exception:
        # Socket transports surface disconnects as backend-specific exception
        # types. A failed writer must never escape into the simulation task.
        return


def _origin_allowed(origin: str | None, settings: DuelSettings) -> bool:
    return origin is not None and origin in settings.allowed_origins


def _require_origin(origin: str | None, settings: DuelSettings) -> None:
    if not _origin_allowed(origin, settings):
        raise HTTPException(status_code=403, detail="origin_not_allowed")


def _bearer_token(authorization: str | None) -> str:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="bearer_token_required")
    token = authorization.removeprefix("Bearer ")
    if not token or any(character.isspace() for character in token):
        raise HTTPException(status_code=401, detail="bearer_token_required")
    return token


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=app.state.duel_settings.host, port=8000)
