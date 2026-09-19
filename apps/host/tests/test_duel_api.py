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


def _session(client: TestClient, name: str, source: str = "ble") -> dict:
    response = client.post(
        "/api/game/session",
        headers=ORIGIN_HEADERS,
        json={"name": name, "source": source},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_http_mutations_require_exact_origin_and_virtual_modes_are_off_by_default():
    settings = DuelSettings(start_background_tick=False)
    with TestClient(create_app(settings)) as client:
        assert client.post(
            "/api/game/session",
            json={"name": "No origin", "source": "ble"},
        ).status_code == 403
        assert client.post(
            "/api/game/session",
            headers={"origin": "http://localhost:51730"},
            json={"name": "Wrong origin", "source": "ble"},
        ).status_code == 403
        assert client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Phone", "source": "phone"},
        ).status_code == 403
        assert client.post(
            "/api/game/session",
            headers=ORIGIN_HEADERS,
            json={"name": "Replay", "source": "replay"},
        ).status_code == 403
        assert client.post(
            "/api/game/pair",
            headers={**ORIGIN_HEADERS, "authorization": "Bearer secret"},
        ).status_code == 404


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

        replacement = _session(client, "Replacement")
        assert replacement["slot"] == "P1"


def test_session_release_rejects_live_socket_but_can_free_other_reservation():
    settings = DuelSettings(start_background_tick=False)
    app = create_app(settings)
    with TestClient(app) as client:
        active = _session(client, "Harry")
        orphaned = _session(client, "Draco")
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
            stored = app.state.duel_room.session_for_token(active["token"])
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


def test_authenticated_signal_is_forwarded_only_to_the_opponent():
    with TestClient(create_app()) as client:
        first = _session(client, "Harry")
        second = _session(client, "Draco")
        with client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as one, client.websocket_connect(
            "/ws/game", headers=ORIGIN_HEADERS
        ) as two:
            one.send_json({"v": 1, "type": "auth", "token": first["token"]})
            two.send_json({"v": 1, "type": "auth", "token": second["token"]})
            assert one.receive_json()["type"] == "welcome"
            assert two.receive_json()["type"] == "welcome"

            one.send_json(
                {
                    "v": 1,
                    "type": "signal",
                    "generation": 7,
                    "signalId": "offer-1",
                    "payload": {"description": {"type": "offer", "sdp": "fixture"}},
                }
            )
            ack = _receive_type(one, "ack")
            assert ack["command"] == "signal"
            assert ack["requestId"] == "offer-1"
            assert ack["accepted"] is True
            forwarded = _receive_type(two, "signal")
            assert forwarded == {
                "v": 1,
                "type": "signal",
                "from": "P1",
                "generation": 7,
                "signalId": "offer-1",
                "payload": {
                    "description": {"type": "offer", "sdp": "fixture"}
                },
            }


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
        stored = app.state.duel_room.session_for_token(session["token"])
        assert stored is not None
        assert stored.connected is False


def test_dev_relay_is_single_use_opaque_and_disconnect_bound():
    settings = DuelSettings(
        dev_relay_enabled=True,
        allow_replay=False,
        start_background_tick=False,
    )
    with TestClient(create_app(settings)) as client:
        session = _session(client, "Phone wand", source="phone")
        pair_response = client.post(
            "/api/game/pair",
            headers={
                **ORIGIN_HEADERS,
                "authorization": f"Bearer {session['token']}",
            },
        )
        assert pair_response.status_code == 200
        pair = pair_response.json()
        assert len(pair["code"]) >= 8

        with client.websocket_connect(
            "/ws/dev-wand", headers=ORIGIN_HEADERS
        ) as owner:
            owner.send_json(
                {"v": 1, "type": "owner", "token": session["token"]}
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
