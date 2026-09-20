"""Development-only opaque phone-wand relay.

The relay transports typed endpoint operations and exact 20-byte values. It
never decodes motion, recognizes gestures, changes timestamps, or enters the
referee command queue.
"""

from __future__ import annotations

import asyncio
import secrets
import string
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from phantom_host.duel_models import (
    RelayError,
    RelayNotify,
    RelayOperation,
    RelayPaired,
    RelayReply,
    RelayWaiting,
    Source,
    wire_dict,
)
from phantom_host.duel_room import OutboundMailbox, PlayerSession, RoomError

PAIR_TTL_MS = 60_000
MAX_PENDING_OPERATIONS = 32
MAX_PAIR_GRANTS = 128
PAIR_CODE_LENGTH = 10
PAIR_ALPHABET = string.ascii_uppercase + string.digits


@dataclass(eq=False)
class RelayPeer:
    role: Literal["owner", "phone"]
    mailbox: OutboundMailbox = field(default_factory=OutboundMailbox)
    grant_id: str | None = None


@dataclass
class PairGrant:
    id: str
    token: str
    code: str
    expires_at_ms: int
    generation: int
    standalone: bool = False
    owner: RelayPeer | None = None
    phone: RelayPeer | None = None
    pair_id: str | None = None
    pending_ids: set[str] = field(default_factory=set)


class DevWandRelay:
    def __init__(
        self,
        *,
        clock_ms: Callable[[], int],
        session_lookup: Callable[[str], PlayerSession | None],
    ) -> None:
        self.clock_ms = clock_ms
        self.session_lookup = session_lookup
        self._lock = asyncio.Lock()
        self._grants_by_id: dict[str, PairGrant] = {}
        self._grant_by_token: dict[str, PairGrant] = {}
        self._grant_by_code: dict[str, PairGrant] = {}
        self._generation = 0

    async def create_standalone_grant(self) -> tuple[str, str, int]:
        token = secrets.token_urlsafe(32)
        code, expires = await self.create_grant(token, standalone=True)
        return token, code, expires

    async def create_grant(self, token: str, *, standalone: bool = False) -> tuple[str, int]:
        async with self._lock:
            if not standalone:
                session = self.session_lookup(token)
                if session is None:
                    raise RoomError("invalid_token", status_code=401)
                if session.source is not Source.PHONE:
                    raise RoomError("phone_source_required", status_code=409)
            existing = self._grant_by_token.get(token)
            if existing is not None:
                self._invalidate_locked(existing, "pair_replaced")
            now_ms = self.clock_ms()
            self._purge_expired_locked(now_ms)
            if len(self._grants_by_id) >= MAX_PAIR_GRANTS:
                raise RoomError("too_many_pairs", status_code=429)
            code = self._new_code_locked()
            self._generation += 1
            grant = PairGrant(
                id=secrets.token_urlsafe(12),
                token=token,
                code=code,
                expires_at_ms=now_ms + PAIR_TTL_MS,
                generation=self._generation,
                standalone=standalone,
            )
            self._grants_by_id[grant.id] = grant
            self._grant_by_token[token] = grant
            self._grant_by_code[code] = grant
            return code, grant.expires_at_ms

    async def authenticate_owner(self, token: str, peer: RelayPeer) -> None:
        async with self._lock:
            now_ms = self.clock_ms()
            self._purge_expired_locked(now_ms)
            grant = self._grant_by_token.get(token)
            if grant is None or not grant.standalone:
                session = self.session_lookup(token)
                if session is None:
                    raise RoomError("invalid_token", status_code=401)
                if session.source is not Source.PHONE:
                    raise RoomError("phone_source_required", status_code=409)
            if grant is None or grant.expires_at_ms <= now_ms:
                raise RoomError("pair_code_required", status_code=409)
            if grant.owner is not None:
                raise RoomError("owner_already_connected", status_code=409)
            grant.owner = peer
            peer.grant_id = grant.id
            if not peer.mailbox.offer_reliable(wire_dict(RelayWaiting())):
                self._invalidate_locked(grant, "slow_writer")
                raise RoomError("slow_writer", status_code=409)

    async def authenticate_phone(self, code: str, peer: RelayPeer) -> None:
        async with self._lock:
            now_ms = self.clock_ms()
            self._purge_expired_locked(now_ms)
            grant = self._grant_by_code.get(code)
            if grant is None or grant.expires_at_ms <= now_ms:
                raise RoomError("invalid_pair_code", status_code=401)
            if grant.owner is None:
                raise RoomError("owner_offline", status_code=409)
            if grant.phone is not None:
                raise RoomError("phone_already_connected", status_code=409)
            session = self.session_lookup(grant.token)
            if not grant.standalone and (session is None or session.source is not Source.PHONE):
                self._invalidate_locked(grant, "session_expired")
                raise RoomError("invalid_pair_code", status_code=401)
            grant.phone = peer
            peer.grant_id = grant.id
            grant.pair_id = secrets.token_urlsafe(12)
            self._grant_by_code.pop(code, None)
            paired = wire_dict(
                RelayPaired(
                    pair_id=grant.pair_id,
                    generation=grant.generation,
                )
            )
            if not grant.owner.mailbox.offer_reliable(paired):
                self._invalidate_locked(grant, "slow_writer")
                raise RoomError("owner_slow", status_code=409)
            if not peer.mailbox.offer_reliable(paired):
                self._invalidate_locked(grant, "slow_writer")
                raise RoomError("phone_slow", status_code=409)

    async def route_owner(self, peer: RelayPeer, message: RelayOperation) -> None:
        async with self._lock:
            grant = self._grant_for_peer_locked(peer, "owner")
            if grant.phone is None or grant.pair_id is None:
                self._offer_error_locked(peer, "not_paired")
                return
            if message.id in grant.pending_ids:
                self._offer_error_locked(peer, "duplicate_operation_id")
                return
            if len(grant.pending_ids) >= MAX_PENDING_OPERATIONS:
                self._invalidate_locked(grant, "operation_backlog")
                return
            if not grant.phone.mailbox.offer_reliable(wire_dict(message)):
                self._invalidate_locked(grant, "slow_writer")
                return
            grant.pending_ids.add(message.id)

    async def route_phone(
        self, peer: RelayPeer, message: RelayReply | RelayNotify
    ) -> None:
        async with self._lock:
            grant = self._grant_for_peer_locked(peer, "phone")
            if grant.owner is None or grant.pair_id is None:
                self._offer_error_locked(peer, "not_paired")
                return
            if isinstance(message, RelayReply):
                if message.id not in grant.pending_ids:
                    self._offer_error_locked(peer, "unknown_operation_id")
                    return
                grant.pending_ids.remove(message.id)
            if not grant.owner.mailbox.offer_reliable(wire_dict(message)):
                self._invalidate_locked(grant, "slow_writer")

    async def disconnect(self, peer: RelayPeer, reason: str = "pair_disconnected") -> None:
        async with self._lock:
            if peer.grant_id is None:
                peer.mailbox.close()
                return
            grant = self._grants_by_id.get(peer.grant_id)
            if grant is None:
                peer.mailbox.close()
                return
            self._invalidate_locked(grant, reason)

    def _grant_for_peer_locked(
        self, peer: RelayPeer, role: Literal["owner", "phone"]
    ) -> PairGrant:
        if peer.grant_id is None:
            raise RoomError("not_paired", status_code=401)
        grant = self._grants_by_id.get(peer.grant_id)
        if grant is None or getattr(grant, role) is not peer:
            raise RoomError("stale_pair", status_code=401)
        return grant

    def _purge_expired_locked(self, now_ms: int) -> None:
        expired = [
            grant
            for grant in self._grants_by_id.values()
            if grant.expires_at_ms <= now_ms and grant.pair_id is None
        ]
        for grant in expired:
            self._invalidate_locked(grant, "pair_expired")

    def _invalidate_locked(self, grant: PairGrant, reason: str) -> None:
        error = wire_dict(RelayError(code=reason))
        for peer in (grant.owner, grant.phone):
            if peer is not None:
                peer.mailbox.offer_reliable(error)
                peer.mailbox.close()
                peer.grant_id = None
        self._grants_by_id.pop(grant.id, None)
        if self._grant_by_token.get(grant.token) is grant:
            self._grant_by_token.pop(grant.token, None)
        if self._grant_by_code.get(grant.code) is grant:
            self._grant_by_code.pop(grant.code, None)
        grant.pending_ids.clear()

    @staticmethod
    def _offer_error_locked(peer: RelayPeer, code: str) -> None:
        if not peer.mailbox.offer_reliable(wire_dict(RelayError(code=code))):
            peer.mailbox.close()

    def _new_code_locked(self) -> str:
        while True:
            code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(PAIR_CODE_LENGTH))
            if code not in self._grant_by_code:
                return code
