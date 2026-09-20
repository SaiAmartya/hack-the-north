import json

import pytest

from phantom_host.duel_ice import (
    DEFAULT_ICE_SERVERS,
    TURN_REFRESH_SECONDS,
    IceProvider,
    IceSettings,
    parse_ice_servers,
)
from phantom_host.duel_models import IceServer, wire_dict


def test_defaults_are_stun_only_and_env_overrides_are_validated(monkeypatch):
    assert [wire_dict(server) for server in DEFAULT_ICE_SERVERS] == [
        {"urls": ["stun:stun.cloudflare.com:3478"], "username": None, "credential": None}
    ]
    parsed = parse_ice_servers(
        '[{"urls": "stun:a.example:3478"}, {"urls": ["turn:b.example"], "username": "u", "credential": "c"}]'
    )
    assert parsed[0].urls == ("stun:a.example:3478",) and parsed[0].username is None
    assert parsed[1].username == "u" and parsed[1].credential == "c"
    assert parse_ice_servers("[]") == ()
    for broken in ("not json", "{}", "[1]", '[{"urls": []}]', '[{"urls": [3]}]'):
        with pytest.raises(ValueError):
            parse_ice_servers(broken)

    monkeypatch.delenv("WAND_ICE_SERVERS", raising=False)
    monkeypatch.delenv("WAND_TURN_KEY_ID", raising=False)
    monkeypatch.delenv("WAND_TURN_API_TOKEN", raising=False)
    assert IceSettings.from_environment() == IceSettings()
    monkeypatch.setenv("WAND_ICE_SERVERS", "[]")
    assert IceSettings.from_environment().servers == ()
    monkeypatch.setenv("WAND_TURN_KEY_ID", "key")
    with pytest.raises(ValueError):
        IceSettings.from_environment()
    monkeypatch.setenv("WAND_TURN_API_TOKEN", "token")
    settings = IceSettings.from_environment()
    assert settings.turn_key_id == "key" and settings.turn_api_token == "token"


@pytest.mark.asyncio
async def test_turn_credentials_are_minted_cached_refreshed_and_never_fatal():
    calls = []
    clock = {"now": 1000.0}
    responses = [
        json.dumps(
            {
                "iceServers": [
                    {"urls": ["stun:stun.cloudflare.com:3478"]},
                    {
                        "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
                        "username": "first",
                        "credential": "secret-1",
                    },
                ]
            }
        ).encode(),
        json.dumps(
            {"iceServers": {"urls": ["turn:turn.cloudflare.com:3478"], "username": "second", "credential": "secret-2"}}
        ).encode(),
        None,
    ]

    def fetch(url, headers, body):
        calls.append((url, headers, json.loads(body)))
        response = responses.pop(0)
        if response is None:
            raise OSError("network down")
        return response

    provider = IceProvider(
        IceSettings(turn_key_id="key-id", turn_api_token="api-token"),
        fetch=fetch,
        clock=lambda: clock["now"],
    )
    first = await provider.servers()
    assert [server.username for server in first] == [None, "first"]
    assert calls[0][0].endswith("/turn/keys/key-id/credentials/generate-ice-servers")
    assert calls[0][1]["Authorization"] == "Bearer api-token"
    assert calls[0][2] == {"ttl": 7200}

    clock["now"] += TURN_REFRESH_SECONDS - 1
    assert await provider.servers() is first and len(calls) == 1

    clock["now"] += 1
    second = await provider.servers()
    assert [server.username for server in second] == ["second"] and len(calls) == 2

    clock["now"] += TURN_REFRESH_SECONDS
    assert await provider.servers() is second and len(calls) == 3

    stun_only = IceProvider(IceSettings(), fetch=fetch)
    assert await stun_only.servers() == DEFAULT_ICE_SERVERS and len(calls) == 3


def test_ice_server_wire_shape_matches_the_browser_config():
    server = IceServer(urls=("turns:turn.example:443?transport=tcp",), username="u", credential="c")
    assert wire_dict(server) == {
        "urls": ["turns:turn.example:443?transport=tcp"],
        "username": "u",
        "credential": "c",
    }
