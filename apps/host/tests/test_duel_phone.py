import json

import pytest

from phantom_host.duel_phone import (
    PAIR_COOLDOWN_MS,
    PhoneBroker,
    PhoneSettings,
    parse_hosted_pair,
    phone_service_origin,
)
from phantom_host.duel_room import RoomError

SERVICE = "https://phone.example"
ROOM = "a" * 32
PAIR = {
    "roomId": ROOM,
    "ownerToken": "b" * 64,
    "expiresAtMs": 1_000_000 + 120_000,
    "socketUrl": f"wss://phone.example/ws/{ROOM}",
    "phoneUrl": f"https://phone.example/phone?room={ROOM}",
}


def test_settings_come_from_the_environment_together_or_not_at_all(monkeypatch):
    monkeypatch.delenv("WAND_PHONE_SERVICE", raising=False)
    monkeypatch.delenv("WAND_PHONE_CREATE_SECRET", raising=False)
    assert PhoneSettings.from_environment() == PhoneSettings()
    assert not PhoneSettings().enabled
    monkeypatch.setenv("WAND_PHONE_SERVICE", "https://phone.example/")
    with pytest.raises(ValueError):
        PhoneSettings.from_environment()
    monkeypatch.setenv("WAND_PHONE_CREATE_SECRET", "s3cret")
    settings = PhoneSettings.from_environment()
    assert settings == PhoneSettings(service="https://phone.example", create_secret="s3cret")
    assert settings.enabled
    for bad in ("http://phone.example", "https://user:pw@phone.example", "https://phone.example:8443", "https://phone.example/api", "https://phone.example/?x=1"):
        with pytest.raises(ValueError):
            phone_service_origin(bad)


def test_pair_shape_is_pinned_to_the_configured_service():
    assert parse_hosted_pair(PAIR, service=SERVICE, now_ms=1_000_000) == PAIR
    for broken in (
        {**PAIR, "roomId": "zz"},
        {**PAIR, "ownerToken": "short"},
        {**PAIR, "expiresAtMs": 999_999},
        {**PAIR, "expiresAtMs": 1_000_000 + 200_000},
        {**PAIR, "expiresAtMs": True},
        {**PAIR, "socketUrl": f"wss://other.example/ws/{ROOM}"},
        {**PAIR, "socketUrl": f"ws://phone.example/ws/{ROOM}"},
        {**PAIR, "phoneUrl": f"https://phone.example/phone?room={'c' * 32}"},
        {**PAIR, "phoneUrl": f"https://phone.example/other?room={ROOM}"},
        [],
    ):
        with pytest.raises(ValueError):
            parse_hosted_pair(broken, service=SERVICE, now_ms=1_000_000)


@pytest.mark.asyncio
async def test_broker_mints_with_the_secret_only_server_side_and_rate_limits_per_session():
    calls = []
    clock = {"now": 0}
    responses = [json.dumps(PAIR).encode(), json.dumps(PAIR).encode(), None, b"not json"]

    def fetch(url, headers, body):
        calls.append((url, headers, body))
        response = responses.pop(0)
        if response is None:
            raise OSError("down")
        return response

    broker = PhoneBroker(
        PhoneSettings(service=SERVICE, create_secret="s3cret"),
        fetch=fetch,
        clock_ms=lambda: clock["now"],
        wall_ms=lambda: 1_000_000,
    )
    assert broker.enabled
    assert await broker.pair("token-a") == PAIR
    assert calls[0][0] == "https://phone.example/api/rooms"
    assert calls[0][1] == {
        "Authorization": "Bearer s3cret",
        "Content-Type": "application/json",
        "User-Agent": "wandduel-referee",
    }
    assert calls[0][2] == b"{}"
    assert "Origin" not in calls[0][1] and "origin" not in calls[0][1]

    with pytest.raises(RoomError) as busy:
        await broker.pair("token-a")
    assert busy.value.code == "pair_busy" and busy.value.status_code == 429
    assert await broker.pair("token-b") == PAIR

    clock["now"] = PAIR_COOLDOWN_MS
    with pytest.raises(RoomError) as down:
        await broker.pair("token-a")
    assert down.value.code == "pair_unavailable" and down.value.status_code == 503
    with pytest.raises(RoomError) as junk:
        await broker.pair("token-a")
    assert junk.value.code == "pair_unavailable"
    assert len(calls) == 4

    disabled = PhoneBroker(PhoneSettings(), fetch=fetch)
    assert not disabled.enabled
    with pytest.raises(RoomError) as off:
        await disabled.pair("token-a")
    assert off.value.code == "phone_broker_disabled" and off.value.status_code == 404
    assert len(calls) == 4
