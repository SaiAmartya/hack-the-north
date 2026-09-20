import pytest

from phantom_host.duel_engine import (
    BURN_TICK_MS,
    CRIT_CHANCE_PERCENT,
    HASTE_MS,
    MIRROR_MS,
    PERFECT_BLOCK_MS,
    POWERUP_FIRST_MS,
    POWERUP_GAP_MS,
    POWERUP_LIFETIME_MS,
    REFLECT_FLIGHT_MS,
    ROUND_MS,
    SPELL_RULES,
    AbortCommand,
    CastCommand,
    DuelEngine,
    Powerup,
    ReadyCommand,
    ruleset,
)
from phantom_host.duel_models import Outcome, Phase, PowerupKind, Slot, Spell

ROUND_START_MS = 4_000
DEADLINE_MS = ROUND_START_MS + ROUND_MS


def _ready_engine(*, at_ms: int = 1_000, seed: int = 0, variance: bool = False) -> DuelEngine:
    engine = DuelEngine(seed=seed, variance=variance)
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


def _types(engine: DuelEngine) -> list[str]:
    return [event.type for event in engine.recent_events]


def test_ruleset_publishes_five_distinct_moves_and_the_arena_variance_rules():
    published = ruleset().model_dump(mode="json")
    assert published["tick_ms"] == 50
    assert published["round_ms"] == 90_000
    assert published["max_hp"] == 100
    assert published["crit_chance_percent"] == 12
    assert published["crit_multiplier_percent"] == 150
    assert published["perfect_block_ms"] == 350
    assert published["powerup_lifetime_ms"] == 10_000
    assert "offensive_recovery_ms" not in published
    assert len({spell["cooldown_ms"] for spell in published["spells"]}) == 5
    assert len({spell["flight_ms"] for spell in published["spells"] if spell["damage"]}) == 3
    assert all(spell["enabled"] for spell in published["spells"])
    by_spell = {spell["spell"]: spell for spell in published["spells"]}
    assert by_spell["stupefy"] == {
        "spell": "stupefy",
        "enabled": True,
        "damage": 14,
        "heal": 0,
        "cooldown_ms": 2_500,
        "flight_ms": 800,
        "shield_ms": 0,
        "offense_lock_ms": 0,
        "stun_ms": 1_200,
        "stun_chance_percent": 25,
        "burn_damage": 0,
        "burn_ms": 0,
        "breaks_shield": False,
    }
    assert by_spell["protego"]["shield_ms"] == 1_500
    assert by_spell["protego"]["cooldown_ms"] == 4_000
    assert by_spell["expelliarmus"]["offense_lock_ms"] == 2_500
    assert by_spell["expelliarmus"]["breaks_shield"] is True
    assert by_spell["expelliarmus"]["flight_ms"] < by_spell["incendio"]["flight_ms"]
    assert by_spell["incendio"]["damage"] == 22
    assert (by_spell["incendio"]["burn_damage"], by_spell["incendio"]["burn_ms"]) == (3, 4_000)
    assert by_spell["episkey"]["heal"] == 22


def test_guard_received_before_due_impact_blocks_even_on_late_tick():
    engine = _ready_engine()
    attack = engine.advance(
        now_ms=ROUND_START_MS,
        commands=[_cast(3, Slot.P1, ROUND_START_MS, Spell.STUPEFY)],
    )[0]
    assert attack.accepted and attack.projectile_id == "r1:p1"

    guard = engine.advance(
        now_ms=4_850,
        commands=[_cast(4, Slot.P2, 4_300, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    assert engine.players[Slot.P2].hp == 100
    assert engine.players[Slot.P2].shield_until_ms == 0
    assert _types(engine)[-2:] == ["shieldRaised", "impactBlocked"]
    assert engine.projectiles == []


def test_equal_time_guard_loses_and_shield_expiry_is_end_exclusive():
    engine = _ready_engine()
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)])
    decision = engine.advance(
        now_ms=4_800,
        commands=[_cast(4, Slot.P2, 4_800, Spell.PROTEGO)],
    )[0]
    assert decision.accepted
    assert engine.players[Slot.P2].hp == 86
    assert engine.players[Slot.P2].shield_until_ms == 6_300

    second = _ready_engine()
    second.advance(now_ms=4_000, commands=[_cast(3, Slot.P2, 4_000, Spell.PROTEGO)])
    second.advance(now_ms=4_700, commands=[_cast(4, Slot.P1, 4_700, Spell.STUPEFY)])
    assert second.players[Slot.P2].shield_until_ms == 5_500
    second.advance(now_ms=5_500, commands=[])
    assert second.players[Slot.P2].hp == 86


def test_perfect_block_reflects_the_spell_back_without_its_side_effects():
    engine = _ready_engine()
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    impact = 4_000 + SPELL_RULES[Spell.INCENDIO].flight_ms
    guard = engine.advance(
        now_ms=impact,
        commands=[_cast(4, Slot.P2, impact - PERFECT_BLOCK_MS, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    assert engine.players[Slot.P2].hp == 100 and engine.players[Slot.P2].burn_until_ms == 0
    reflected_event = [event for event in engine.recent_events if event.type == "impactReflected"]
    assert len(reflected_event) == 1 and reflected_event[0].reason == "perfect"
    assert reflected_event[0].target is Slot.P2 and reflected_event[0].actor is Slot.P1
    assert len(engine.projectiles) == 1
    back = engine.projectiles[0]
    assert (back.caster, back.target, back.spell, back.reflected) == (Slot.P2, Slot.P1, Spell.INCENDIO, True)
    assert back.impact_at_ms == impact + REFLECT_FLIGHT_MS and back.damage == 22
    assert back.snapshot().reflected is True
    launched = [event for event in engine.recent_events if event.type == "projectileLaunched"]
    assert launched[-1].reason == "reflected" and launched[-1].actor is Slot.P2

    engine.advance(now_ms=back.impact_at_ms, commands=[])
    assert engine.players[Slot.P1].hp == 78
    # A reflected fireball hurts but does not set the original caster alight.
    assert engine.players[Slot.P1].burn_until_ms == 0
    assert "burning" not in _types(engine)[-3:]


def test_a_reflected_spell_can_still_be_blocked_by_an_ordinary_guard():
    engine = _ready_engine()
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)])
    engine.advance(now_ms=4_800, commands=[_cast(4, Slot.P2, 4_600, Spell.PROTEGO)])
    back = engine.projectiles[0]
    assert back.reflected and back.target is Slot.P1
    engine.advance(
        now_ms=back.impact_at_ms,
        commands=[_cast(5, Slot.P1, back.impact_at_ms - 700, Spell.PROTEGO)],
    )
    assert engine.players[Slot.P1].hp == 100 and engine.projectiles == []
    assert _types(engine)[-1] == "impactBlocked"


def test_expelliarmus_shatters_a_raised_shield_and_still_disarms():
    engine = _ready_engine()
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P2, 4_000, Spell.PROTEGO)])
    engine.advance(now_ms=4_100, commands=[_cast(4, Slot.P1, 4_100, Spell.EXPELLIARMUS)])
    impact = 4_100 + SPELL_RULES[Spell.EXPELLIARMUS].flight_ms
    assert impact < engine.players[Slot.P2].shield_until_ms
    engine.advance(now_ms=impact, commands=[])
    defender = engine.players[Slot.P2]
    assert defender.hp == 100
    assert defender.shield_until_ms == 0
    assert defender.offense_locked_until_ms == impact + 2_500
    assert _types(engine)[-2:] == ["shieldBroken", "offenseLocked"]
    assert engine.projectiles == []


def test_expelliarmus_applies_damage_and_locks_only_offense():
    engine = _ready_engine()
    accepted = engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.EXPELLIARMUS)],
    )[0]
    assert accepted.accepted
    engine.advance(now_ms=5_100, commands=[])
    assert engine.players[Slot.P2].hp == 92
    assert engine.players[Slot.P2].offense_locked_until_ms == 7_600
    blocked_offense = engine.advance(
        now_ms=5_200,
        commands=[_cast(4, Slot.P2, 5_200, Spell.STUPEFY)],
    )[0]
    assert blocked_offense.reason == "offense_locked"
    guard = engine.advance(
        now_ms=5_200,
        commands=[_cast(5, Slot.P2, 5_200, Spell.PROTEGO)],
    )[0]
    assert guard.accepted
    heal = engine.advance(
        now_ms=5_200,
        commands=[_cast(6, Slot.P2, 5_200, Spell.EPISKEY)],
    )[0]
    assert heal.accepted
    assert engine.players[Slot.P2].hp == 100


def test_incendio_burns_every_second_until_healed():
    engine = _ready_engine()
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    impact = 5_800
    engine.advance(now_ms=impact, commands=[])
    target = engine.players[Slot.P2]
    assert target.hp == 78
    assert target.burn_until_ms == impact + 4_000
    assert _types(engine)[-2:] == ["damage", "burning"]
    health = []
    for tick in range(1, 5):
        engine.advance(now_ms=impact + tick * BURN_TICK_MS, commands=[])
        health.append(target.hp)
    assert health == [75, 72, 69, 66]
    assert target.burn_until_ms == 0
    burned = [event for event in engine.recent_events if event.type == "burned"]
    assert len(burned) == 4 and all(event.amount == 3 and event.actor is Slot.P1 for event in burned)
    engine.advance(now_ms=impact + 5 * BURN_TICK_MS, commands=[])
    assert target.hp == 66

    cured = _ready_engine()
    cured.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    cured.advance(now_ms=impact + BURN_TICK_MS, commands=[])
    assert cured.players[Slot.P2].hp == 75
    heal = cured.advance(
        now_ms=impact + 1_200, commands=[_cast(4, Slot.P2, impact + 1_200, Spell.EPISKEY)]
    )[0]
    assert heal.accepted and cured.players[Slot.P2].hp == 97
    assert cured.players[Slot.P2].burn_until_ms == 0
    assert cured.recent_events[-1].reason == "cured"
    cured.advance(now_ms=impact + 4_000, commands=[])
    assert cured.players[Slot.P2].hp == 97


def test_a_burn_tick_can_finish_a_knockout():
    engine = _ready_engine()
    engine.players[Slot.P2].hp = 24
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    engine.advance(now_ms=5_800, commands=[])
    assert engine.players[Slot.P2].hp == 2 and engine.phase is Phase.PLAYING
    engine.advance(now_ms=6_800, commands=[])
    assert engine.players[Slot.P2].hp == 0
    assert engine.result is not None
    assert engine.result.outcome is Outcome.WIN and engine.result.winner is Slot.P1
    assert engine.result.reason == "knockout"


def test_episkey_may_be_cast_at_full_health_only_to_cure_a_burn():
    engine = _ready_engine()
    full = engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.EPISKEY)])[0]
    assert not full.accepted and full.reason == "full_health"
    engine.players[Slot.P1].burn_until_ms = 9_000
    engine.players[Slot.P1].burn_next_ms = 5_000
    cure = engine.advance(now_ms=4_100, commands=[_cast(4, Slot.P1, 4_100, Spell.EPISKEY)])[0]
    assert cure.accepted
    assert engine.players[Slot.P1].burn_until_ms == 0
    assert engine.recent_events[-1].amount == 0 and engine.recent_events[-1].reason == "cured"


def test_stupefy_can_stun_and_a_stunned_wizard_cannot_cast_until_the_boundary():
    stunned_seed = next(
        seed for seed in range(200)
        if _stupefy_outcome(seed)[0]
    )
    engine = _ready_engine(seed=stunned_seed, variance=True)
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)])
    engine.advance(now_ms=4_800, commands=[])
    target = engine.players[Slot.P2]
    assert target.stunned_until_ms == 6_000
    stunned = [event for event in engine.recent_events if event.type == "stunned"]
    assert len(stunned) == 1 and stunned[0].target is Slot.P2 and stunned[0].amount == 1_200
    for spell in (Spell.STUPEFY, Spell.PROTEGO, Spell.EPISKEY):
        rejected = engine.advance(now_ms=5_999, commands=[_cast(10, Slot.P2, 5_999, spell, suffix=f"{spell.value}-late")])[0]
        assert not rejected.accepted and rejected.reason == "stunned"
    accepted = engine.advance(now_ms=6_000, commands=[_cast(11, Slot.P2, 6_000, Spell.STUPEFY)])[0]
    assert accepted.accepted

    quiet = _ready_engine()
    quiet.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)])
    quiet.advance(now_ms=4_800, commands=[])
    assert quiet.players[Slot.P2].stunned_until_ms == 0 and "stunned" not in _types(quiet)


def _stupefy_outcome(seed: int) -> tuple[bool, bool]:
    engine = _ready_engine(seed=seed, variance=True)
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)])
    engine.advance(now_ms=4_800, commands=[])
    damage = next(event for event in engine.recent_events if event.type == "damage")
    return engine.players[Slot.P2].stunned_until_ms > 0, damage.critical


def test_critical_hits_multiply_damage_and_felix_guarantees_one():
    crit_seed = next(seed for seed in range(300) if _stupefy_outcome(seed)[1])
    engine = _ready_engine(seed=crit_seed, variance=True)
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)])
    engine.advance(now_ms=4_800, commands=[])
    damage = next(event for event in engine.recent_events if event.type == "damage")
    assert damage.critical and damage.amount == 21
    assert engine.players[Slot.P2].hp == 79
    assert sum(1 for seed in range(100) if _stupefy_outcome(seed)[1]) < 100 * CRIT_CHANCE_PERCENT // 100 + 20

    lucky = _ready_engine(seed=0, variance=True)
    lucky.players[Slot.P1].lucky = True
    lucky.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    lucky.advance(now_ms=5_800, commands=[])
    hit = next(event for event in lucky.recent_events if event.type == "damage")
    assert hit.critical and hit.amount == 33
    assert lucky.players[Slot.P1].lucky is False


def test_no_variance_means_no_crits_stuns_or_powerups_for_the_same_seed():
    engine = _ready_engine(seed=3, variance=False)
    assert engine.powerup_spawn_at_ms is None
    for index in range(6):
        at = 4_000 + index * 2_500
        engine.advance(now_ms=at, commands=[_cast(10 + index, Slot.P1, at, Spell.STUPEFY)])
        engine.advance(now_ms=at + 800, commands=[])
    assert all(not event.critical for event in engine.recent_events)
    assert "stunned" not in _types(engine) and "powerupAppeared" not in _types(engine)
    assert engine.players[Slot.P2].hp == 100 - 6 * 14


def test_powerups_appear_expire_and_reschedule_on_the_seeded_timeline():
    engine = _ready_engine(seed=11, variance=True)
    spawn = engine.powerup_spawn_at_ms
    assert spawn is not None
    assert ROUND_START_MS + POWERUP_FIRST_MS[0] <= spawn <= ROUND_START_MS + POWERUP_FIRST_MS[1]
    engine.advance(now_ms=spawn - 1, commands=[])
    assert engine.powerup is None
    engine.advance(now_ms=spawn, commands=[])
    assert engine.powerup is not None
    appeared = engine.recent_events[-1]
    assert appeared.type == "powerupAppeared" and appeared.powerup is engine.powerup.kind
    assert engine.powerup.expires_at_ms == spawn + POWERUP_LIFETIME_MS
    assert engine.powerup.snapshot().kind is engine.powerup.kind
    engine.advance(now_ms=spawn + POWERUP_LIFETIME_MS, commands=[])
    assert engine.powerup is None
    assert engine.recent_events[-1].type == "powerupExpired"
    next_spawn = engine.powerup_spawn_at_ms
    assert next_spawn is not None
    gap = next_spawn - (spawn + POWERUP_LIFETIME_MS)
    assert POWERUP_GAP_MS[0] <= gap <= POWERUP_GAP_MS[1]

    twin = _ready_engine(seed=11, variance=True)
    assert twin.powerup_spawn_at_ms == spawn
    other = _ready_engine(seed=12, variance=True)
    assert other.powerup_spawn_at_ms != spawn or other.powerup_spawn_at_ms is not None


def _with_powerup(kind: PowerupKind, *, at_ms: int = 5_000, engine: DuelEngine | None = None) -> DuelEngine:
    engine = engine or _ready_engine(seed=5, variance=True)
    engine.powerup = Powerup(id="r1:u9", kind=kind, spawned_at_ms=at_ms - 500, expires_at_ms=at_ms + 9_500)
    return engine


def test_any_accepted_cast_claims_the_powerup_for_its_caster():
    engine = _with_powerup(PowerupKind.FELIX)
    rejected = engine.advance(now_ms=5_000, commands=[_cast(3, Slot.P1, 5_000, Spell.EPISKEY)])[0]
    assert not rejected.accepted and engine.powerup is not None
    engine.advance(now_ms=5_000, commands=[_cast(4, Slot.P2, 5_000, Spell.PROTEGO)])
    assert engine.powerup is None
    claimed = [event for event in engine.recent_events if event.type == "powerupClaimed"]
    assert len(claimed) == 1 and claimed[0].actor is Slot.P2 and claimed[0].powerup is PowerupKind.FELIX
    assert engine.players[Slot.P2].lucky and not engine.players[Slot.P1].lucky
    assert engine.powerup_spawn_at_ms is not None and engine.powerup_spawn_at_ms >= 5_000 + POWERUP_GAP_MS[0]


def test_phoenix_feather_resets_every_cooldown():
    engine = _ready_engine(seed=5, variance=True)
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    assert engine.players[Slot.P1].cooldown_until_ms[Spell.INCENDIO] == 13_000
    _with_powerup(PowerupKind.PHOENIX, engine=engine)
    engine.advance(now_ms=5_000, commands=[_cast(4, Slot.P1, 5_000, Spell.STUPEFY)])
    assert engine.players[Slot.P1].cooldown_until_ms == {}
    again = engine.advance(now_ms=5_100, commands=[_cast(5, Slot.P1, 5_100, Spell.INCENDIO)])[0]
    assert again.accepted


def test_bezoar_heals_and_cures():
    engine = _with_powerup(PowerupKind.BEZOAR)
    hurt = engine.players[Slot.P1]
    hurt.hp = 70
    hurt.burn_until_ms = 9_000
    hurt.burn_next_ms = 6_000
    engine.advance(now_ms=5_000, commands=[_cast(3, Slot.P1, 5_000, Spell.STUPEFY)])
    assert hurt.hp == 90 and hurt.burn_until_ms == 0
    healed = [event for event in engine.recent_events if event.type == "healed"]
    assert len(healed) == 1 and healed[0].amount == 20 and healed[0].reason == "bezoar"
    assert _types(engine)[-3:] == ["powerupClaimed", "healed", "projectileLaunched"]


def test_mirror_charm_reflects_the_next_incoming_spell_without_a_guard():
    engine = _with_powerup(PowerupKind.MIRROR)
    engine.advance(now_ms=5_000, commands=[_cast(3, Slot.P2, 5_000, Spell.STUPEFY)])
    assert engine.players[Slot.P2].mirror_until_ms == 5_000 + MIRROR_MS
    engine.advance(now_ms=5_800, commands=[])
    assert engine.players[Slot.P1].hp == 86
    engine.advance(now_ms=6_000, commands=[_cast(4, Slot.P1, 6_000, Spell.INCENDIO)])
    engine.advance(now_ms=7_800, commands=[])
    assert engine.players[Slot.P2].hp == 100 and engine.players[Slot.P2].mirror_until_ms == 0
    reflected = [event for event in engine.recent_events if event.type == "impactReflected"]
    assert len(reflected) == 1 and reflected[0].reason == "mirror"
    assert engine.projectiles[0].target is Slot.P1 and engine.projectiles[0].reflected


def test_time_turner_halves_remaining_and_new_cooldowns_for_a_while():
    engine = _ready_engine(seed=5, variance=True)
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    _with_powerup(PowerupKind.HASTE, at_ms=6_000, engine=engine)
    engine.advance(now_ms=6_000, commands=[_cast(4, Slot.P1, 6_000, Spell.STUPEFY)])
    player = engine.players[Slot.P1]
    assert player.haste_until_ms == 6_000 + HASTE_MS
    # Incendio had 7 s left; Stupefy was set at the full 2.5 s before the claim halved both.
    assert player.cooldown_until_ms[Spell.INCENDIO] == 6_000 + 3_500
    assert player.cooldown_until_ms[Spell.STUPEFY] == 6_000 + 1_250
    engine.advance(now_ms=7_250, commands=[_cast(5, Slot.P1, 7_250, Spell.STUPEFY)])
    assert player.cooldown_until_ms[Spell.STUPEFY] == 7_250 + 1_250
    engine.advance(now_ms=14_000, commands=[_cast(6, Slot.P1, 14_000, Spell.STUPEFY)])
    assert player.cooldown_until_ms[Spell.STUPEFY] == 14_000 + 2_500


def test_pausing_the_timeline_shifts_burns_stuns_and_powerups_together():
    engine = _ready_engine(seed=2, variance=True)
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    engine.advance(now_ms=5_800, commands=[])
    target = engine.players[Slot.P2]
    target.stunned_until_ms = 7_000
    engine.powerup = Powerup(id="r1:u1", kind=PowerupKind.HASTE, spawned_at_ms=5_000, expires_at_ms=15_000)
    spawn_before = engine.powerup_spawn_at_ms
    engine.pause_timeline(after_ms=6_000, elapsed_ms=10_000)
    assert target.burn_next_ms == 16_800 and target.burn_until_ms == 19_800
    assert target.stunned_until_ms == 17_000
    assert engine.powerup is not None and engine.powerup.expires_at_ms == 25_000
    assert engine.powerup_spawn_at_ms == (spawn_before or 0) + 10_000
    engine.advance(now_ms=16_000, commands=[])
    assert target.hp == 78
    engine.advance(now_ms=16_800, commands=[])
    assert target.hp == 75


def test_same_step_lethal_impacts_are_batched_into_draw():
    engine = _ready_engine()
    engine.players[Slot.P1].hp = 14
    engine.players[Slot.P2].hp = 14
    decisions = engine.advance(
        now_ms=4_000,
        commands=[
            _cast(3, Slot.P1, 4_000, Spell.STUPEFY),
            _cast(4, Slot.P2, 4_000, Spell.STUPEFY),
        ],
    )
    assert all(decision.accepted for decision in decisions)
    engine.advance(now_ms=4_850, commands=[])
    assert engine.players[Slot.P1].hp == 0
    assert engine.players[Slot.P2].hp == 0
    assert engine.phase is Phase.RESULT
    assert engine.result is not None
    assert engine.result.outcome is Outcome.DRAW
    assert engine.result.reason == "knockout"


def test_round_deadline_resolves_due_impact_and_discards_later_projectile():
    engine = _ready_engine()
    engine.advance(
        now_ms=DEADLINE_MS - 1_000,
        commands=[_cast(3, Slot.P1, DEADLINE_MS - 1_000, Spell.STUPEFY)],
    )
    engine.advance(now_ms=DEADLINE_MS, commands=[])
    assert engine.players[Slot.P2].hp == 86
    assert engine.result is not None
    assert engine.result.outcome is Outcome.WIN
    assert engine.result.winner is Slot.P1
    assert engine.result.reason == "timeout"
    assert engine.projectiles == []

    later = _ready_engine()
    later.advance(
        now_ms=DEADLINE_MS - 500,
        commands=[_cast(3, Slot.P1, DEADLINE_MS - 500, Spell.STUPEFY)],
    )
    later.advance(now_ms=DEADLINE_MS, commands=[])
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
        now_ms=4_800,
        commands=[AbortCommand(at_ms=4_800, order=4, reason="input_unhealthy")],
    )
    assert engine.players[Slot.P2].hp == 100
    assert engine.projectiles == []
    assert engine.result is not None
    assert engine.result.outcome is Outcome.ABORTED
    assert engine.result.reason == "input_unhealthy"


def test_fault_after_lethal_impact_cannot_replace_knockout_with_abort():
    engine = _ready_engine()
    engine.players[Slot.P2].hp = 14
    engine.advance(
        now_ms=4_000,
        commands=[_cast(3, Slot.P1, 4_000, Spell.STUPEFY)],
    )
    decisions = engine.advance(
        now_ms=4_850,
        commands=[
            AbortCommand(at_ms=4_820, order=4, reason="input_unhealthy"),
            ReadyCommand(5, Slot.P2, 4_820, 5, False),
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
    assert deadline == DEADLINE_MS
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
        now_ms=6_499,
        commands=[_cast(5, Slot.P1, 6_499, Spell.STUPEFY)],
    )[0]
    assert not cooldown.accepted and cooldown.reason == "cooldown"
    boundary = engine.advance(
        now_ms=6_500,
        commands=[_cast(6, Slot.P1, 6_500, Spell.STUPEFY)],
    )[0]
    assert boundary.accepted
    duplicate = engine.advance(
        now_ms=6_600,
        commands=[
            CastCommand(
                command_id=7,
                slot=Slot.P1,
                at_ms=6_600,
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
    assert engine.players[Slot.P1].hp == 100
    assert engine.players[Slot.P1].shield_until_ms == 5_500
    engine.advance(now_ms=6_000, commands=[])
    assert engine.players[Slot.P2].hp == 56
    assert engine.players[Slot.P2].offense_locked_until_ms == 7_600
    assert engine.players[Slot.P2].burn_until_ms == 9_800


@pytest.mark.parametrize("spell", [Spell.STUPEFY, Spell.INCENDIO])
def test_an_early_protego_blocks_each_bolt_and_its_effect(spell):
    engine = _ready_engine()
    impact_at = 4_000 + SPELL_RULES[spell].flight_ms
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, spell)])
    engine.advance(
        now_ms=impact_at,
        commands=[_cast(4, Slot.P2, impact_at - 500, Spell.PROTEGO)],
    )
    assert engine.players[Slot.P2].hp == 100
    assert engine.players[Slot.P2].offense_locked_until_ms == 0
    assert engine.players[Slot.P2].burn_until_ms == 0
    assert engine.players[Slot.P2].shield_until_ms == 0
    assert engine.recent_events[-1].type == "impactBlocked"
    assert engine.projectiles == []


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
    engine.players[Slot.P2].hp = 22
    engine.advance(now_ms=4_000, commands=[_cast(3, Slot.P1, 4_000, Spell.INCENDIO)])
    heal = engine.advance(
        now_ms=5_800, commands=[_cast(4, Slot.P2, 5_800, Spell.EPISKEY)]
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


def test_identical_seeds_and_commands_replay_identically_with_variance():
    def play(seed: int) -> list[tuple]:
        engine = _ready_engine(seed=seed, variance=True)
        for index in range(12):
            at = 4_000 + index * 1_300
            spell = [Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO, Spell.PROTEGO][index % 4]
            slot = Slot.P1 if index % 2 == 0 else Slot.P2
            engine.advance(now_ms=at, commands=[_cast(10 + index, slot, at, spell)])
        engine.advance(now_ms=30_000, commands=[])
        return [(e.type, e.at_ms, e.actor, e.target, e.amount, e.critical, e.powerup) for e in engine.recent_events]

    assert play(21) == play(21)
    assert play(21) != play(22)
