"""Referee-side phone pairing broker.

The hosted phone service only mints a pairing room for a caller that presents the enrollment
secret. Keeping that secret on every laptop meant a teammate's machine without it fell back to
the old private-LAN profile ("trusted HTTPS setup"). With the secret configured on the deployed
referee instead, any laptop pairs any iPhone: the browser asks the referee (authenticated by its
own game session) and the referee talks to the phone service. The secret never reaches a laptop
or the browser. The laptop's own broker, when its launcher holds the secret, still takes
precedence, so offline and LAN play keep working.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from phantom_host.duel_room import RoomError

PAIR_TIMEOUT_SECONDS = 5.0
PAIR_COOLDOWN_MS = 2_000
PAIR_MAX_LIFETIME_MS = 125_000
MAX_PAIR_BYTES = 4_096
MAX_IN_FLIGHT = 8
ROOM_ID = re.compile(r"^[0-9a-f]{32}$")
OWNER_TOKEN = re.compile(r"^[0-9a-f]{64}$")


def phone_service_origin(value: str | None) -> str | None:
    if not value:
        return None
    parts = urlsplit(value.strip())
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.port
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise ValueError(
            "WAND_PHONE_SERVICE must be one HTTPS origin without credentials, a port or a path"
        )
    return f"https://{parts.hostname}"


@dataclass(frozen=True)
class PhoneSettings:
    service: str | None = None
    create_secret: str | None = None

    @classmethod
    def from_environment(cls) -> PhoneSettings:
        service = phone_service_origin(os.getenv("WAND_PHONE_SERVICE") or None)
        secret = os.getenv("WAND_PHONE_CREATE_SECRET") or None
        if bool(service) != bool(secret):
            raise ValueError(
                "WAND_PHONE_SERVICE and WAND_PHONE_CREATE_SECRET must be set together"
            )
        return cls(service=service, create_secret=secret)

    @property
    def enabled(self) -> bool:
        return bool(self.service and self.create_secret)


def parse_hosted_pair(value: Any, *, service: str, now_ms: int) -> dict[str, Any]:
    """The exact shape the browser validates, pinned to the configured service."""

    if not isinstance(value, dict):
        raise ValueError("pair must be an object")
    room_id = value.get("roomId")
    owner_token = value.get("ownerToken")
    expires_at_ms = value.get("expiresAtMs")
    socket_url = value.get("socketUrl")
    phone_url = value.get("phoneUrl")
    if not isinstance(room_id, str) or not ROOM_ID.match(room_id):
        raise ValueError("roomId")
    if not isinstance(owner_token, str) or not OWNER_TOKEN.match(owner_token):
        raise ValueError("ownerToken")
    if (
        isinstance(expires_at_ms, bool)
        or not isinstance(expires_at_ms, int)
        or expires_at_ms <= now_ms
        or expires_at_ms > now_ms + PAIR_MAX_LIFETIME_MS
    ):
        raise ValueError("expiresAtMs")
    if not isinstance(socket_url, str) or not isinstance(phone_url, str):
        raise ValueError("urls")
    host = urlsplit(service).netloc
    socket = urlsplit(socket_url)
    phone = urlsplit(phone_url)
    if (
        socket.scheme != "wss"
        or socket.netloc != host
        or socket.path != f"/ws/{room_id}"
        or socket.query
        or socket.fragment
    ):
        raise ValueError("socketUrl")
    if (
        phone.scheme != "https"
        or phone.netloc != host
        or phone.path != "/phone"
        or phone.query != f"room={room_id}"
        or phone.fragment
    ):
        raise ValueError("phoneUrl")
    return {
        "roomId": room_id,
        "ownerToken": owner_token,
        "expiresAtMs": expires_at_ms,
        "socketUrl": socket_url,
        "phoneUrl": phone_url,
    }


Fetch = Callable[[str, dict[str, str], bytes], bytes]


def _fetch(url: str, headers: dict[str, str], body: bytes) -> bytes:
    # urllib sends no Origin header, which the phone service requires of secret-bearing callers.
    request = Request(url, data=body, headers=headers, method="POST")
    with urlopen(request, timeout=PAIR_TIMEOUT_SECONDS) as response:
        payload = response.read(MAX_PAIR_BYTES + 1)
    if len(payload) > MAX_PAIR_BYTES:
        raise ValueError("pair response exceeded the size limit")
    return payload


def _wall_ms() -> int:
    return int(time.time() * 1000)


class PhoneBroker:
    def __init__(
        self,
        settings: PhoneSettings,
        *,
        fetch: Fetch | None = None,
        clock_ms: Callable[[], int] | None = None,
        wall_ms: Callable[[], int] = _wall_ms,
    ) -> None:
        self._settings = settings
        self._fetch = fetch or _fetch
        self._clock_ms = clock_ms or (lambda: int(time.monotonic() * 1000))
        self._wall_ms = wall_ms
        self._in_flight: set[str] = set()
        self._next_pair_ms: dict[str, int] = {}

    @property
    def enabled(self) -> bool:
        return self._settings.enabled

    async def pair(self, token: str) -> dict[str, Any]:
        """Mint one pairing room for the session identified by `token`."""

        service, secret = self._settings.service, self._settings.create_secret
        if not service or not secret:
            raise RoomError("phone_broker_disabled", status_code=404)
        now = self._clock_ms()
        if (
            token in self._in_flight
            or now < self._next_pair_ms.get(token, 0)
            or len(self._in_flight) >= MAX_IN_FLIGHT
        ):
            raise RoomError("pair_busy", status_code=429)
        self._in_flight.add(token)
        try:
            # Cloudflare's browser-integrity check refuses Python's default User-Agent (error 1010).
            payload = await asyncio.to_thread(
                self._fetch,
                f"{service}/api/rooms",
                {
                    "Authorization": f"Bearer {secret}",
                    "Content-Type": "application/json",
                    "User-Agent": "wandduel-referee",
                },
                b"{}",
            )
            pair = parse_hosted_pair(json.loads(payload), service=service, now_ms=self._wall_ms())
        except Exception:
            # The reason may carry the service URL or a fragment of a secret-bearing request.
            raise RoomError("pair_unavailable", status_code=503) from None
        finally:
            self._in_flight.discard(token)
        finished = self._clock_ms()
        self._next_pair_ms = {
            key: until for key, until in self._next_pair_ms.items() if until > finished
        }
        self._next_pair_ms[token] = finished + PAIR_COOLDOWN_MS
        return pair
