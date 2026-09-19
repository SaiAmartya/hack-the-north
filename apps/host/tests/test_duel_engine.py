from phantom_host.duel_engine import (
    AbortCommand,
    CastCommand,
    DuelEngine,
    ReadyCommand,
    ruleset,
)
from phantom_host.duel_models import Outcome, Phase, Slot, Spell


def _ready_engine(*, expelliarmus: bool = False, at_ms: int = 1_000) -> DuelEngine:
    engine = DuelEngine(expelliarmus_enabled=expelliarmus)
    engine.reset_lobby(
        now_ms=0,
        room_generation=2,
        occupied_slots={Slot.P1, Slot.P2},
    )
    decisions = engine.advance(
        now_ms=at_ms,
        commands=[
            ReadyCommand(1, Slot.P1, at_ms, 1, True),
            ReadyCommand(2, Slot.P2, at_ms, 2, True),
        ],
    )
    assert all(decision.accepted for decision in decisions)
    assert engine.phase is Phase.COUNTDOWN
    engine.advance(now_ms=at_ms + 3_000, commands=[])
    assert engine.phase is Phase.PLAYING
    return engine


def _cast(
    command_id: int,
    slot: Slot,
    at_ms: int,
    spell: Spell,
    *,
    round_id: int = 1,
    order: int | None = None,
    suffix: str | None = None,
) -> CastCommand:
    unique = suffix or str(command_id)
    return CastCommand(
        command_id=command_id,
        slot=slot,
        at_ms=at_ms,
        order=command_id if order is None else order,
        round_id=round_id,
        attempt_id=f"a-{unique}",
        spell=spell,
        gesture_id=f"g-{unique}",
        speech_id=f"s-{unique}",
    )


def test_ruleset_publishes_exact_mvp_values_and_third_spell_gate():
    disabled = ruleset(expelliarmus_enabled=False).model_dump(mode="json")
    enabled = ruleset(expelliarmus_enabled=True).model_dump(mode="json")
    assert disabled["tick_ms"] == 50
    assert disabled["round_ms"] == 60_000
    assert disabled["max_hp"] == 100
    assert disabled["offensive_recovery_ms"] == 600
    by_spell = {spell["spell"]: spell for spell in disabled["spells"]}
    assert by_spell["stupefy"] == {
        "spell": "stupefy",
        "enabled": True,
        "damage": 20,
        "cooldown_ms": 2_000,
        "flight_ms": 2_000,
        "shield_ms": 0,
        "offense_lock_ms": 0,
    }
    assert by_spell["protego"]["shield_ms"] == 1_200
    assert by_spell["protego"]["cooldown_ms"] == 3_000
    assert by_spell["expelliarmus"]["enabled"] is False
    assert enabled["spells"][2]["enabled"] is True


def test_guard_received_before_due_impact_blocks_even_on_late_tick():
    engine = _ready_engine()
    attack = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )[0]
    assert attack.accepted and attack.projectile_id == "r1:p1"

    guard = engine.advance(
        now_ms=6_050,
        commands=[_cast(4, Slot.P2, 5_990, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    assert engine.players[Slot.P2].hp == 100
    assert engine.players[Slot.P2].shield_until_ms == 0
    assert [event.type for event in engine.recent_events][-2:] == [
        "shieldRaised",
        "impactBlocked",
    ]


def test_equal_time_guard_loses_and_shield_expiry_is_end_exclusive():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )
    decision = engine.advance(
        now_ms=6_000,
        commands=[_cast(4, Slot.P2, 6_000, Spell.PROTEGO)],
    )[0]
    assert decision.accepted
    assert engine.players[Slot.P2].hp == 80
    assert engine.players[Slot.P2].shield_until_ms == 7_200

    second = _ready_engine()
    second.advance(
        now_ms=4_000,
        commands=[
            _cast(3, Slot.P1, 4_000, Spell.STUPEFY),
            _cast(4, Slot.P2, 4_800, Spell.PROTEGO),
        ],
    )
    second.advance(now_ms=6_000, commands=[])
    assert second.players[Slot.P2].hp == 80


def test_same_step_lethal_impacts_are_batched_into_draw():
    engine = _ready_engine()
    engine.players[Slot.P1].hp = 20
    engine.players[Slot.P2].hp = 20
    decisions = engine.advance(
        now_ms=4_000,
        commands=[
            _cast(3, Slot.P1, 4_000, Spell.STUPEFY),
            _cast(4, Slot.P2, 4_000, Spell.STUPEFY),
        ],
    )
    assert all(decision.accepted for decision in decisions)
    engine.advance(now_ms=6_050, commands=[])
    assert engine.players[Slot.P1].hp == 0
    assert engine.players[Slot.P2].hp == 0
    assert engine.phase is Phase.RESULT
    assert engine.result is not None
    assert engine.result.outcome is Outcome.DRAW
    assert engine.result.reason == "knockout"


def test_round_deadline_resolves_due_impact_and_discards_later_projectile():
    engine = _ready_engine()
    # The round starts at 4_000 and ends at 64_000.
    engine.advance(
        now_ms=62_000,
        commands=[_cast(3, Slot.P1, 62_000, Spell.STUPEFY)],
    )
    engine.advance(now_ms=64_000, commands=[])
    assert engine.players[Slot.P2].hp == 80
    assert engine.result is not None
    assert engine.result.outcome is Outcome.WIN
    assert engine.result.winner is Slot.P1
    assert engine.result.reason == "timeout"
    assert engine.projectiles == []

    later = _ready_engine()
    later.advance(
        now_ms=63_000,
        commands=[_cast(3, Slot.P1, 63_000, Spell.STUPEFY)],
    )
    later.advance(now_ms=64_000, commands=[])
    assert later.players[Slot.P2].hp == 100
    assert later.result is not None
    assert later.result.outcome is Outcome.DRAW
    assert later.projectiles == []


def test_input_abort_at_impact_time_beats_combat():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )
    engine.advance(
        now_ms=6_000,
        commands=[AbortCommand(at_ms=6_000, order=4, reason="input_unhealthy")],
    )
    assert engine.players[Slot.P2].hp == 100
    assert engine.projectiles == []
    assert engine.result is not None
    assert engine.result.outcome is Outcome.ABORTED
    assert engine.result.reason == "input_unhealthy"


def test_fault_after_lethal_impact_cannot_replace_knockout_with_abort():
    engine = _ready_engine()
    engine.players[Slot.P2].hp = 20
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )
    decisions = engine.advance(
        now_ms=6_050,
        commands=[
            AbortCommand(at_ms=6_020, order=4, reason="input_unhealthy"),
            ReadyCommand(5, Slot.P2, 6_020, 5, False),
        ],
    )
    assert decisions[0].accepted is False
    assert decisions[0].reason == "round_ending"
    assert engine.result is not None
    assert engine.result.outcome is Outcome.WIN
    assert engine.result.winner is Slot.P1
    assert engine.result.reason == "knockout"


def test_abort_or_deadline_rejects_queued_ready_until_a_later_advance():
    aborted = _ready_engine()
    decisions = aborted.advance(
        now_ms=4_100,
        commands=[
            AbortCommand(at_ms=4_100, order=3, reason="input_unhealthy"),
            ReadyCommand(4, Slot.P1, 4_100, 4, True),
            ReadyCommand(5, Slot.P2, 4_100, 5, True),
        ],
    )
    assert [decision.reason for decision in decisions] == [
        "round_aborted",
        "round_aborted",
    ]
    assert aborted.phase is Phase.RESULT

    timeout = _ready_engine()
    deadline = timeout.round_ends_at_ms
    decisions = timeout.advance(
        now_ms=deadline,
        commands=[
            ReadyCommand(3, Slot.P1, deadline, 3, True),
            ReadyCommand(4, Slot.P2, deadline, 4, True),
        ],
    )
    assert [decision.reason for decision in decisions] == [
        "round_ending",
        "round_ending",
    ]
    assert timeout.phase is Phase.RESULT
    timeout.advance(
        now_ms=deadline + 1,
        commands=[
            ReadyCommand(5, Slot.P1, deadline + 1, 5, True),
            ReadyCommand(6, Slot.P2, deadline + 1, 6, True),
        ],
    )
    assert timeout.phase is Phase.COUNTDOWN
    assert timeout.round_id == 2


def test_cooldown_recovery_evidence_and_disabled_spell_are_authoritative():
    engine = _ready_engine()
    first = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )[0]
    assert first.accepted

    recovery = engine.advance(
        now_ms=4_599,
        commands=[_cast(4, Slot.P1, 4_599, Spell.EXPELLIARMUS)],
    )[0]
    # Disabled is checked after evidence and before offensive recovery.
    assert not recovery.accepted and recovery.reason == "spell_disabled"
    cooldown = engine.advance(
        now_ms=5_999,
        commands=[_cast(5, Slot.P1, 5_999, Spell.STUPEFY)],
    )[0]
    assert not cooldown.accepted and cooldown.reason == "cooldown"
    boundary = engine.advance(
        now_ms=6_000,
        commands=[_cast(6, Slot.P1, 6_000, Spell.STUPEFY)],
    )[0]
    assert boundary.accepted
    duplicate = engine.advance(
        now_ms=6_100,
        commands=[
            CastCommand(
                command_id=7,
                slot=Slot.P1,
                at_ms=6_100,
                order=7,
                round_id=1,
                attempt_id="new-attempt",
                spell=Spell.PROTEGO,
                gesture_id="g-6",
                speech_id="fresh-speech",
            )
        ],
    )[0]
    assert not duplicate.accepted and duplicate.reason == "duplicate_evidence"


def test_future_command_is_not_processed_before_the_clock_reaches_it():
    engine = _ready_engine()
    decisions = engine.advance(
        now_ms=4_050,
        commands=[_cast(3, Slot.P1, 5_000, Spell.STUPEFY)],
    )
    assert decisions == []
    assert engine.projectiles == []


def test_expelliarmus_enabled_applies_damage_and_offense_lock_on_impact():
    engine = _ready_engine(expelliarmus=True)
    accepted = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.EXPELLIARMUS)],
    )[0]
    assert accepted.accepted
    engine.advance(now_ms=6_200, commands=[])
    assert engine.players[Slot.P2].hp == 90
    assert engine.players[Slot.P2].offense_locked_until_ms == 7_200
    blocked_offense = engine.advance(
        now_ms=6_300,
        commands=[_cast(4, Slot.P2, 6_300, Spell.STUPEFY)],
    )[0]
    assert blocked_offense.reason == "offense_locked"
    guard = engine.advance(
        now_ms=6_300,
        commands=[_cast(5, Slot.P2, 6_300, Spell.PROTEGO)],
    )[0]
    assert guard.accepted


def test_events_carry_the_resulting_state_version_and_stable_ids():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )
    events = list(engine.recent_events)
    assert all(event.state_version > 0 for event in events)
    assert [event.state_version for event in events] == sorted(
        event.state_version for event in events
    )
    assert len({event.id for event in events}) == len(events)
