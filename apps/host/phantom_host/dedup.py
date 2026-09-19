"""Drop duplicate radio packets.

Each badge sends every packet three times roughly 40 ms apart, because a single
BLE broadcast is frequently missed. The host must apply the spell exactly once.

Note on sequence numbers: they are a 0-255 byte that wraps, and a badge that
reboots mid-match restarts at 0. A collision therefore requires a reboot plus a
sequence collision inside the same two-second window. That is accepted for the
MVP; a boot nonce in the packet would fix it if it is ever observed.
"""

from __future__ import annotations

from phantom_host.contracts import RadioEvent

DEFAULT_WINDOW_MS = 2000


class PacketDeduper:
    def __init__(self, window_ms: int = DEFAULT_WINDOW_MS) -> None:
        self.window_ms = window_ms
        self._seen: dict[tuple[str, int], int] = {}

    def accept(self, event: RadioEvent) -> bool:
        """True the first time we see (sender, sequence) within the window."""
        now = event.received_at_ms
        self._evict(now)

        key = (event.sender, event.sequence)
        previous = self._seen.get(key)
        if previous is not None and now - previous <= self.window_ms:
            return False

        self._seen[key] = now
        return True

    def _evict(self, now: int) -> None:
        expired = [
            key for key, seen in self._seen.items() if now - seen > self.window_ms
        ]
        for key in expired:
            del self._seen[key]

    def reset(self) -> None:
        self._seen.clear()

    def __len__(self) -> int:
        return len(self._seen)
