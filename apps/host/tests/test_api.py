"""API tests. The serial port and camera are disabled; the pipeline is driven
through ArenaHost.handle_line, which is the same path real serial input takes."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from phantom_host.config import Settings
from phantom_host.main import ArenaHost, create_app


@pytest.fixture()
def settings() -> Settings:
    return Settings(
        serial_enabled=False,
        camera_enabled=False,
        director_enabled=False,
        openai_api_key=None,
    )


@pytest.fixture()
def host(settings: Settings) -> ArenaHost:
    return ArenaHost(settings)


@pytest.fixture()
def client(settings: Settings, host: ArenaHost) -> Iterator[TestClient]:
    with TestClient(create_app(settings=settings, host=host)) as test_client:
        yield test_client


def start_match(host: ArenaHost) -> None:
    host.handle_line("PA1|P1|READY|1|0")
    host.handle_line("PA1|P2|READY|1|0")
    host.advance(host.now_ms() + 4000)
    assert host.state.phase == "playing"


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


def test_health_reports_phase_and_gateway_state(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["phase"] == "lobby"
    assert body["gatewayConnected"] is False, "no badge attached in tests"
    assert "uptimeMs" in body


def test_health_still_answers_while_the_gateway_is_missing(client: TestClient) -> None:
    for _ in range(3):
        assert client.get("/health").status_code == 200


# ---------------------------------------------------------------------------
# the pipeline: line -> parse -> dedupe -> rules
# ---------------------------------------------------------------------------


def test_a_cast_line_changes_health(host: ArenaHost) -> None:
    start_match(host)
    host.handle_line("[phantom_gateway] AA:BB:CC:DD:EE:FF PA1|P1|CAST|F|17")
    assert host.state.players["P2"].health == 82


def test_a_triple_send_burst_only_applies_once(host: ArenaHost) -> None:
    start_match(host)
    for _ in range(3):
        host.handle_line("PA1|P1|CAST|F|17")
    assert host.state.players["P2"].health == 82, "three copies, one Fireball"


def test_a_late_duplicate_inside_the_window_is_still_dropped(host: ArenaHost) -> None:
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|17")
    health_after_first = host.state.players["P2"].health

    # Same (sender, sequence) arriving 1.5 s later, e.g. a delayed retry.
    host.advance(host.now_ms() + 1500)
    host.handle_line("PA1|P1|CAST|F|17")
    assert host.state.players["P2"].health == health_after_first


def test_garbage_lines_are_ignored(host: ArenaHost) -> None:
    start_match(host)
    for line in ["", "boot ok", "PA1|P1|CAST|F", "PA1|XX|CAST|F|1", "PA1|P1|CAST|F|999"]:
        host.handle_line(line)
    assert host.state.players["P2"].health == 100


def test_effects_accumulate_for_the_next_envelope(host: ArenaHost) -> None:
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|17")
    envelope = host.build_envelope()
    kinds = [effect.type for effect in envelope.effects]
    assert "cast" in kinds and "damage" in kinds


def test_effects_are_drained_so_they_are_not_replayed(host: ArenaHost) -> None:
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|17")
    assert host.build_envelope().effects
    assert host.build_envelope().effects == []


def test_a_full_duel_ends_with_one_winner(host: ArenaHost) -> None:
    start_match(host)
    sequence = 0
    for _ in range(60):
        host.advance(host.now_ms() + 1000)
        if host.state.phase != "playing":
            break
        sequence = (sequence + 1) % 256
        host.handle_line(f"PA1|P1|CAST|F|{sequence}")

    assert host.state.phase == "finished"
    assert host.state.winner == "P1"


def test_a_cast_after_the_match_finishes_is_rejected(host: ArenaHost) -> None:
    start_match(host)
    host.state.players["P2"].health = 5
    host.handle_line("PA1|P1|CAST|F|1")
    assert host.state.phase == "finished"

    host.advance(host.now_ms() + 3000)
    host.handle_line("PA1|P1|CAST|A|2")
    assert host.state.winner == "P1"
    assert host.state.players["P2"].health == 0


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------


def test_post_match_reset_returns_to_lobby(client: TestClient, host: ArenaHost) -> None:
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|1")
    assert host.state.players["P2"].health < 100

    response = client.post("/match/reset")
    assert response.status_code == 200
    assert response.json()["state"]["phase"] == "lobby"
    assert host.state.players["P2"].health == 100
    assert host.state.players["P1"].ready is False


def test_the_judge_badge_can_also_reset(host: ArenaHost) -> None:
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|1")
    host.handle_line("PA1|J|EVT|RST|9")
    assert host.state.phase == "lobby"
    assert host.state.players["P2"].health == 100


def test_reset_clears_the_deduper_so_sequences_can_repeat(host: ArenaHost) -> None:
    """A badge keeps counting sequences across a reset; the host must not treat
    the next match's first packet as a duplicate."""
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|17")
    host.handle_line("PA1|J|EVT|RST|9")

    start_match(host)
    host.handle_line("PA1|P1|CAST|F|17")
    assert host.state.players["P2"].health == 82


# ---------------------------------------------------------------------------
# websocket
# ---------------------------------------------------------------------------


def test_websocket_sends_a_camel_case_snapshot_on_connect(client: TestClient) -> None:
    with client.websocket_connect("/ws/arena") as socket:
        envelope = socket.receive_json()

    assert envelope["type"] == "state"
    assert envelope["state"]["phase"] == "lobby"
    assert "gatewayConnected" in envelope
    assert "serverNowMs" in envelope
    assert envelope["state"]["players"]["P1"]["health"] == 100
    assert envelope["markers"]["P1"]["visible"] is False


def test_websocket_reports_a_cast_that_arrived_over_serial(
    client: TestClient, host: ArenaHost
) -> None:
    with client.websocket_connect("/ws/arena") as socket:
        socket.receive_json()  # snapshot

        start_match(host)
        host.handle_line("PA1|P1|CAST|F|17")

        for _ in range(40):
            envelope = socket.receive_json()
            if envelope["state"]["players"]["P2"]["health"] == 82:
                break
        else:
            pytest.fail("cast never reached the websocket")

    assert envelope["state"]["players"]["P2"]["health"] == 82


def test_websocket_mana_is_an_integer_on_the_wire(client: TestClient) -> None:
    with client.websocket_connect("/ws/arena") as socket:
        envelope = socket.receive_json()
    assert isinstance(envelope["state"]["players"]["P1"]["mana"], int)
