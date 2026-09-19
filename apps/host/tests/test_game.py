from phantom_host.contracts import ArenaDirective, ArenaState, Effect, RadioEvent
from phantom_host.game import (
    COUNTDOWN_MS,
    MANA_REGEN_PER_SECOND,
    METEOR_DAMAGE,
    SPELL_RULES,
    apply_directive,
    apply_event,
    new_match,
    tick,
)

T0 = 100_000


def cast(spell: str, sender: str = "P1", at: int = T0, sequence: int = 1) -> RadioEvent:
    return RadioEvent(
        sender=sender,  # type: ignore[arg-type]
        kind="CAST",
        value=spell,
        sequence=sequence,
        received_at_ms=at,
    )


def ready(sender: str, at: int = T0, sequence: int = 1) -> RadioEvent:
    return RadioEvent(
        sender=sender,  # type: ignore[arg-type]
        kind="READY",
        value="1",
        sequence=sequence,
        received_at_ms=at,
    )


def judge(value: str, at: int = T0, sequence: int = 1) -> RadioEvent:
    return RadioEvent(
        sender="J", kind="EVT", value=value, sequence=sequence, received_at_ms=at
    )


def types_of(effects: list[Effect]) -> list[str]:
    return [effect.type for effect in effects]


def playing_match(at: int = T0) -> ArenaState:
    """A match already in the playing phase, both players untouched."""
    state = new_match(at)
    apply_event(state, ready("P1", at=at), at)
    apply_event(state, ready("P2", at=at), at)
    tick(state, at + COUNTDOWN_MS)
    assert state.phase == "playing"
    return state


# --------------------------------------------------------------------------
# phase machine
# --------------------------------------------------------------------------


def test_new_match_starts_in_lobby_at_full_health_and_mana() -> None:
    state = new_match(T0)
    assert state.phase == "lobby"
    assert state.winner is None
    assert state.modifier == "none"
    for player in state.players.values():
        assert player.health == 100
        assert player.mana == 100
        assert player.ready is False


def test_one_ready_does_not_start_the_countdown() -> None:
    state = new_match(T0)
    effects = apply_event(state, ready("P1"), T0)
    assert state.phase == "lobby"
    assert state.players["P1"].ready is True
    assert state.players["P2"].ready is False
    assert "ready" in types_of(effects)


def test_both_ready_starts_a_countdown_then_tick_starts_play() -> None:
    state = new_match(T0)
    apply_event(state, ready("P1"), T0)
    effects = apply_event(state, ready("P2"), T0)
    assert state.phase == "countdown"
    assert state.countdown_ends_ms == T0 + COUNTDOWN_MS
    assert "phase" in types_of(effects)

    # Still counting down one millisecond early.
    tick(state, T0 + COUNTDOWN_MS - 1)
    assert state.phase == "countdown"

    effects = tick(state, T0 + COUNTDOWN_MS)
    assert state.phase == "playing"
    assert state.started_at_ms == T0 + COUNTDOWN_MS
    assert "phase" in types_of(effects)


def test_ready_is_ignored_outside_lobby() -> None:
    state = playing_match()
    effects = apply_event(state, ready("P1", at=T0 + 9000), T0 + 9000)
    assert types_of(effects) == ["reject"]


def test_a_judge_ready_packet_is_rejected() -> None:
    state = new_match(T0)
    event = RadioEvent(
        sender="J", kind="READY", value="1", sequence=1, received_at_ms=T0
    )
    effects = apply_event(state, event, T0)
    assert types_of(effects) == ["reject"]
    assert state.phase == "lobby"


# --------------------------------------------------------------------------
# casting
# --------------------------------------------------------------------------


def test_a_valid_fireball_costs_mana_and_deals_damage() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    effects = apply_event(state, cast("F", at=now), now)

    assert state.players["P2"].health == 100 - SPELL_RULES["F"].damage
    assert state.players["P1"].mana == 100 - SPELL_RULES["F"].cost
    assert state.players["P1"].last_spell == "F"
    assert state.players["P1"].cooldown_until_ms["F"] == now + SPELL_RULES["F"].cooldown_ms
    assert types_of(effects) == ["cast", "damage"]


def test_a_shield_absorbs_exactly_one_spell_and_is_consumed() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS

    apply_event(state, cast("S", sender="P2", at=now), now)
    assert state.players["P2"].shield_until_ms == now + SPELL_RULES["S"].shield_ms

    effects = apply_event(state, cast("F", sender="P1", at=now + 10), now + 10)
    assert state.players["P2"].health == 100, "shield should negate the first hit"
    assert "shield_absorb" in types_of(effects)
    assert state.players["P2"].shield_until_ms == 0, "shield must be consumed"

    # Second Fireball lands. P1's F is on cooldown, so use Arc Slash.
    effects = apply_event(state, cast("A", sender="P1", at=now + 20), now + 20)
    assert state.players["P2"].health == 100 - SPELL_RULES["A"].damage
    assert "damage" in types_of(effects)


def test_a_shield_expires_on_its_own_without_absorbing() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, cast("S", sender="P2", at=now), now)

    later = now + SPELL_RULES["S"].shield_ms + 1
    tick(state, later)
    effects = apply_event(state, cast("F", sender="P1", at=later), later)
    assert state.players["P2"].health == 100 - SPELL_RULES["F"].damage
    assert "shield_absorb" not in types_of(effects)


def test_insufficient_mana_is_rejected() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P1"].mana = 10  # Ultimate costs 60.

    effects = apply_event(state, cast("U", at=now), now)
    assert types_of(effects) == ["reject"]
    assert effects[0].note == "mana"
    assert state.players["P2"].health == 100
    assert state.players["P1"].mana == 10


def test_a_spell_on_cooldown_is_rejected() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, cast("F", at=now), now)

    during = now + SPELL_RULES["F"].cooldown_ms - 1
    effects = apply_event(state, cast("F", at=during, sequence=2), during)
    assert types_of(effects) == ["reject"]
    assert effects[0].note == "cooldown"
    assert state.players["P2"].health == 100 - SPELL_RULES["F"].damage


def test_a_spell_is_castable_again_once_the_cooldown_passes() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, cast("F", at=now), now)

    after = now + SPELL_RULES["F"].cooldown_ms
    tick(state, after)
    effects = apply_event(state, cast("F", at=after, sequence=2), after)
    assert "damage" in types_of(effects)


def test_an_unknown_spell_is_rejected() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    effects = apply_event(state, cast("Z", at=now), now)
    assert types_of(effects) == ["reject"]
    assert effects[0].note == "unknown_spell"


def test_casting_before_the_match_starts_is_rejected() -> None:
    state = new_match(T0)
    effects = apply_event(state, cast("F"), T0)
    assert types_of(effects) == ["reject"]
    assert effects[0].note == "phase"
    assert state.players["P2"].health == 100


def test_a_finished_match_rejects_further_casts() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P2"].health = 5

    effects = apply_event(state, cast("F", at=now), now)
    assert state.phase == "finished"
    assert state.winner == "P1"
    assert state.players["P2"].health == 0
    assert "win" in types_of(effects)

    later = now + 5000
    effects = apply_event(state, cast("A", at=later, sequence=2), later)
    assert types_of(effects) == ["reject"]
    assert effects[0].note == "phase"
    assert state.winner == "P1"


def test_health_never_goes_below_zero() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P2"].health = 1
    apply_event(state, cast("U", at=now), now)
    assert state.players["P2"].health == 0


# --------------------------------------------------------------------------
# mana regeneration
# --------------------------------------------------------------------------


def test_mana_regenerates_across_ten_hundred_millisecond_ticks() -> None:
    """The bug this guards: 8 mana/s on a 10 Hz tick is 0.8, which an int
    accumulator would floor to 0 every tick, so mana would never regenerate."""
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P1"].mana = 0

    for step in range(1, 11):
        tick(state, now + step * 100)

    # Exactly one second of regeneration, with no floating point drift.
    assert state.players["P1"].mana == MANA_REGEN_PER_SECOND
    assert state.players["P1"].model_dump()["mana"] == 8


def test_fractional_mana_accumulates_and_displays_as_a_floor() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P1"].mana = 0

    tick(state, now + 100)
    assert state.players["P1"].mana == 0.8
    assert state.players["P1"].model_dump()["mana"] == 0

    tick(state, now + 200)
    assert state.players["P1"].mana == 1.6
    assert state.players["P1"].model_dump()["mana"] == 1


def test_displayed_mana_never_overstates_what_the_player_can_afford() -> None:
    """Flooring matters: showing 20 while holding 19.6 would reject a legal cast."""
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P1"].mana = 19.6

    assert state.players["P1"].model_dump()["mana"] == 19
    effects = apply_event(state, cast("F", at=now), now)
    assert types_of(effects) == ["reject"]
    assert effects[0].note == "mana"


def test_mana_is_capped_at_one_hundred() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    tick(state, now + 60_000)
    assert state.players["P1"].mana == 100


def test_mana_does_not_regenerate_outside_the_playing_phase() -> None:
    state = new_match(T0)
    state.players["P1"].mana = 50
    tick(state, T0 + 10_000)
    assert state.players["P1"].mana == 50


# --------------------------------------------------------------------------
# judge events and modifiers
# --------------------------------------------------------------------------


def test_meteor_damages_both_players_but_cannot_end_the_match() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    effects = apply_event(state, judge("MET", at=now), now)

    assert state.modifier == "meteor"
    assert state.players["P1"].health == 100 - METEOR_DAMAGE
    assert state.players["P2"].health == 100 - METEOR_DAMAGE
    assert "modifier" in types_of(effects)
    assert state.phase == "playing"


def test_meteor_floors_at_one_health_so_there_is_never_a_double_knockout() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P1"].health = 3
    state.players["P2"].health = 2

    apply_event(state, judge("MET", at=now), now)
    assert state.players["P1"].health == 1
    assert state.players["P2"].health == 1
    assert state.phase == "playing"
    assert state.winner is None


def test_meteor_is_absorbed_by_a_live_shield() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, cast("S", sender="P2", at=now), now)

    apply_event(state, judge("MET", at=now + 10), now + 10)
    assert state.players["P2"].health == 100
    assert state.players["P2"].shield_until_ms == 0
    assert state.players["P1"].health == 100 - METEOR_DAMAGE


def test_mana_rain_refills_both_players() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P1"].mana = 0
    state.players["P2"].mana = 90

    apply_event(state, judge("MANA", at=now), now)
    assert state.modifier == "mana_rain"
    assert state.players["P1"].mana == 40
    assert state.players["P2"].mana == 100


def test_double_damage_doubles_a_fireball() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, judge("DBL", at=now), now)
    assert state.modifier == "double_damage"

    apply_event(state, cast("F", at=now + 10), now + 10)
    assert state.players["P2"].health == 100 - (SPELL_RULES["F"].damage * 2)


def test_double_damage_stops_applying_once_it_expires() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, judge("DBL", at=now), now)

    expiry = state.modifier_until_ms
    effects = tick(state, expiry + 1)
    assert state.modifier == "none"
    assert "modifier" in types_of(effects)

    apply_event(state, cast("F", at=expiry + 2), expiry + 2)
    assert state.players["P2"].health == 100 - SPELL_RULES["F"].damage


def test_an_unknown_judge_event_is_rejected() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    effects = apply_event(state, judge("WAT", at=now), now)
    assert types_of(effects) == ["reject"]
    assert state.modifier == "none"


def test_a_modifier_outside_the_playing_phase_is_rejected() -> None:
    state = new_match(T0)
    effects = apply_event(state, judge("MET"), T0)
    assert types_of(effects) == ["reject"]
    assert state.modifier == "none"


def test_reset_returns_a_finished_match_to_lobby() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    state.players["P2"].health = 1
    apply_event(state, cast("F", at=now), now)
    assert state.phase == "finished"

    effects = apply_event(state, judge("RST", at=now + 100), now + 100)
    assert state.phase == "lobby"
    assert state.winner is None
    assert state.players["P1"].health == 100
    assert state.players["P2"].health == 100
    assert state.players["P1"].ready is False
    assert state.modifier == "none"
    assert "phase" in types_of(effects)


def test_reset_works_from_mid_match_too() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    apply_event(state, cast("F", at=now), now)
    apply_event(state, judge("RST", at=now + 50), now + 50)
    assert state.phase == "lobby"
    assert state.players["P2"].health == 100


def test_a_full_duel_reaches_zero_and_declares_one_winner() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    sequence = 0

    for step in range(400):
        moment = now + step * 100
        tick(state, moment)
        if state.phase != "playing":
            break
        sequence = (sequence + 1) % 256
        apply_event(state, cast("F", at=moment, sequence=sequence), moment)

    assert state.phase == "finished"
    assert state.winner == "P1"
    assert state.players["P2"].health == 0
    assert state.players["P1"].health == 100


# --------------------------------------------------------------------------
# director directives
# --------------------------------------------------------------------------


def test_a_valid_directive_is_applied() -> None:
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    directive = ArenaDirective(
        modifier="double_damage", duration_ms=5000, commentary="Gloves off"
    )
    effects = apply_directive(state, directive, now)

    assert state.modifier == "double_damage"
    assert state.modifier_until_ms == now + 5000
    assert "modifier" in types_of(effects)


def test_a_directive_is_ignored_outside_the_playing_phase() -> None:
    state = new_match(T0)
    directive = ArenaDirective(
        modifier="meteor", duration_ms=5000, commentary="Rocks fall"
    )
    assert apply_directive(state, directive, T0) == []
    assert state.modifier == "none"


def test_a_directive_duration_outside_the_allowed_band_is_ignored() -> None:
    """Defence in depth: the engine re-checks what the model already validated."""
    state = playing_match()
    now = T0 + COUNTDOWN_MS
    directive = ArenaDirective(
        modifier="meteor", duration_ms=5000, commentary="Rocks fall"
    )
    object.__setattr__(directive, "duration_ms", 999_999)

    assert apply_directive(state, directive, now) == []
    assert state.modifier == "none"
