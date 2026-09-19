"""Fan one authoritative envelope out to every connected browser."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class Sendable(Protocol):
    async def send_json(self, data: Any) -> None: ...


class ArenaBroadcaster:
    def __init__(self) -> None:
        self._clients: set[Sendable] = set()
        self._latest: dict[str, Any] | None = None
        self._lock = asyncio.Lock()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def latest(self) -> dict[str, Any] | None:
        return self._latest

    async def add(self, client: Sendable) -> None:
        async with self._lock:
            self._clients.add(client)
        if self._latest is not None:
            # A browser that joins mid-match should not wait for the next tick.
            await self._safe_send(client, self._latest)

    async def remove(self, client: Sendable) -> None:
        async with self._lock:
            self._clients.discard(client)

    async def publish(self, envelope: dict[str, Any]) -> None:
        self._latest = envelope
        async with self._lock:
            clients = list(self._clients)

        if not clients:
            return

        results = await asyncio.gather(
            *(self._safe_send(client, envelope) for client in clients),
            return_exceptions=True,
        )
        dead = [client for client, ok in zip(clients, results) if ok is not True]
        if dead:
            async with self._lock:
                for client in dead:
                    self._clients.discard(client)

    async def _safe_send(self, client: Sendable, envelope: dict[str, Any]) -> bool:
        try:
            await client.send_json(envelope)
            return True
        except Exception as error:
            # A closed tab must never interrupt the match.
            logger.debug("dropping arena client: %s", error)
            return False
