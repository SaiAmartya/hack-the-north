"""Join-code rooms sharing one referee process.

Every duel lives in its own `DuelRoom`, addressed by a short code the first player hands to
the second. Codes use an alphabet without look-alike glyphs and a different shape from the
ten-character phone pairing code, so the two are never confused on screen.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable

from phantom_host.duel_models import Mode, SessionResponse, Source
from phantom_host.duel_room import DuelRoom, GamePeer, PlayerSession, RoomError

ROOM_CODE_LENGTH = 6
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_ROOMS = 32
ROOM_IDLE_MS = 10 * 60_000


class RoomRegistry:
    def __init__(
        self,
        *,
        clock_ms: Callable[[], int],
        allow_phone: bool = False,
        allow_replay: bool = False,
        variance: bool = True,
    ) -> None:
        self.clock_ms = clock_ms
        self.allow_phone = allow_phone
        self.allow_replay = allow_replay
        # Scripted QA can switch off critical hits, stuns and relics for exact expectations.
        self.variance = variance
        self._rooms: dict[str, DuelRoom] = {}
        self._empty_since_ms: dict[str, int] = {}

    def __len__(self) -> int:
        return len(self._rooms)

    def rooms(self) -> list[DuelRoom]:
        return list(self._rooms.values())

    def create_room(self, *, mode: Mode = Mode.DUEL, level: int | None = None) -> str:
        if len(self._rooms) >= MAX_ROOMS:
            raise RoomError("too_many_rooms", status_code=429)
        code = self._new_code()
        self._rooms[code] = DuelRoom(
            clock_ms=self.clock_ms,
            allow_phone=self.allow_phone,
            allow_replay=self.allow_replay,
            room_id=code,
            mode=mode,
            variance=self.variance,
            level=level,
        )
        self._empty_since_ms[code] = self.clock_ms()
        return code

    def room_for_code(self, code: str) -> DuelRoom | None:
        return self._rooms.get(code)

    async def create_session(
        self, *, name: str, source: Source, code: str | None = None,
        mode: Mode = Mode.DUEL, level: int | None = None,
    ) -> SessionResponse:
        if mode is not Mode.DUEL and code is not None:
            raise RoomError(f"{mode.value}_requires_new_room")
        created = code is None
        if code is None:
            code = self.create_room(mode=mode, level=level)
        elif level is not None:
            raise RoomError("story_requires_new_room")
        room = self._rooms.get(code)
        if room is None:
            raise RoomError("room_not_found", status_code=404)
        if not created and room.mode is not Mode.DUEL:
            raise RoomError(f"{room.mode.value}_room_private", status_code=409)
        try:
            return await room.create_session(name=name, source=source)
        except BaseException:
            if created:
                self._rooms.pop(code, None)
                self._empty_since_ms.pop(code, None)
            raise

    def room_for_token(self, token: str) -> DuelRoom | None:
        for room in self._rooms.values():
            if room.session_for_token(token) is not None:
                return room
        return None

    def session_for_token(self, token: str) -> PlayerSession | None:
        room = self.room_for_token(token)
        return None if room is None else room.session_for_token(token)

    async def tick_all(self, now_ms: int | None = None) -> list[GamePeer]:
        """Advance every room, then forget rooms nobody has occupied for a while."""

        now_ms = self.clock_ms() if now_ms is None else now_ms
        closed: list[GamePeer] = []
        for code, room in list(self._rooms.items()):
            closed.extend(await room.tick(now_ms))
            if room.has_sessions():
                self._empty_since_ms.pop(code, None)
                continue
            since = self._empty_since_ms.setdefault(code, now_ms)
            if now_ms - since >= ROOM_IDLE_MS:
                del self._rooms[code]
                del self._empty_since_ms[code]
        return closed

    def _new_code(self) -> str:
        while True:
            code = "".join(
                secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH)
            )
            if code not in self._rooms:
                return code
