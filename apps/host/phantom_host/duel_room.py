"""Authenticated one-room orchestration around the pure duel engine."""

from __future__ import annotations

import asyncio
import secrets
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from phantom_host.duel_engine import (
    HEARTBEAT_TIMEOUT_MS,
    AbortCommand,
    CastCommand,
    CommandDecision,
    DuelEngine,
    ReadyCommand,
    TimelineCommand,
    ruleset,
)
from phantom_host.duel_models import (
    AckMessage,
    CastMessage,
    ErrorMessage,
    ForwardedSignalMessage,
    HeartbeatMessage,
    Phase,
    PlayerSnapshot,
    PongMessage,
    ReadyMessage,
    SessionResponse,
    SignalMessage,
    Slot,
    Snapshot,
    SnapshotMessage,
    Source,
    Spell,
    WelcomeMessage,
    wire_dict,
)

RELIABLE_QUEUE_LIMIT = 32
ATTEMPT_CACHE_LIMIT = 128
SESSION_LEASE_MS = 5_000


class RoomError(Exception):
    def __init__(self, code: str, *, status_code: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class OutboundMailbox:
    """Bound reliable messages and coalesce snapshots for one socket writer."""

    def __init__(self, *, reliable_limit: int = RELIABLE_QUEUE_LIMIT) -> None:
        self._reliable: deque[dict[str, Any]] = deque()
        self._reliable_limit = reliable_limit
        self._snapshot: dict[str, Any] | None = None
        self._ready = asyncio.Event()
        self._closed = False

    @property
    def reliable_size(self) -> int:
        return len(self._reliable)

    def offer_reliable(self, message: dict[str, Any]) -> bool:
        if self._closed or len(self._reliable) >= self._reliable_limit:
            return False
        self._reliable.append(message)
        self._ready.set()
        return True

    def offer_snapshot(self, message: dict[str, Any]) -> bool:
        if self._closed:
            return False
        self._snapshot = message
        self._ready.set()
        return True

    async def next_message(self) -> dict[str, Any] | None:
        while True:
            if self._reliable:
                return self._reliable.popleft()
            if self._snapshot is not None:
                message = self._snapshot
                self._snapshot = None
                return message
            if self._closed:
                return None
            self._ready.clear()
            if self._reliable or self._snapshot is not None or self._closed:
                continue
            await self._ready.wait()

    def close(self) -> None:
        self._closed = True
        self._snapshot = None
        self._ready.set()


@dataclass(eq=False)
class GamePeer:
    mailbox: OutboundMailbox = field(default_factory=OutboundMailbox)
    token: str | None = None
    connection_generation: int = 0


@dataclass
class PlayerSession:
    token: str
    slot: Slot
    name: str
    source: Source
    lease_started_at_ms: int | None
    connected: bool = False
    connection_generation: int = 0
    last_heartbeat_ms: int = 0
    input_healthy: bool = False
    input_generation: int | None = None
    device_id: str | None = None
    boot_id: int | None = None
    peer: GamePeer | None = None
    pending_attempts: set[tuple[int, str]] = field(default_factory=set)
    attempt_results: OrderedDict[tuple[int, str], dict[str, Any]] = field(
        default_factory=OrderedDict
    )


@dataclass(frozen=True)
class QueuedCommand:
    token: str | None
    request_id: str | None
    command: TimelineCommand


class DuelRoom:
    def __init__(
        self,
        *,
        clock_ms: Callable[[], int],
        allow_phone: bool = False,
        allow_replay: bool = False,
        expelliarmus_enabled: bool = False,
        room_id: str = "main",
    ) -> None:
        self.clock_ms = clock_ms
        self.allow_phone = allow_phone
        self.allow_replay = allow_replay
        self.room_id = room_id
        self.engine = DuelEngine(expelliarmus_enabled=expelliarmus_enabled)
        self._rules = ruleset(expelliarmus_enabled=expelliarmus_enabled)
        self._sessions: dict[str, PlayerSession] = {}
        self._slots: dict[Slot, PlayerSession] = {}
        self._lock = asyncio.Lock()
        self._queued: list[QueuedCommand] = []
        self._next_command_id = 0
        self._next_order = 0
        self.room_generation = 1
        self.engine.reset_lobby(
            now_ms=self.clock_ms(),
            room_generation=self.room_generation,
            occupied_slots=set(),
        )

    @property
    def rules(self):
        return self._rules

    def session_for_token(self, token: str) -> PlayerSession | None:
        return self._sessions.get(token)

    def has_sessions(self) -> bool:
        return bool(self._sessions)

    async def create_session(self, *, name: str, source: Source) -> SessionResponse:
        if source is Source.PHONE and not self.allow_phone:
            raise RoomError("phone_source_disabled", status_code=403)
        if source is Source.REPLAY and not self.allow_replay:
            raise RoomError("virtual_source_disabled", status_code=403)
        async with self._lock:
            available = next(
                (slot for slot in (Slot.P1, Slot.P2) if slot not in self._slots),
                None,
            )
            if available is None:
                raise RoomError("room_full", status_code=409)
            now_ms = self.clock_ms()
            token = secrets.token_urlsafe(32)
            session = PlayerSession(
                token=token,
                slot=available,
                name=name,
                source=source,
                lease_started_at_ms=now_ms,
            )
            self._sessions[token] = session
            self._slots[available] = session
            self.room_generation += 1
            self._clear_queued_commands_locked()
            self.engine.reset_lobby(
                now_ms=now_ms,
                room_generation=self.room_generation,
                occupied_slots=set(self._slots),
            )
            self.engine.record_membership(
                now_ms=now_ms, slot=available, joined=True
            )
            snapshot = self._snapshot_locked(now_ms)
            peers = self._peers_locked()
        self._broadcast_snapshot(peers, snapshot)
        return SessionResponse(token=token, slot=available, room_id=self.room_id)

    async def attach(self, *, token: str, peer: GamePeer, now_ms: int) -> WelcomeMessage:
        async with self._lock:
            session = self._sessions.get(token)
            if session is None:
                raise RoomError("invalid_token", status_code=401)
            if session.peer is not None:
                raise RoomError("already_connected", status_code=409)
            session.connection_generation += 1
            session.connected = True
            session.lease_started_at_ms = None
            session.last_heartbeat_ms = now_ms
            session.input_healthy = False
            session.peer = peer
            peer.token = token
            peer.connection_generation = session.connection_generation
            player = self.engine.players.get(session.slot)
            if player is not None:
                player.ready = False
            if self.engine.phase in (Phase.COUNTDOWN, Phase.PLAYING):
                self._queue_abort_locked(now_ms, "game_reconnected")
            snapshot = self._snapshot_locked(now_ms)
            welcome = WelcomeMessage(
                slot=session.slot,
                room_id=self.room_id,
                connection_generation=session.connection_generation,
                rules=self._rules,
                snapshot=snapshot,
            )
        return welcome

    async def detach(
        self, *, peer: GamePeer, now_ms: int, reason: str = "game_disconnected"
    ) -> None:
        async with self._lock:
            session = self._session_for_peer_locked(peer)
            if session is None:
                peer.mailbox.close()
                return
            session.peer = None
            session.connected = False
            session.lease_started_at_ms = now_ms
            session.input_healthy = False
            peer.mailbox.close()
            if self.engine.phase in (Phase.COUNTDOWN, Phase.PLAYING):
                self._queue_abort_locked(now_ms, reason)
            self._queue_ready_reset_locked(session.slot, now_ms)

    async def heartbeat(
        self, *, peer: GamePeer, message: HeartbeatMessage, receipt_ms: int
    ) -> PongMessage | ErrorMessage:
        async with self._lock:
            session = self._session_for_peer_locked(peer)
            if session is None:
                return ErrorMessage(code="not_authenticated")
            generation_error = self._apply_generation_locked(
                session,
                incoming=message.input_generation,
                healthy=message.healthy,
                at_ms=receipt_ms,
            )
            if generation_error is not None:
                return ErrorMessage(code=generation_error)
            session.last_heartbeat_ms = receipt_ms
            return PongMessage(client_ms=message.client_ms, server_ms=receipt_ms)

    async def submit_ready(
        self, *, peer: GamePeer, message: ReadyMessage, receipt_ms: int
    ) -> AckMessage | None:
        async with self._lock:
            session = self._session_for_peer_locked(peer)
            if session is None:
                return self._ack_error_locked("ready", "not_authenticated")
            generation_error = self._apply_generation_locked(
                session,
                incoming=message.input_generation,
                healthy=message.healthy,
                at_ms=receipt_ms,
            )
            if generation_error is not None:
                return self._ack_error_locked("ready", generation_error)
            if message.ready and not message.healthy:
                return self._ack_error_locked("ready", "input_unhealthy")
            if message.ready:
                for other in self._slots.values():
                    if other is not session and other.device_id == message.device_id:
                        return self._ack_error_locked("ready", "device_in_use")
                session.device_id = message.device_id
                session.boot_id = message.boot_id
            command_id, order = self._next_ids_locked()
            self._queued.append(
                QueuedCommand(
                    token=session.token,
                    request_id=None,
                    command=ReadyCommand(
                        command_id=command_id,
                        slot=session.slot,
                        at_ms=receipt_ms,
                        order=order,
                        ready=message.ready,
                    ),
                )
            )
            return None

    async def submit_cast(
        self, *, peer: GamePeer, message: CastMessage, receipt_ms: int
    ) -> AckMessage | None:
        async with self._lock:
            session = self._session_for_peer_locked(peer)
            if session is None:
                return self._ack_error_locked(
                    "cast", "not_authenticated", request_id=message.attempt_id
                )
            attempt_key = (message.round_id, message.attempt_id)
            cached = session.attempt_results.get(attempt_key)
            if cached is not None:
                return AckMessage.model_validate(cached)
            if attempt_key in session.pending_attempts:
                return None
            if not session.input_healthy:
                return self._ack_error_locked(
                    "cast", "input_unhealthy", request_id=message.attempt_id
                )
            if message.input_generation != session.input_generation:
                return self._ack_error_locked(
                    "cast", "stale_generation", request_id=message.attempt_id
                )
            command_id, order = self._next_ids_locked()
            session.pending_attempts.add(attempt_key)
            self._queued.append(
                QueuedCommand(
                    token=session.token,
                    request_id=message.attempt_id,
                    command=CastCommand(
                        command_id=command_id,
                        slot=session.slot,
                        at_ms=receipt_ms,
                        order=order,
                        round_id=message.round_id,
                        attempt_id=message.attempt_id,
                        spell=message.spell,
                        gesture_id=message.gesture_id,
                        speech_id=message.speech_id,
                    ),
                )
            )
            return None

    async def forward_signal(
        self, *, peer: GamePeer, message: SignalMessage
    ) -> AckMessage:
        slow_peer: GamePeer | None = None
        async with self._lock:
            session = self._session_for_peer_locked(peer)
            if session is None:
                return self._ack_error_locked(
                    "signal", "not_authenticated", request_id=message.signal_id
                )
            opponent_slot = Slot.P2 if session.slot is Slot.P1 else Slot.P1
            opponent = self._slots.get(opponent_slot)
            if opponent is None or opponent.peer is None:
                return self._ack_error_locked(
                    "signal", "opponent_offline", request_id=message.signal_id
                )
            forwarded = wire_dict(
                ForwardedSignalMessage(
                    **{
                        "from": session.slot,
                        "generation": message.generation,
                        "signal_id": message.signal_id,
                        "payload": message.payload,
                    }
                )
            )
            if not opponent.peer.mailbox.offer_reliable(forwarded):
                slow_peer = opponent.peer
                ack = self._ack_error_locked(
                    "signal", "opponent_slow", request_id=message.signal_id
                )
            else:
                ack = AckMessage(
                    command="signal",
                    request_id=message.signal_id,
                    accepted=True,
                    state_version=self.engine.state_version,
                )
        if slow_peer is not None:
            await self.detach(
                peer=slow_peer, now_ms=self.clock_ms(), reason="slow_writer"
            )
        return ack

    async def leave(self, *, peer: GamePeer, now_ms: int) -> None:
        async with self._lock:
            session = self._session_for_peer_locked(peer)
            if session is None:
                peer.mailbox.close()
                return
            session.peer = None
            session.connected = False
            peer.mailbox.close()
            self._remove_sessions_locked([session], now_ms=now_ms, reason="leave")
            snapshot = self._snapshot_locked(now_ms)
            peers = self._peers_locked()
        self._broadcast_snapshot(peers, snapshot)

    async def release_session(self, *, token: str, now_ms: int) -> None:
        """Release an unattached/disconnected reservation authenticated by token."""

        async with self._lock:
            session = self._sessions.get(token)
            if session is None:
                raise RoomError("invalid_token", status_code=401)
            if session.connected or session.peer is not None:
                raise RoomError("session_active", status_code=409)
            self._remove_sessions_locked(
                [session], now_ms=now_ms, reason="session_released"
            )
            snapshot = self._snapshot_locked(now_ms)
            peers = self._peers_locked()
        self._broadcast_snapshot(peers, snapshot)

    async def tick(self, now_ms: int | None = None) -> list[GamePeer]:
        now_ms = self.clock_ms() if now_ms is None else now_ms
        peers_to_close: list[GamePeer] = []
        async with self._lock:
            for session in self._slots.values():
                if (
                    session.connected
                    and now_ms - session.last_heartbeat_ms >= HEARTBEAT_TIMEOUT_MS
                ):
                    if session.peer is not None:
                        peers_to_close.append(session.peer)
                        session.peer.mailbox.close()
                    session.peer = None
                    session.connected = False
                    session.input_healthy = False
                    deadline = session.last_heartbeat_ms + HEARTBEAT_TIMEOUT_MS
                    session.lease_started_at_ms = deadline
                    self._queue_abort_locked(deadline, "heartbeat_timeout")
                    self._queue_ready_reset_locked(session.slot, deadline)

            ready: list[QueuedCommand] = []
            pending: list[QueuedCommand] = []
            for queued in self._queued:
                if queued.command.at_ms <= now_ms:
                    ready.append(queued)
                else:
                    pending.append(queued)
            self._queued = pending
            decisions = self.engine.advance(
                now_ms=now_ms, commands=[queued.command for queued in ready]
            )
            queued_by_id = {
                queued.command.command_id: queued
                for queued in ready
                if not isinstance(queued.command, AbortCommand)
            }
            decision_by_id = {decision.command_id: decision for decision in decisions}
            for command_id, queued in queued_by_id.items():
                decision = decision_by_id.get(command_id)
                if decision is None or queued.token is None:
                    continue
                session = self._sessions.get(queued.token)
                if session is None:
                    continue
                ack = self._decision_ack(decision, queued.request_id)
                if decision.command == "cast" and queued.request_id is not None:
                    key = (self.engine.round_id, queued.request_id)
                    cast_command = queued.command
                    if isinstance(cast_command, CastCommand):
                        key = (cast_command.round_id, queued.request_id)
                    session.pending_attempts.discard(key)
                    session.attempt_results[key] = wire_dict(ack)
                    while len(session.attempt_results) > ATTEMPT_CACHE_LIMIT:
                        session.attempt_results.popitem(last=False)
                if session.peer is not None and not session.peer.mailbox.offer_reliable(
                    wire_dict(ack)
                ):
                    peers_to_close.append(session.peer)

            expired = [
                session
                for session in self._slots.values()
                if not session.connected
                and session.lease_started_at_ms is not None
                and now_ms - session.lease_started_at_ms >= SESSION_LEASE_MS
            ]
            if expired:
                self._remove_sessions_locked(
                    expired,
                    now_ms=now_ms,
                    reason="session_lease_expired",
                )

            snapshot = self._snapshot_locked(now_ms)
            peers = self._peers_locked()
        self._broadcast_snapshot(peers, snapshot)

        unique: list[GamePeer] = []
        seen: set[int] = set()
        for peer in peers_to_close:
            if id(peer) not in seen:
                seen.add(id(peer))
                unique.append(peer)
        return unique

    async def current_snapshot(self, now_ms: int | None = None) -> Snapshot:
        async with self._lock:
            return self._snapshot_locked(
                self.clock_ms() if now_ms is None else now_ms
            )

    def _apply_generation_locked(
        self,
        session: PlayerSession,
        *,
        incoming: int,
        healthy: bool,
        at_ms: int,
    ) -> str | None:
        previous = session.input_generation
        if previous is not None and incoming < previous:
            return "stale_generation"
        changed = previous is not None and incoming > previous
        session.input_generation = incoming
        session.input_healthy = healthy
        if changed:
            self._queue_ready_reset_locked(session.slot, at_ms)
            if self.engine.phase in (Phase.COUNTDOWN, Phase.PLAYING):
                self._queue_abort_locked(at_ms, "input_generation_changed")
        if not healthy:
            self._queue_ready_reset_locked(session.slot, at_ms)
            if self.engine.phase in (Phase.COUNTDOWN, Phase.PLAYING):
                self._queue_abort_locked(at_ms, "input_unhealthy")
        return None

    def _queue_abort_locked(self, at_ms: int, reason: str) -> None:
        _, order = self._next_ids_locked()
        self._queued.append(
            QueuedCommand(
                token=None,
                request_id=None,
                command=AbortCommand(at_ms=at_ms, order=order, reason=reason),
            )
        )

    def _queue_ready_reset_locked(self, slot: Slot, at_ms: int) -> None:
        player = self.engine.players.get(slot)
        if player is None or not player.ready:
            return
        command_id, order = self._next_ids_locked()
        self._queued.append(
            QueuedCommand(
                token=None,
                request_id=None,
                command=ReadyCommand(
                    command_id=command_id,
                    slot=slot,
                    at_ms=at_ms,
                    order=order,
                    ready=False,
                ),
            )
        )

    def _next_ids_locked(self) -> tuple[int, int]:
        self._next_command_id += 1
        self._next_order += 1
        return self._next_command_id, self._next_order

    def _clear_queued_commands_locked(self) -> None:
        self._queued.clear()
        for session in self._slots.values():
            session.pending_attempts.clear()

    def _remove_sessions_locked(
        self,
        sessions: list[PlayerSession],
        *,
        now_ms: int,
        reason: str,
    ) -> None:
        removed: list[PlayerSession] = []
        for session in sessions:
            if self._sessions.get(session.token) is not session:
                continue
            if self._slots.get(session.slot) is not session:
                continue
            del self._sessions[session.token]
            del self._slots[session.slot]
            removed.append(session)
        if not removed:
            return
        self.room_generation += 1
        self._clear_queued_commands_locked()
        self.engine.reset_lobby(
            now_ms=now_ms,
            room_generation=self.room_generation,
            occupied_slots=set(self._slots),
        )
        for session in removed:
            self.engine.record_membership(
                now_ms=now_ms,
                slot=session.slot,
                joined=False,
                reason=reason,
            )

    def _ack_error_locked(
        self,
        command: str,
        reason: str,
        *,
        request_id: str | None = None,
    ) -> AckMessage:
        return AckMessage(
            command=command,  # type: ignore[arg-type]
            request_id=request_id,
            accepted=False,
            reason=reason,
            state_version=self.engine.state_version,
        )

    def _decision_ack(
        self, decision: CommandDecision, request_id: str | None
    ) -> AckMessage:
        return AckMessage(
            command=decision.command,
            request_id=request_id,
            accepted=decision.accepted,
            reason=decision.reason,
            state_version=self.engine.state_version,
            action_id=decision.action_id,
            projectile_id=decision.projectile_id,
        )

    def _session_for_peer_locked(self, peer: GamePeer) -> PlayerSession | None:
        if peer.token is None:
            return None
        session = self._sessions.get(peer.token)
        if session is None or session.peer is not peer:
            return None
        if session.connection_generation != peer.connection_generation:
            return None
        return session

    def _peers_locked(self) -> list[GamePeer]:
        return [
            session.peer
            for session in self._slots.values()
            if session.peer is not None
        ]

    def _snapshot_locked(self, now_ms: int) -> Snapshot:
        players: dict[str, PlayerSnapshot | None] = {}
        for slot in (Slot.P1, Slot.P2):
            session = self._slots.get(slot)
            combat = self.engine.players.get(slot)
            if session is None or combat is None:
                players[slot.value] = None
                continue
            players[slot.value] = PlayerSnapshot(
                slot=slot,
                name=session.name,
                source=session.source,
                connected=session.connected,
                ready=combat.ready,
                input_healthy=session.input_healthy,
                input_generation=session.input_generation,
                device_id=session.device_id,
                boot_id=session.boot_id,
                hp=combat.hp,
                shield_until_ms=combat.shield_until_ms,
                offense_locked_until_ms=combat.offense_locked_until_ms,
                offensive_recovery_until_ms=combat.offensive_recovery_until_ms,
                cooldown_until_ms={
                    spell.value: combat.cooldown_until_ms.get(spell, 0)
                    for spell in Spell
                },
            )
        return Snapshot(
            room_id=self.room_id,
            room_generation=self.room_generation,
            round_id=self.engine.round_id,
            state_version=self.engine.state_version,
            server_now_ms=now_ms,
            phase=self.engine.phase,
            countdown_ends_at_ms=self.engine.countdown_ends_at_ms,
            round_ends_at_ms=self.engine.round_ends_at_ms,
            result=self.engine.result,
            players=players,
            projectiles=tuple(
                projectile.snapshot()
                for projectile in sorted(
                    self.engine.projectiles,
                    key=lambda item: (item.impact_at_ms, item.id),
                )
            ),
            recent_events=tuple(self.engine.recent_events),
        )

    @staticmethod
    def _broadcast_snapshot(peers: list[GamePeer], snapshot: Snapshot) -> None:
        message = wire_dict(SnapshotMessage(snapshot=snapshot))
        for peer in peers:
            peer.mailbox.offer_snapshot(message)

    def welcome_dict(self, welcome: WelcomeMessage) -> dict[str, Any]:
        return wire_dict(welcome)
