"""ICE servers for the opponent video link.

Players on different networks need at least STUN to find each other and TURN when a NAT
refuses direct traffic. The referee hands both players the same list in the welcome
message: a public STUN server by default, or short-lived Cloudflare TURN credentials when a
TURN key is configured. The TURN API token never leaves this process.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.request import Request, urlopen

from phantom_host.duel_models import IceServer

DEFAULT_ICE_SERVERS: tuple[IceServer, ...] = (
    IceServer(urls=("stun:stun.cloudflare.com:3478",)),
)
TURN_ENDPOINT = (
    "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
)
TURN_TTL_SECONDS = 2 * 3600
TURN_REFRESH_SECONDS = 3600
TURN_REQUEST_TIMEOUT_SECONDS = 5.0
MAX_TURN_RESPONSE_BYTES = 64 * 1024

log = logging.getLogger(__name__)


def parse_ice_servers(raw: str) -> tuple[IceServer, ...]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("WAND_ICE_SERVERS must be a JSON array of ICE servers") from None
    if not isinstance(value, list):
        raise ValueError("WAND_ICE_SERVERS must be a JSON array of ICE servers")
    return tuple(_ice_server(item) for item in value)


def _ice_server(item: object) -> IceServer:
    if not isinstance(item, dict):
        raise ValueError("each ICE server must be an object")
    urls = item.get("urls")
    if isinstance(urls, str):
        urls = [urls]
    if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
        raise ValueError("each ICE server needs a urls list")
    username = item.get("username")
    credential = item.get("credential")
    return IceServer(
        urls=tuple(urls),
        username=username if isinstance(username, str) else None,
        credential=credential if isinstance(credential, str) else None,
    )


@dataclass(frozen=True)
class IceSettings:
    servers: tuple[IceServer, ...] = DEFAULT_ICE_SERVERS
    turn_key_id: str | None = None
    turn_api_token: str | None = None

    @classmethod
    def from_environment(cls) -> IceSettings:
        raw = os.getenv("WAND_ICE_SERVERS")
        servers = DEFAULT_ICE_SERVERS if raw is None else parse_ice_servers(raw)
        key_id = os.getenv("WAND_TURN_KEY_ID") or None
        token = os.getenv("WAND_TURN_API_TOKEN") or None
        if bool(key_id) != bool(token):
            raise ValueError(
                "WAND_TURN_KEY_ID and WAND_TURN_API_TOKEN must be set together"
            )
        return cls(servers=servers, turn_key_id=key_id, turn_api_token=token)


Fetch = Callable[[str, dict[str, str], bytes], bytes]


def _fetch(url: str, headers: dict[str, str], body: bytes) -> bytes:
    request = Request(url, data=body, headers=headers, method="POST")
    with urlopen(request, timeout=TURN_REQUEST_TIMEOUT_SECONDS) as response:
        payload = response.read(MAX_TURN_RESPONSE_BYTES + 1)
    if len(payload) > MAX_TURN_RESPONSE_BYTES:
        raise ValueError("TURN credential response exceeded the size limit")
    return payload


class IceProvider:
    """Serve the configured ICE list, minting and caching TURN credentials when enabled."""

    def __init__(
        self,
        settings: IceSettings,
        *,
        fetch: Fetch | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._fetch = fetch or _fetch
        self._clock = clock
        self._lock = asyncio.Lock()
        self._cached: tuple[IceServer, ...] | None = None
        self._cached_at = 0.0
        self._warned = False

    @property
    def turn_enabled(self) -> bool:
        return bool(self._settings.turn_key_id and self._settings.turn_api_token)

    async def servers(self) -> tuple[IceServer, ...]:
        if not self.turn_enabled:
            return self._settings.servers
        async with self._lock:
            now = self._clock()
            if self._cached is not None and now - self._cached_at < TURN_REFRESH_SECONDS:
                return self._cached
            try:
                servers = await asyncio.to_thread(self._mint)
            except Exception:
                # The message deliberately carries no detail: the failure could echo the URL.
                if not self._warned:
                    log.warning("TURN credentials unavailable; video uses STUN only")
                    self._warned = True
                return self._cached or self._settings.servers
            self._cached, self._cached_at = servers, now
            self._warned = False
            return servers

    def _mint(self) -> tuple[IceServer, ...]:
        payload = self._fetch(
            TURN_ENDPOINT.format(key_id=self._settings.turn_key_id),
            {
                "Authorization": f"Bearer {self._settings.turn_api_token}",
                "Content-Type": "application/json",
            },
            json.dumps({"ttl": TURN_TTL_SECONDS}).encode(),
        )
        value = json.loads(payload)
        servers = value.get("iceServers") if isinstance(value, dict) else None
        if isinstance(servers, dict):
            servers = [servers]
        if not isinstance(servers, list) or not servers:
            raise ValueError("TURN credential response had no iceServers")
        return tuple(_ice_server(item) for item in servers)
