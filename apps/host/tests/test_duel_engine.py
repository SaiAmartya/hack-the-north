from phantom_host.duel_engine import (
    ALL_SPELLS,
    CORE_SPELLS,
    AbortCommand,
    CastCommand,
    DuelEngine,
    ReadyCommand,
    ruleset,
)
from phantom_host.duel_models import Outcome, Phase, Slot, Spell


def _ready_engine(
    *, enabled: frozenset[Spell] | None = None, at_ms: int = 1_000
) -> DuelEngine:
    engine = DuelEngine(enabled_spells=enabled)
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


def test_ruleset_publishes_seven_spells_with_starting_values_and_an_allowlist():
    full = ruleset().model_dump(mode="json")
    assert full["version"] == 2
    assert full["tick_ms"] == 50
    assert full["round_ms"] == 60_000
    assert full["max_hp"] == 100
    assert full["cast_recovery_ms"] == 500
    by_spell = {spell["spell"]: spell for spell in full["spells"]}
    assert list(by_spell) == [
        "stupefy",
        "protego",
        "expelliarmus",
        "incendio",
        "sectumsempra",
        "petrificus-totalus",
        "expecto-patronum",
    ]
    assert all(spell["enabled"] for spell in full["spells"])
    assert by_spell["stupefy"] == {
        "spell": "stupefy",
        "enabled": True,
        "damage": 20,
        "cooldown_ms": 2_000,
        "flight_ms": 2_000,
        "shield_ms": 0,
        "offense_lock_ms": 0,
        "bind_ms": 0,
        "burn_damage": 0,
        "burn_ticks": 0,
        "burn_interval_ms": 0,
        "barrier_ms": 0,
    }
    assert (by_spell["protego"]["shield_ms"], by_spell["protego"]["cooldown_ms"]) == (1_200, 3_000)
    assert (by_spell["expelliarmus"]["offense_lock_ms"], by_spell["expelliarmus"]["cooldown_ms"]) == (1_000, 6_000)
    assert (by_spell["incendio"]["damage"], by_spell["incendio"]["burn_damage"], by_spell["incendio"]["burn_ticks"], by_spell["incendio"]["burn_interval_ms"], by_spell["incendio"]["cooldown_ms"]) == (8, 4, 3, 1_000, 6_000)
    assert (by_spell["sectumsempra"]["damage"], by_spell["sectumsempra"]["flight_ms"], by_spell["sectumsempra"]["cooldown_ms"]) == (35, 2_800, 9_000)
    assert (by_spell["petrificus-totalus"]["damage"], by_spell["petrificus-totalus"]["bind_ms"], by_spell["petrificus-totalus"]["cooldown_ms"]) == (0, 1_500, 10_000)
    assert (by_spell["expecto-patronum"]["barrier_ms"], by_spell["expecto-patronum"]["cooldown_ms"]) == (3_000, 15_000)

    core = ruleset(enabled_spells=CORE_SPELLS).model_dump(mode="json")
    assert [spell["spell"] for spell in core["spells"] if spell["enabled"]] == ["stupefy"]
    assert ALL_SPELLS == frozenset(Spell)


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
    engine = _ready_engine(enabled=CORE_SPELLS | {Spell.PROTEGO})
    first = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )[0]
    assert first.accepted

    disabled = engine.advance(
        now_ms=4_499,
        commands=[_cast(4, Slot.P1, 4_499, Spell.EXPELLIARMUS)],
    )[0]
    # Disabled is checked after evidence and before cast recovery.
    assert not disabled.accepted and disabled.reason == "spell_disabled"
    # The short recovery between moves applies to Protego as well.
    recovery = engine.advance(
        now_ms=4_499,
        commands=[_cast(5, Slot.P1, 4_499, Spell.PROTEGO)],
    )[0]
    assert not recovery.accepted and recovery.reason == "cast_recovery"
    guard = engine.advance(
        now_ms=4_500,
        commands=[_cast(6, Slot.P1, 4_500, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    cooldown = engine.advance(
        now_ms=5_999,
        commands=[_cast(7, Slot.P1, 5_999, Spell.STUPEFY)],
    )[0]
    assert not cooldown.accepted and cooldown.reason == "cooldown"
    boundary = engine.advance(
        now_ms=6_000,
        commands=[_cast(8, Slot.P1, 6_000, Spell.STUPEFY)],
    )[0]
    assert boundary.accepted
    duplicate = engine.advance(
        now_ms=7_000,
        commands=[
            CastCommand(
                command_id=9,
                slot=Slot.P1,
                at_ms=7_000,
                order=9,
                round_id=1,
                attempt_id="new-attempt",
                spell=Spell.PROTEGO,
                gesture_id="g-8",
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


def test_expelliarmus_applies_damage_and_a_disarm_that_spares_defences():
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
        commands=[_cast(4, Slot.P2, 6_300, Spell.SECTUMSEMPRA)],
    )[0]
    assert blocked_offense.reason == "offense_locked"
    guard = engine.advance(
        now_ms=6_300,
        commands=[_cast(5, Slot.P2, 6_300, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    patronus = engine.advance(
        now_ms=6_900,
        commands=[_cast(6, Slot.P2, 6_900, Spell.EXPECTO_PATRONUM)],
    )[0]
    assert patronus.accepted
    freed = engine.advance(
        now_ms=7_400,
        commands=[_cast(7, Slot.P2, 7_400, Spell.STUPEFY)],
    )[0]
    assert freed.accepted


def test_petrificus_binds_every_cast_including_protego_until_it_expires():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.PETRIFICUS_TOTALUS)],
    )
    engine.advance(now_ms=6_400, commands=[])
    target = engine.players[Slot.P2]
    assert target.hp == 100
    assert target.bound_until_ms == 7_900
    assert [event.type for event in engine.recent_events][-1] == "bodyBound"
    assert "damage" not in [event.type for event in engine.recent_events]
    bound = engine.advance(
        now_ms=6_500,
        commands=[_cast(4, Slot.P2, 6_500, Spell.PROTEGO)],
    )[0]
    assert not bound.accepted and bound.reason == "bound"
    freed = engine.advance(
        now_ms=7_900,
        commands=[_cast(5, Slot.P2, 7_900, Spell.PROTEGO)],
    )[0]
    assert freed.accepted


def test_incendio_burns_through_a_later_shield_and_a_burn_can_knock_out():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)],
    )
    engine.advance(now_ms=6_000, commands=[])
    target = engine.players[Slot.P2]
    assert target.hp == 92
    assert target.burning_until_ms == 9_000
    assert [event.type for event in engine.recent_events][-2:] == ["damage", "burning"]
    guard = engine.advance(
        now_ms=6_100,
        commands=[_cast(4, Slot.P2, 6_100, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    engine.advance(now_ms=7_040, commands=[])
    assert target.hp == 88
    assert engine.recent_events[-1].type == "burnDamage"
    assert engine.recent_events[-1].amount == 4
    assert engine.recent_events[-1].actor is Slot.P1
    engine.advance(now_ms=9_000, commands=[])
    assert target.hp == 80
    assert target.burns == []
    engine.advance(now_ms=12_000, commands=[])
    assert target.hp == 80

    lethal = _ready_engine()
    lethal.players[Slot.P2].hp = 10
    lethal.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)],
    )
    lethal.advance(now_ms=6_000, commands=[])
    assert lethal.players[Slot.P2].hp == 2
    lethal.advance(now_ms=7_000, commands=[])
    assert lethal.players[Slot.P2].hp == 0
    assert lethal.phase is Phase.RESULT
    assert lethal.result is not None
    assert lethal.result.winner is Slot.P1
    assert lethal.result.reason == "knockout"
    assert lethal.players[Slot.P2].burns == []


def test_a_fresh_fire_replaces_an_older_burn_instead_of_stacking():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)],
    )
    engine.players[Slot.P1].cooldown_until_ms.clear()
    engine.advance(
        now_ms=5_000,
        commands=[_cast(4, Slot.P1, 5_000, Spell.INCENDIO)],
    )
    engine.advance(now_ms=7_000, commands=[])
    target = engine.players[Slot.P2]
    # 8 (first impact) + 8 (second impact); the older tick due at 7_000 was replaced.
    assert target.hp == 84
    assert [tick.at_ms for tick in target.burns] == [8_000, 9_000, 10_000]
    engine.advance(now_ms=10_000, commands=[])
    assert target.hp == 72


def test_patronus_repels_every_projectile_while_protego_breaks_after_one():
    engine = _ready_engine()
    patronus = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P2, 4_000, Spell.EXPECTO_PATRONUM)],
    )[0]
    assert patronus.accepted
    assert engine.players[Slot.P2].barrier_until_ms == 7_000
    assert engine.recent_events[-1].type == "barrierRaised"
    engine.advance(
        now_ms=4_700,
        commands=[
            _cast(4, Slot.P1, 4_100, Spell.STUPEFY),
            _cast(5, Slot.P1, 4_700, Spell.EXPELLIARMUS),
        ],
    )
    engine.advance(now_ms=6_900, commands=[])
    blocked = [event for event in engine.recent_events if event.type == "impactBlocked"]
    assert [event.reason for event in blocked] == ["barrier", "barrier"]
    assert engine.players[Slot.P2].hp == 100
    assert engine.players[Slot.P2].offense_locked_until_ms == 0
    assert engine.players[Slot.P2].barrier_until_ms == 7_000

    engine.advance(
        now_ms=8_000,
        commands=[_cast(6, Slot.P1, 8_000, Spell.STUPEFY)],
    )
    engine.advance(
        now_ms=9_500,
        commands=[_cast(7, Slot.P2, 9_500, Spell.PROTEGO)],
    )
    engine.advance(now_ms=10_000, commands=[])
    assert engine.recent_events[-1].type == "impactBlocked"
    assert engine.recent_events[-1].reason == "shield"
    assert engine.players[Slot.P2].shield_until_ms == 0
    engine.advance(
        now_ms=10_100,
        commands=[_cast(8, Slot.P1, 10_100, Spell.STUPEFY)],
    )
    engine.advance(now_ms=12_100, commands=[])
    assert engine.players[Slot.P2].hp == 80


def test_sectumsempra_is_the_heavy_telegraphed_hit():
    engine = _ready_engine()
    decision = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.SECTUMSEMPRA)],
    )[0]
    assert decision.accepted
    assert engine.projectiles[0].impact_at_ms == 6_800
    engine.advance(now_ms=6_799, commands=[])
    assert engine.players[Slot.P2].hp == 100
    engine.advance(now_ms=6_800, commands=[])
    assert engine.players[Slot.P2].hp == 65
    again = engine.advance(
        now_ms=12_999,
        commands=[_cast(4, Slot.P1, 12_999, Spell.SECTUMSEMPRA)],
    )[0]
    assert again.reason == "cooldown"


def test_round_end_clears_binds_burns_and_barriers():
    engine = _ready_engine()
    engine.advance(
        now_ms=4_000,
        commands=[
            _cast(3, Slot.P1, 4_000, Spell.INCENDIO),
            _cast(4, Slot.P2, 4_000, Spell.PETRIFICUS_TOTALUS),
        ],
    )
    engine.advance(now_ms=6_400, commands=[])
    assert engine.players[Slot.P2].burns
    assert engine.players[Slot.P1].bound_until_ms == 7_900
    engine.advance(
        now_ms=6_500,
        commands=[AbortCommand(at_ms=6_500, order=5, reason="input_unhealthy")],
    )
    for player in engine.players.values():
        assert player.burns == []
        assert player.bound_until_ms == 0
        assert player.barrier_until_ms == 0
        assert player.shield_until_ms == 0


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
