import pytest

from phantom_host.duel_engine import (
    AbortCommand,
    CastCommand,
    DuelEngine,
    ReadyCommand,
    SPELL_RULES,
    ruleset,
)
from phantom_host.duel_models import Outcome, Phase, Slot, Spell


def _ready_engine(*, at_ms: int = 1_000) -> DuelEngine:
    engine = DuelEngine()
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


def test_ruleset_publishes_five_moves_with_distinct_cooldowns():
    published = ruleset().model_dump(mode="json")
    assert published["tick_ms"] == 50
    assert published["round_ms"] == 60_000
    assert published["max_hp"] == 100
    assert "offensive_recovery_ms" not in published
    assert len({spell["cooldown_ms"] for spell in published["spells"]}) == 5
    assert all(spell["enabled"] for spell in published["spells"])
    by_spell = {spell["spell"]: spell for spell in published["spells"]}
    assert by_spell["stupefy"] == {
        "spell": "stupefy",
        "enabled": True,
        "damage": 20,
        "heal": 0,
        "cooldown_ms": 2_000,
        "flight_ms": 2_000,
        "shield_ms": 0,
        "offense_lock_ms": 0,
    }
    assert by_spell["protego"]["shield_ms"] == 1_200
    assert by_spell["protego"]["cooldown_ms"] == 3_000
    assert by_spell["expelliarmus"]["offense_lock_ms"] == 1_000
    assert by_spell["incendio"]["damage"] == 30
    assert by_spell["episkey"]["heal"] == 18


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


def test_cooldown_and_evidence_are_authoritative_without_global_recovery():
    engine = _ready_engine()
    first = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )[0]
    assert first.accepted

    followup = engine.advance(
        now_ms=4_000,
        commands=[_cast(4, Slot.P1, 4_000, Spell.EXPELLIARMUS)],
    )[0]
    assert followup.accepted
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


def test_expelliarmus_applies_damage_and_locks_only_offense():
    engine = _ready_engine()
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
    heal = engine.advance(
        now_ms=6_300,
        commands=[_cast(6, Slot.P2, 6_300, Spell.EPISKEY)],
    )[0]
    assert heal.accepted
    assert engine.players[Slot.P2].hp == 100


@pytest.mark.parametrize("spell", list(Spell))
def test_each_move_rejects_before_its_cooldown_and_accepts_at_the_boundary(spell):
    engine = _ready_engine()
    engine.players[Slot.P1].hp = 50
    cooldown = SPELL_RULES[spell].cooldown_ms
    first = engine.advance(
        now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, spell)]
    )[0]
    early = engine.advance(
        now_ms=4_000 + cooldown - 1,
        commands=[_cast(4, Slot.P1, 4_000 + cooldown - 1, spell)],
    )[0]
    boundary = engine.advance(
        now_ms=4_000 + cooldown,
        commands=[_cast(5, Slot.P1, 4_000 + cooldown, spell)],
    )[0]
    assert first.accepted and boundary.accepted
    assert not early.accepted and early.reason == "cooldown"


def test_all_five_moves_can_follow_each_other_without_a_global_cooldown():
    engine = _ready_engine()
    engine.players[Slot.P1].hp = 80
    decisions = engine.advance(
        now_ms=4_000,
        commands=[_cast(index, Slot.P1, 4_000, spell) for index, spell in enumerate(Spell, 3)],
    )
    assert all(decision.accepted for decision in decisions)
    assert len(engine.projectiles) == 3
    assert engine.players[Slot.P1].hp == 98
    assert engine.players[Slot.P1].shield_until_ms == 5_200
    engine.advance(now_ms=6_400, commands=[])
    assert engine.players[Slot.P2].hp == 40
    assert engine.players[Slot.P2].offense_locked_until_ms == 7_200


@pytest.mark.parametrize("spell", [Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO])
def test_protego_blocks_each_attack_and_its_effect(spell):
    engine = _ready_engine()
    impact_at = 4_000 + SPELL_RULES[spell].flight_ms
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, spell)])
    engine.advance(
        now_ms=impact_at,
        commands=[_cast(4, Slot.P2, impact_at - 1, Spell.PROTEGO)],
    )
    assert engine.players[Slot.P2].hp == 100
    assert engine.players[Slot.P2].offense_locked_until_ms == 0
    assert engine.players[Slot.P2].shield_until_ms == 0
    assert engine.recent_events[-1].type == "impactBlocked"


def test_episkey_is_capped_and_full_health_does_not_spend_its_cooldown():
    engine = _ready_engine()
    full = engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.EPISKEY)])[0]
    assert not full.accepted and full.reason == "full_health"
    assert Spell.EPISKEY not in engine.players[Slot.P1].cooldown_until_ms
    engine.players[Slot.P1].hp = 95
    accepted = engine.advance(now_ms=4_000, commands=[_cast(4, Slot.P1, 4_000, Spell.EPISKEY)])[0]
    assert accepted.accepted and engine.players[Slot.P1].hp == 100
    event = engine.recent_events[-1]
    assert (event.type, event.amount, event.actor, event.target) == ("healed", 5, Slot.P1, Slot.P1)


def test_healing_at_a_lethal_impact_cannot_revive_a_defeated_wizard():
    engine = _ready_engine()
    engine.players[Slot.P2].hp = 30
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    heal = engine.advance(
        now_ms=6_400, commands=[_cast(4, Slot.P2, 6_400, Spell.EPISKEY)]
    )[0]
    assert not heal.accepted and heal.reason == "round_ending"
    assert engine.result is not None and engine.result.winner is Slot.P1
    assert engine.players[Slot.P2].hp == 0


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
