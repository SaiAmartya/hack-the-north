"""Resilience tests for the failure paths the demo actually has to survive.

Each test here maps to a line in the README's fallback list: camera dies, gateway
unplugged, marker lost, match run twice, Director unavailable.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from phantom_host.config import Settings
from phantom_host.contracts import MarkerPose
from phantom_host.main import ArenaHost, create_app, neutral_markers


def offline_settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "serial_enabled": False,
        "camera_enabled": False,
        "director_enabled": False,
        "openai_api_key": None,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def start_match(host: ArenaHost) -> None:
    host.handle_line("PA1|P1|READY|1|0")
    host.handle_line("PA1|P2|READY|1|0")
    host.advance(host.now_ms() + 4000)
    assert host.state.phase == "playing"


def run_to_finish(host: ArenaHost, start_sequence: int = 10) -> int:
    sequence = start_sequence
    for _ in range(60):
        host.advance(host.now_ms() + 1000)
        if host.state.phase != "playing":
            break
        sequence = (sequence + 1) % 256
        host.handle_line(f"PA1|P1|CAST|F|{sequence}")
    assert host.state.phase == "finished"
    return sequence


class StubGateway:
    """Just the surface ArenaHost reads."""

    def __init__(self) -> None:
        self.connected = False
        self.port = "/dev/fake"


class StubCamera:
    def __init__(self) -> None:
        self.markers = neutral_markers()
        self.frame_jpeg_base64: str | None = None
        self.available = False


# ---------------------------------------------------------------------------
# the judge flow must work twice without a restart
# ---------------------------------------------------------------------------


def test_two_matches_run_back_to_back_without_a_restart() -> None:
    """The MVP promise: the live judge flow completes without a code edit."""
    host = ArenaHost(offline_settings())

    start_match(host)
    last_sequence = run_to_finish(host)
    assert host.state.winner == "P1"

    # Judge presses UP on the chaos badge.
    last_sequence = (last_sequence + 1) % 256
    host.handle_line(f"PA1|J|EVT|RST|{last_sequence}")
    assert host.state.phase == "lobby"

    start_match(host)
    run_to_finish(host, start_sequence=last_sequence)
    assert host.state.phase == "finished"
    assert host.state.winner == "P1"
    assert host.state.players["P2"].health == 0


def test_a_second_match_starts_from_full_health_and_mana() -> None:
    host = ArenaHost(offline_settings())
    start_match(host)
    host.handle_line("PA1|P1|CAST|F|31")
    host.handle_line("PA1|J|EVT|RST|32")

    for player in host.state.players.values():
        assert player.health == 100
        assert player.mana == 100
        assert player.ready is False
        assert player.shield_until_ms == 0
        assert player.cooldown_until_ms == {}


# ---------------------------------------------------------------------------
# gateway unplugged
# ---------------------------------------------------------------------------


def test_health_still_answers_when_the_gateway_drops_mid_match() -> None:
    settings = offline_settings()
    host = ArenaHost(settings)
    host.gateway = StubGateway()  # type: ignore[assignment]
    host.gateway.connected = True  # type: ignore[union-attr]

    with TestClient(create_app(settings=settings, host=host)) as client:
        start_match(host)
        host.handle_line("PA1|P1|CAST|F|41")
        assert client.get("/health").json()["gatewayConnected"] is True

        host.gateway.connected = False  # type: ignore[union-attr]

        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["gatewayConnected"] is False
        assert body["phase"] == "playing", "the match survives a dead cable"

    assert host.state.players["P2"].health == 82, "state preserved across the drop"


def test_the_envelope_reports_the_gateway_state_to_the_client() -> None:
    settings = offline_settings()
    host = ArenaHost(settings)
    assert host.build_envelope().gateway_connected is False

    host.gateway = StubGateway()  # type: ignore[assignment]
    host.gateway.connected = True  # type: ignore[union-attr]
    assert host.build_envelope().gateway_connected is True


# ---------------------------------------------------------------------------
# camera and marker loss
# ---------------------------------------------------------------------------


def test_markers_default_to_invisible_with_no_camera_at_all() -> None:
    host = ArenaHost(offline_settings())
    envelope = host.build_envelope()

    assert set(envelope.markers) == {"P1", "P2"}
    for pose in envelope.markers.values():
        assert pose.visible is False
    assert envelope.frame_jpeg_base64 is None


def test_a_marker_lost_mid_match_falls_back_to_the_corner_hud() -> None:
    host = ArenaHost(offline_settings())
    camera = StubCamera()
    host.camera = camera  # type: ignore[assignment]

    camera.markers = {
        "P1": MarkerPose(player_id="P1", x=0.25, y=0.5, visible=True),
        "P2": MarkerPose(player_id="P2", x=0.75, y=0.5, visible=True),
    }
    camera.frame_jpeg_base64 = "fake-jpeg"
    host.sync_camera()

    envelope = host.build_envelope()
    assert envelope.markers["P1"].visible is True
    assert envelope.frame_jpeg_base64 == "fake-jpeg"

    # P1 walks out of frame.
    camera.markers = {
        "P1": MarkerPose(player_id="P1", x=0.25, y=0.5, visible=False),
        "P2": MarkerPose(player_id="P2", x=0.75, y=0.5, visible=True),
    }
    host.sync_camera()

    envelope = host.build_envelope()
    assert envelope.markers["P1"].visible is False
    assert envelope.markers["P2"].visible is True, "P2 keeps its anchor"


def test_the_match_is_unaffected_by_losing_the_camera() -> None:
    """Vision is presentation only; no rule depends on it."""
    host = ArenaHost(offline_settings())
    camera = StubCamera()
    host.camera = camera  # type: ignore[assignment]

    start_match(host)
    host.handle_line("PA1|P1|CAST|F|51")
    health_with_camera = host.state.players["P2"].health

    host.camera = None
    host.markers = neutral_markers()
    host.handle_line("PA1|P1|CAST|A|52")

    assert host.state.players["P2"].health < health_with_camera
    assert host.state.phase == "playing"


# ---------------------------------------------------------------------------
# noisy radio channel
# ---------------------------------------------------------------------------


def test_another_teams_radio_traffic_cannot_touch_the_match() -> None:
    """The Lua radio channel is shared with every other badge app at the venue."""
    host = ArenaHost(offline_settings())
    start_match(host)
    applied_before = host.packets_applied
    rejected_before = host.lines_rejected

    for line in [
        "[some_other_app] AA:BB:CC:DD:EE:99 HELLO1:hi",
        "[share_xfer] chunk 44 of 210",
        "[phantom_gateway] AA:BB:CC:DD:EE:99 PA2|P1|CAST|U|1",
        "[boot] app_reg: launched",
        "PA1|P1|CAST|F",
    ]:
        host.handle_line(line)

    assert host.state.players["P2"].health == 100
    assert host.packets_applied == applied_before, "nothing foreign was applied"
    assert host.lines_rejected == rejected_before + 5


def test_a_burst_of_duplicates_cannot_drain_health_twice() -> None:
    host = ArenaHost(offline_settings())
    start_match(host)
    applied_before = host.packets_applied
    duplicates_before = host.duplicates_dropped

    # Nine lines: three distinct packets, each sent three times.
    for sequence in (61, 62, 63):
        for _ in range(3):
            host.handle_line(f"PA1|P1|CAST|A|{sequence}")
        host.advance(host.now_ms() + 600)

    assert host.duplicates_dropped - duplicates_before == 6
    assert host.packets_applied - applied_before == 3
    assert host.state.players["P2"].health == 100 - 3 * 10


def test_the_effect_buffer_cannot_grow_without_a_listener() -> None:
    """Nobody watching must not turn into unbounded memory growth."""
    host = ArenaHost(offline_settings())
    start_match(host)

    for step in range(300):
        host.advance(host.now_ms() + 600)
        if host.state.phase != "playing":
            host.handle_line(f"PA1|J|EVT|RST|{step % 256}")
            start_match(host)
        host.handle_line(f"PA1|P1|CAST|A|{step % 256}")

    envelope = host.build_envelope()
    assert len(envelope.effects) <= 64
