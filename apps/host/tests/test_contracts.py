"""Contract tests. These are written before contracts.py exists, per the plan."""

import pytest
from pydantic import ValidationError

from phantom_host.contracts import (
    ArenaDirective,
    ArenaEnvelope,
    ArenaState,
    Effect,
    MarkerPose,
    PlayerState,
    RadioEvent,
)


def test_radio_event_accepts_a_valid_cast() -> None:
    event = RadioEvent(
        sender="P1", kind="CAST", value="F", sequence=17, received_at_ms=0
    )
    assert event.value == "F"
    assert event.mac is None


def test_radio_event_rejects_sequence_above_255() -> None:
    with pytest.raises(ValidationError):
        RadioEvent(sender="P1", kind="CAST", value="F", sequence=256, received_at_ms=0)


def test_radio_event_rejects_unknown_sender() -> None:
    with pytest.raises(ValidationError):
        RadioEvent(sender="P9", kind="CAST", value="F", sequence=1, received_at_ms=0)


def test_radio_event_carries_an_optional_mac() -> None:
    event = RadioEvent(
        sender="P2",
        kind="CAST",
        value="S",
        sequence=3,
        received_at_ms=5,
        mac="AA:BB:CC:DD:EE:FF",
    )
    assert event.mac == "AA:BB:CC:DD:EE:FF"


def test_player_state_defaults_cooldowns_so_it_is_constructible() -> None:
    """cooldown_until_ms must default; a required dict makes every call site noisy."""
    player = PlayerState(id="P1", health=100, mana=100)
    assert player.cooldown_until_ms == {}
    assert player.shield_until_ms == 0
    assert player.ready is False


def test_player_state_rejects_out_of_range_health() -> None:
    with pytest.raises(ValidationError):
        PlayerState(id="P1", health=101, mana=100)
    with pytest.raises(ValidationError):
        PlayerState(id="P1", health=-1, mana=100)


def test_arena_state_defaults_to_no_modifier_and_no_winner() -> None:
    state = ArenaState(
        phase="lobby",
        players={
            "P1": PlayerState(id="P1", health=100, mana=100),
            "P2": PlayerState(id="P2", health=100, mana=100),
        },
    )
    assert state.modifier == "none"
    assert state.winner is None
    assert state.modifier_until_ms == 0


def test_arena_state_rejects_an_unsupported_modifier() -> None:
    with pytest.raises(ValidationError):
        ArenaState(phase="playing", players={}, modifier="black_hole")


def test_effect_is_json_friendly() -> None:
    effect = Effect(type="cast", player="P1", spell="F")
    assert effect.model_dump(exclude_none=True) == {
        "type": "cast",
        "player": "P1",
        "spell": "F",
    }


def test_marker_pose_clamps_to_normalized_coordinates() -> None:
    pose = MarkerPose(player_id="P1", x=0.5, y=0.25, visible=True)
    assert pose.visible is True
    with pytest.raises(ValidationError):
        MarkerPose(player_id="P1", x=1.5, y=0.25, visible=True)


def test_envelope_serializes_camel_case_for_the_typescript_client() -> None:
    """Pins the wire contract that apps/web/src/types.ts depends on."""
    envelope = ArenaEnvelope(
        state=ArenaState(
            phase="playing",
            players={"P1": PlayerState(id="P1", health=82, mana=60, last_spell="F")},
            modifier_until_ms=1234,
            countdown_ends_ms=10,
            started_at_ms=5,
        ),
        markers={"P1": MarkerPose(player_id="P1", x=0.5, y=0.5, visible=True)},
        effects=[Effect(type="damage", player="P2", amount=18)],
        director_commentary="Meteor incoming",
        gateway_connected=True,
        server_now_ms=999,
    )
    dumped = envelope.model_dump(by_alias=True)

    assert dumped["directorCommentary"] == "Meteor incoming"
    assert dumped["gatewayConnected"] is True
    assert dumped["serverNowMs"] == 999
    assert "frameJpegBase64" in dumped
    assert dumped["state"]["modifierUntilMs"] == 1234
    assert dumped["state"]["countdownEndsMs"] == 10
    assert dumped["state"]["startedAtMs"] == 5
    assert dumped["state"]["players"]["P1"]["lastSpell"] == "F"
    assert dumped["state"]["players"]["P1"]["cooldownUntilMs"] == {}
    assert dumped["state"]["players"]["P1"]["shieldUntilMs"] == 0
    assert dumped["markers"]["P1"]["playerId"] == "P1"


def test_directive_accepts_snake_case_from_the_model_and_validates_bounds() -> None:
    directive = ArenaDirective.model_validate(
        {"modifier": "meteor", "duration_ms": 5000, "commentary": "Rocks fall"}
    )
    assert directive.duration_ms == 5000

    with pytest.raises(ValidationError):
        ArenaDirective.model_validate(
            {"modifier": "meteor", "duration_ms": 999, "commentary": "too short"}
        )
    with pytest.raises(ValidationError):
        ArenaDirective.model_validate(
            {"modifier": "black_hole", "duration_ms": 5000, "commentary": "nope"}
        )
