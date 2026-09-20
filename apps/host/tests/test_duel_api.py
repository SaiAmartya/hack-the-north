import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from phantom_host.duel_app import DuelSettings, create_app
from phantom_host.duel_models import WelcomeMessage, wire_dict

ORIGIN = "http://localhost:5173"
ORIGIN_HEADERS = {"origin": ORIGIN}
WELCOME_FIXTURE = Path(__file__).parent / "fixtures" / "game-welcome-v1.json"


def _receive_type(websocket, expected: str, attempts: int = 20):
    for _ in range(attempts):
        message = websocket.receive_json()
        if message.get("type") == expected:
            return message
    raise AssertionError(f"did not receive {expected!r}")


def _room(client: TestClient) -> str:
    response = client.post("/api/game/room", headers=ORIGIN_HEADERS)
    assert response.status_code == 200, response.text
    return response.json()["code"]


def _session(
    client: TestClient, name: str, source: str = "ble", code: str | None = None
) -> dict:
    response = client.post(
        "/api/game/session",
        headers=ORIGIN_HEADERS,
        json={"name": name, "source": source, "code": code or _room(client)},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_http_mutations_require_exact_origin_and_virtual_modes_are_off_by_default():
    settings = DuelSettings(start_background_tick=False)
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/game/room").status_code == 403
        assert client.post(
            "/api/game/session",
            json={"name": "No origin", "source": "ble", "code": "ABCDEF"},
        ).status_code == 403
        assert client.post(
            "/api/game/session",
            headers={"origin": "http://localhost:51730"},
            json={"name": "Wrong origin", "source": "ble", "code": "ABCDEF"},
        ).status_code == 403
        code = _room(client)
        assert client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Phone", "source": "phone", "code": code},
        ).status_code == 403
        assert client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Replay", "source": "replay", "code": code},
        ).status_code == 403
        assert client.post(
            "/api/game/pair",
            headers={**ORIGIN_HEADERS, "authorization": "Bearer secret"},
        ).status_code == 404


def test_join_codes_address_independent_rooms():
    settings = DuelSettings(start_background_tick=False)
    with TestClient(create_app(settings)) as client:
        first_room = _room(client)
        second_room = _room(client)
        assert first_room != second_room
        assert len(first_room) == 6 and first_room.isupper()
        assert first_room.isalnum() and not set(first_room) & set("01IO")

        harry = _session(client, "Harry", code=first_room)
        draco = _session(client, "Draco", code=second_room)
        assert harry["slot"] == "P1" and harry["roomId"] == first_room
        assert draco["slot"] == "P1" and draco["roomId"] == second_room
        assert _session(client, "Ron", code=first_room)["slot"] == "P2"
        full = client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Hermione", "source": "ble", "code": first_room},
        )
        assert full.status_code == 409 and full.json() == {"detail": "room_full"}
        assert _session(client, "Hermione", code=second_room)["slot"] == "P2"

        unknown = client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Lost", "source": "ble", "code": "ZZZZZZ"},
        )
        assert unknown.status_code == 404
        assert unknown.json() == {"detail": "room_not_found"}
        assert client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Lost", "source": "ble", "code": "abc-12"},
        ).status_code == 422

        with client.websocket_connect("/ws/game", headers=ORIGIN_HEADERS) as one:
            one.send_json({"v": 1, "type": "auth", "token": harry["token"]})
            welcome = one.receive_json()
            assert welcome["roomId"] == first_room
            assert welcome["snapshot"]["roomId"] == first_room
            assert welcome["snapshot"]["players"]["P2"]["name"] == "Ron"


def test_session_without_code_creates_and_reserves_a_room_in_one_request():
    app = create_app(DuelSettings(start_background_tick=False))
    with TestClient(app) as client:
        response = client.post(
            "/api/game/session", headers=ORIGIN_HEADERS,
            json={"name": "Harry", "source": "ble"},
        )
        assert response.status_code == 200
        first = response.json()
        code = first["roomId"]
        assert len(code) == 6 and code.isalnum() and code.isupper()
        assert first["slot"] == "P1" and len(app.state.duel_rooms) == 1
        assert app.state.duel_rooms.room_for_code(code).has_sessions()
        second = _session(client, "Ron", code=code)
        assert second["slot"] == "P2" and second["roomId"] == code
        assert len(app.state.duel_rooms) == 1
        with client.websocket_connect("/ws/game", headers=ORIGIN_HEADERS) as game:
            game.send_json({"v": 1, "type": "auth", "token": first["token"]})
            welcome = game.receive_json()
            assert welcome["roomId"] == welcome["snapshot"]["roomId"] == code


@pytest.mark.parametrize("source", ["phone", "replay", "bot"])
@pytest.mark.parametrize("mode", ["duel", "solo", "tutorial"])
def test_failed_first_reservation_does_not_leak_rooms_or_consume_room_capacity(source, mode):
    from phantom_host.duel_registry import MAX_ROOMS

    app = create_app(DuelSettings(start_background_tick=False))
    with TestClient(app) as client:
        for _ in range(MAX_ROOMS + 1):
            rejected = client.post(
                "/api/game/session", headers=ORIGIN_HEADERS,
                json={"name": "Unavailable", "source": source, "code": None, "mode": mode},
            )
            assert rejected.status_code == 403
            assert len(app.state.duel_rooms) == 0
        accepted = client.post(
            "/api/game/session", headers=ORIGIN_HEADERS,
            json={"name": "Wizard", "source": "ble"},
        )
        assert accepted.status_code == 200 and len(app.state.duel_rooms) == 1


@pytest.mark.parametrize("game_mode", ["solo", "tutorial"])
def test_bot_session_is_atomic_private_and_identified_on_the_wire(game_mode):
    app = create_app(DuelSettings(start_background_tick=False))
    with TestClient(app) as client:
        response = client.post(
            "/api/game/session", headers=ORIGIN_HEADERS,
            json={"name": "Harry", "source": "ble", "mode": game_mode},
        )
        assert response.status_code == 200
        session = response.json()
        assert session["mode"] == game_mode and session["slot"] == "P1"
        assert len(app.state.duel_rooms) == 1
        room = app.state.duel_rooms.room_for_code(session["roomId"])
        assert room.session_for_token("") is None, "the bot must not acquire a player token"
        for mode, expected in [("duel", f"{game_mode}_room_private"), (game_mode, f"{game_mode}_requires_new_room")]:
            outsider = client.post(
                "/api/game/session", headers=ORIGIN_HEADERS,
                json={"name": "Intruder", "source": "ble", "code": session["roomId"], "mode": mode},
            )
            assert outsider.status_code in (400, 409)
            assert outsider.json() == {"detail": expected}
        with client.websocket_connect("/ws/game", headers=ORIGIN_HEADERS) as game:
            game.send_json({"v": 1, "type": "auth", "token": session["token"]})
            welcome = game.receive_json()
            assert welcome["mode"] == welcome["snapshot"]["mode"] == game_mode
            opponent = welcome["snapshot"]["players"]["P2"]
            assert opponent["name"] == ("Tutorial Wizard" if game_mode == "tutorial" else "Practice Wizard")
            assert opponent["source"] == "bot" and opponent["connected"] is True
            assert opponent["hp"] == 100 and opponent["ready"] is False
            if game_mode == "tutorial":
                assert welcome["snapshot"]["tutorial"] == {
                    "step": 0, "spell": "stupefy", "stage": "instruction", "paused": True,
                }
                game.send_json({"v": 1, "type": "tutorialContinue", "roundId": 1, "step": 0})
                ack = _receive_type(game, "ack")
                assert ack["command"] == "tutorialContinue" and ack["accepted"] is False
            else:
                assert welcome["snapshot"]["tutorial"] is None


def test_referee_brokers_wand_first_pairing_and_preserves_legacy_session_auth():
    from phantom_host.duel_phone import PhoneSettings

    room = "d" * 32
    pair = {
        "roomId": room,
        "ownerToken": "e" * 64,
        "expiresAtMs": int(time.time() * 1000) + 120_000,
        "socketUrl": f"wss://phone.example/ws/{room}",
        "phoneUrl": f"https://phone.example/phone?room={room}",
    }
    calls = []

    def fetch(url, headers, body):
        calls.append(url)
        return json.dumps(pair).encode()

    settings = DuelSettings(
        dev_relay_enabled=True,
        start_background_tick=False,
        phone=PhoneSettings(service="https://phone.example", create_secret="s3cret"),
    )
    app = create_app(settings, phone_fetch=fetch)
    with TestClient(app) as client:
        assert client.get("/api/game/health").json()["phoneBroker"] is True
        assert client.post("/api/game/phone/pair").status_code == 403
        assert client.post(
            "/api/game/phone/pair", headers={"origin": "https://attacker.invalid"}
        ).status_code == 403
        standalone = client.post("/api/game/phone/pair", headers=ORIGIN_HEADERS)
        assert standalone.status_code == 200 and standalone.json() == pair
        assert len(app.state.duel_rooms) == 0
        assert client.post(
            "/api/game/phone/pair",
            headers={**ORIGIN_HEADERS, "x-forwarded-for": "192.0.2.123"},
        ).status_code == 429
        with client.websocket_connect("/ws/game", headers=ORIGIN_HEADERS) as game:
            game.send_json({"v": 1, "type": "auth", "token": pair["ownerToken"]})
            assert game.receive_json()["code"] == "auth_failed"
            with pytest.raises(WebSocketDisconnect):
                game.receive_json()
        assert len(app.state.duel_rooms) == 0
        assert client.post(
            "/api/game/phone/pair",
            headers={**ORIGIN_HEADERS, "authorization": "Bearer nobody-knows-this-token"},
        ).status_code == 401
        badge = _session(client, "Badge")
        refused = client.post(
            "/api/game/phone/pair",
            headers={**ORIGIN_HEADERS, "authorization": f"Bearer {badge['token']}"},
        )
        assert refused.status_code == 409 and refused.json() == {"detail": "phone_source_required"}
        phone = _session(client, "Phone", source="phone")
        assert client.post(
            "/api/game/phone/pair",
            headers={"authorization": f"Bearer {phone['token']}"},
        ).status_code == 403
        minted = client.post(
            "/api/game/phone/pair",
            headers={**ORIGIN_HEADERS, "authorization": f"Bearer {phone['token']}"},
        )
        assert minted.status_code == 200, minted.text
        assert minted.json() == pair
        assert calls == ["https://phone.example/api/rooms"] * 2

    with TestClient(create_app(DuelSettings(dev_relay_enabled=True, start_background_tick=False))) as client:
        assert client.get("/api/game/health").json()["phoneBroker"] is False
        phone = _session(client, "Phone", source="phone")
        assert client.post(
            "/api/game/phone/pair",
            headers={**ORIGIN_HEADERS, "authorization": f"Bearer {phone['token']}"},
        ).status_code == 404


def test_room_creation_is_capped_per_process():
    settings = DuelSettings(start_background_tick=False)
    with TestClient(create_app(settings)) as client:
        for _ in range(32):
            _room(client)
        capped = client.post("/api/game/room", headers=ORIGIN_HEADERS)
        assert capped.status_code == 429
        assert capped.json() == {"detail": "too_many_rooms"}


def test_session_release_requires_origin_and_own_bearer_token():
    settings = DuelSettings(start_background_tick=False)
    with TestClient(create_app(settings)) as client:
        session = _session(client, "Harry")
        endpoint = "/api/game/session"
        bearer = {"authorization": f"Bearer {session['token']}"}

        assert client.delete(endpoint, headers=bearer).status_code == 403
        assert client.delete(endpoint, headers=ORIGIN_HEADERS).status_code == 401
        assert client.delete(
            endpoint,
            headers={**ORIGIN_HEADERS, "authorization": "Bearer invalid"},
        ).status_code == 401

        released = client.delete(
            endpoint,
            headers={**ORIGIN_HEADERS, **bearer},
        )
        assert released.status_code == 204
        assert released.content == b""
        assert client.delete(
            endpoint,
            headers={**ORIGIN_HEADERS, **bearer},
        ).status_code == 401

        replacement = _session(client, "Replacement", code=session["roomId"])
        assert replacement["slot"] == "P1"


def test_session_release_rejects_live_socket_but_can_free_other_reservation():
    settings = DuelSettings(start_background_tick=False)
    app = create_app(settings)
    with TestClient(app) as client:
        code = _room(client)
        active = _session(client, "Harry", code=code)
        orphaned = _session(client, "Draco", code=code)
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as websocket:
            websocket.send_json(
                {"v": 1, "type": "auth", "token": active["token"]}
            )
            assert websocket.receive_json()["type"] == "welcome"

            active_release = client.delete(
                "/api/game/session",
                headers={
                    **ORIGIN_HEADERS,
                    "authorization": f"Bearer {active['token']}",
                },
            )
            assert active_release.status_code == 409
            assert active_release.json() == {"detail": "session_active"}

            orphan_release = client.delete(
                "/api/game/session",
                headers={
                    **ORIGIN_HEADERS,
                    "authorization": f"Bearer {orphaned['token']}",
                },
            )
            assert orphan_release.status_code == 204
            stored = app.state.duel_rooms.session_for_token(active["token"])
            assert stored is not None
            assert stored.connected is True


def test_game_websocket_auth_first_welcome_and_monotonic_pong():
    with TestClient(create_app()) as client:
        session = _session(client, "Harry")
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as websocket:
            websocket.send_json(
                {"v": 1, "type": "auth", "token": session["token"]}
            )
            welcome = websocket.receive_json()
            assert welcome["type"] == "welcome"
            assert welcome["slot"] == "P1"
            assert welcome["rules"]["tickMs"] == 50
            assert welcome["snapshot"]["players"]["P2"] is None
            assert "iceServers" not in welcome
            assert "connectionGeneration" not in welcome

            websocket.send_json(
                {
                    "v": 1,
                    "type": "heartbeat",
                    "clientMs": 1234.5,
                    "inputGeneration": 1,
                    "healthy": True,
                }
            )
            pong = _receive_type(websocket, "pong")
            assert pong["clientMs"] == 1234.5
            assert isinstance(pong["serverMs"], int)


def test_game_websocket_rejects_wrong_origin_and_non_auth_first_message():
    with TestClient(create_app()) as client:
        session = _session(client, "Harry")
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ws/game", headers={"origin": "https://attacker.invalid"}
            ):
                pass

        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as websocket:
            websocket.send_json(
                {
                    "v": 1,
                    "type": "heartbeat",
                    "clientMs": 1,
                    "inputGeneration": 1,
                    "healthy": True,
                }
            )
            error = websocket.receive_json()
            assert error == {"v": 1, "type": "error", "code": "auth_failed"}
            with pytest.raises(WebSocketDisconnect):
                websocket.receive_json()

        # Failed auth never consumed or exposed the session token.
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as websocket:
            websocket.send_json(
                {"v": 1, "type": "auth", "token": session["token"]}
            )
            assert websocket.receive_json()["type"] == "welcome"


def test_game_socket_rejects_removed_camera_signaling_and_keeps_gameplay_connected():
    with TestClient(create_app()) as client:
        session = _session(client, "Harry")
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as game:
            game.send_json({"v": 1, "type": "auth", "token": session["token"]})
            assert game.receive_json()["type"] == "welcome"

            game.send_json(
                {
                    "v": 1,
                    "type": "signal",
                    "generation": 7,
                    "signalId": "offer-1",
                    "payload": {"description": {"type": "offer", "sdp": "fixture"}},
                }
            )
            assert _receive_type(game, "error") == {"v": 1, "type": "error", "code": "invalid_message"}
            game.send_json({
                "v": 1, "type": "heartbeat", "clientMs": 123,
                "inputGeneration": 1, "healthy": True,
            })
            assert _receive_type(game, "pong")["clientMs"] == 123


def test_heartbeat_timeout_closes_real_socket_at_exact_deadline():
    now = [0]
    settings = DuelSettings(start_background_tick=True)
    app = create_app(settings, clock_ms=lambda: now[0])
    with TestClient(app) as client:
        session = _session(client, "Harry")
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as websocket:
            websocket.send_json(
                {"v": 1, "type": "auth", "token": session["token"]}
            )
            assert websocket.receive_json()["type"] == "welcome"
            now[0] = 1_500
            with pytest.raises(WebSocketDisconnect):
                for _ in range(10):
                    websocket.receive_json()
        # Give the socket finalizer one scheduler turn before inspecting state.
        time.sleep(0.06)
        stored = app.state.duel_rooms.session_for_token(session["token"])
        assert stored is not None
        assert stored.connected is False


@pytest.mark.parametrize("standalone", [False, True])
def test_dev_relay_is_single_use_opaque_and_owner_disconnect_bound(standalone):
    settings = DuelSettings(
        dev_relay_enabled=True,
        allow_replay=False,
        start_background_tick=False,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        request_headers = dict(ORIGIN_HEADERS)
        if not standalone:
            session = _session(client, "Phone wand", source="phone")
            request_headers["authorization"] = f"Bearer {session['token']}"
        pair_response = client.post("/api/game/pair", headers=request_headers)
        assert pair_response.status_code == 200
        pair = pair_response.json()
        assert len(pair["code"]) >= 8
        if standalone:
            assert len(app.state.duel_rooms) == 0
            with client.websocket_connect("/ws/game", headers=ORIGIN_HEADERS) as game:
                game.send_json({"v": 1, "type": "auth", "token": pair["ownerToken"]})
                assert game.receive_json()["code"] == "auth_failed"
                with pytest.raises(WebSocketDisconnect):
                    game.receive_json()

        with client.websocket_connect(
            "/ws/dev-wand", headers=ORIGIN_HEADERS
        ) as owner:
            owner.send_json(
                {"v": 1, "type": "owner", "token": pair["ownerToken"]}
            )
            assert owner.receive_json() == {"v": 1, "type": "waiting", "role": "owner"}

            with client.websocket_connect(
                "/ws/dev-wand", headers=ORIGIN_HEADERS
            ) as phone:
                phone.send_json(
                    {"v": 1, "type": "phone", "code": pair["code"]}
                )
                owner_paired = owner.receive_json()
                phone_paired = phone.receive_json()
                assert owner_paired == phone_paired
                assert owner_paired["type"] == "paired"
                assert owner_paired["generation"] == 1

                owner.send_json(
                    {"v": 1, "type": "op", "id": "info-1", "operation": "info"}
                )
                assert phone.receive_json() == {
                    "v": 1,
                    "type": "op",
                    "id": "info-1",
                    "operation": "info",
                    "data": None,
                }
                payload = list(range(20))
                phone.send_json(
                    {"v": 1, "type": "reply", "id": "info-1", "data": payload}
                )
                assert owner.receive_json() == {
                    "v": 1,
                    "type": "reply",
                    "id": "info-1",
                    "data": payload,
                    "error": None,
                }
                phone.send_json(
                    {"v": 1, "type": "notify", "kind": "motion", "data": payload}
                )
                assert owner.receive_json() == {
                    "v": 1,
                    "type": "notify",
                    "kind": "motion",
                    "data": payload,
                }

                owner.close()
                assert phone.receive_json()["code"] == "pair_disconnected"
                with pytest.raises(WebSocketDisconnect):
                    phone.receive_json()

        # The consumed code and disconnected pair cannot be reused.
        with client.websocket_connect(
            "/ws/dev-wand", headers=ORIGIN_HEADERS
        ) as phone:
            phone.send_json(
                {"v": 1, "type": "phone", "code": pair["code"]}
            )
            assert phone.receive_json()["code"] == "auth_failed"
            with pytest.raises(WebSocketDisconnect):
                phone.receive_json()
        with client.websocket_connect("/ws/dev-wand", headers=ORIGIN_HEADERS) as owner:
            owner.send_json({"v": 1, "type": "owner", "token": pair["ownerToken"]})
            assert owner.receive_json()["code"] == "auth_failed"
        assert len(app.state.duel_rooms) == (0 if standalone else 1)


def test_unclaimed_lan_pairings_are_bounded_and_expire_without_reserving_duels():
    from phantom_host.duel_relay import MAX_PAIR_GRANTS, PAIR_TTL_MS

    clock = {"now": 100}
    settings = DuelSettings(dev_relay_enabled=True, start_background_tick=False)
    app = create_app(settings, clock_ms=lambda: clock["now"])
    with TestClient(app) as client:
        assert client.post("/api/game/pair").status_code == 403
        grants = []
        for _ in range(MAX_PAIR_GRANTS):
            response = client.post("/api/game/pair", headers=ORIGIN_HEADERS)
            assert response.status_code == 200
            grants.append(response.json())
        assert len({grant["ownerToken"] for grant in grants}) == MAX_PAIR_GRANTS
        assert len(app.state.duel_rooms) == 0
        capped = client.post("/api/game/pair", headers=ORIGIN_HEADERS)
        assert capped.status_code == 429 and capped.json()["detail"] == "too_many_pairs"
        clock["now"] += PAIR_TTL_MS
        assert client.post("/api/game/pair", headers=ORIGIN_HEADERS).status_code == 200
        for message in (
            {"v": 1, "type": "owner", "token": grants[0]["ownerToken"]},
            {"v": 1, "type": "phone", "code": grants[0]["code"]},
        ):
            with client.websocket_connect("/ws/dev-wand", headers=ORIGIN_HEADERS) as socket:
                socket.send_json(message)
                assert socket.receive_json()["code"] == "auth_failed"
        assert len(app.state.duel_rooms) == 0


def test_relay_rejects_wrong_origin_even_when_enabled():
    settings = DuelSettings(dev_relay_enabled=True, start_background_tick=False)
    with TestClient(create_app(settings)) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ws/dev-wand", headers={"origin": "https://attacker.invalid"}
            ):
                pass


def test_snapshot_contract_has_nullable_slots_and_versioned_events():
    settings = DuelSettings(start_background_tick=False)
    app = create_app(settings, clock_ms=lambda: 42)
    with TestClient(app) as client:
        session = _session(client, "Harry")
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as websocket:
            websocket.send_json(
                {"v": 1, "type": "auth", "token": session["token"]}
            )
            snapshot = websocket.receive_json()["snapshot"]
    assert snapshot["players"]["P1"]["inputGeneration"] is None
    assert snapshot["players"]["P1"]["deviceId"] is None
    assert snapshot["players"]["P1"]["bootId"] is None
    assert snapshot["players"]["P2"] is None
    assert snapshot["recentEvents"][0]["type"] == "playerJoined"
    assert snapshot["recentEvents"][0]["stateVersion"] >= 1
    assert snapshot["projectiles"] == []
    assert snapshot["result"] is None


def test_shared_welcome_fixture_is_accepted_by_the_python_contract():
    fixture = json.loads(WELCOME_FIXTURE.read_text(encoding="utf-8"))
    parsed = WelcomeMessage.model_validate_json(
        WELCOME_FIXTURE.read_text(encoding="utf-8")
    )
    assert wire_dict(parsed) == fixture
