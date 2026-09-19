"""The deterministic duel engine. This module is the only authority on health,
mana, cooldowns, match phase, and the winner.

Design rules:

* Nothing here touches the network, the clock, or the badges. Every function
  takes an explicit ``now_ms`` so the whole match is replayable and testable.
* Functions mutate the ``ArenaState`` passed in and return a list of ``Effect``
  describing what just happened, for the client to animate.
* Rejections are returned as effects rather than raised. A cast during cooldown
  is normal gameplay, not an error.
"""

from __future__ import annotations

from dataclasses import dataclass

from phantom_host.contracts import (
    ArenaDirective,
    ArenaState,
    Effect,
    PlayerId,
    PlayerState,
    RadioEvent,
)

HEALTH_MAX = 100
MANA_MAX = 100.0
MANA_REGEN_PER_SECOND = 8.0
COUNTDOWN_MS = 3000

METEOR_DAMAGE = 12
MANA_RAIN_AMOUNT = 40.0
DIRECTIVE_MIN_MS = 3000
DIRECTIVE_MAX_MS = 8000

PLAYER_IDS: tuple[PlayerId, PlayerId] = ("P1", "P2")


@dataclass(frozen=True)
class SpellRule:
    cost: int
    damage: int
    cooldown_ms: int
    shield_ms: int = 0


SPELL_RULES: dict[str, SpellRule] = {
    "F": SpellRule(cost=20, damage=18, cooldown_ms=900),
    "S": SpellRule(cost=15, damage=0, cooldown_ms=1400, shield_ms=1200),
    "A": SpellRule(cost=10, damage=10, cooldown_ms=500),
    "U": SpellRule(cost=60, damage=35, cooldown_ms=5000),
}

# Judge badge packet values mapped to arena modifiers.
EVENT_MODIFIERS: dict[str, str] = {
    "MET": "meteor",
    "MANA": "mana_rain",
    "DBL": "double_damage",
}
RESET_VALUE = "RST"
DEFAULT_MODIFIER_MS = 5000


# ---------------------------------------------------------------------------
# construction
# ---------------------------------------------------------------------------


def new_match(now_ms: int) -> ArenaState:
    return ArenaState(
        phase="lobby",
        players={
            player_id: PlayerState(id=player_id, health=HEALTH_MAX, mana=MANA_MAX)
            for player_id in PLAYER_IDS
        },
        last_tick_ms=now_ms,
    )


def reset_match(state: ArenaState, now_ms: int) -> list[Effect]:
    """Return an in-progress or finished match to a fresh lobby, in place."""
    fresh = new_match(now_ms)
    state.phase = fresh.phase
    state.players = fresh.players
    state.modifier = "none"
    state.modifier_until_ms = 0
    state.countdown_ends_ms = 0
    state.started_at_ms = 0
    state.last_tick_ms = now_ms
    state.winner = None
    return [Effect(type="phase", note="lobby")]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _opponent(player_id: str) -> PlayerId:
    return "P2" if player_id == "P1" else "P1"


def _is_player(sender: str) -> bool:
    return sender in PLAYER_IDS


def _modifier_active(state: ArenaState, now_ms: int) -> bool:
    return state.modifier != "none" and now_ms < state.modifier_until_ms


def _reject(player: str | None, value: str | None, note: str) -> list[Effect]:
    return [
        Effect(
            type="reject",
            player=player if _is_player(player or "") else None,  # type: ignore[arg-type]
            spell=value,
            note=note,
        )
    ]


def _finish(state: ArenaState, winner: PlayerId) -> list[Effect]:
    state.phase = "finished"
    state.winner = winner
    return [
        Effect(type="win", player=winner),
        Effect(type="phase", note="finished"),
    ]


def _damage(
    state: ArenaState,
    target_id: PlayerId,
    amount: int,
    now_ms: int,
    *,
    floor_at: int = 0,
    lethal: bool = True,
) -> list[Effect]:
    """Apply damage, honouring a live shield. Returns the resulting effects."""
    target = state.players[target_id]

    if target.shield_until_ms > now_ms:
        # A shield absorbs exactly one incoming spell and is then consumed, so
        # clear it rather than letting the timestamp absorb a second hit.
        target.shield_until_ms = 0
        return [Effect(type="shield_absorb", player=target_id)]

    target.health = max(floor_at, target.health - amount)
    effects = [Effect(type="damage", player=target_id, amount=amount)]

    if lethal and target.health == 0:
        effects.extend(_finish(state, _opponent(target_id)))
    return effects


# ---------------------------------------------------------------------------
# event application
# ---------------------------------------------------------------------------


def apply_event(state: ArenaState, event: RadioEvent, now_ms: int) -> list[Effect]:
    """Fold one de-duplicated radio packet into the match."""
    if event.kind == "READY":
        return _apply_ready(state, event, now_ms)
    if event.kind == "EVT":
        return _apply_judge_event(state, event, now_ms)
    if event.kind == "CAST":
        return _apply_cast(state, event, now_ms)
    return _reject(event.sender, event.value, "unknown_kind")


def _apply_ready(state: ArenaState, event: RadioEvent, now_ms: int) -> list[Effect]:
    if not _is_player(event.sender):
        return _reject(event.sender, event.value, "not_a_player")
    if state.phase != "lobby":
        return _reject(event.sender, event.value, "phase")

    player = state.players[event.sender]
    if player.ready:
        return []

    player.ready = True
    effects = [Effect(type="ready", player=player.id)]

    if all(state.players[player_id].ready for player_id in PLAYER_IDS):
        state.phase = "countdown"
        state.countdown_ends_ms = now_ms + COUNTDOWN_MS
        effects.append(Effect(type="phase", note="countdown"))
    return effects


def _apply_judge_event(
    state: ArenaState, event: RadioEvent, now_ms: int
) -> list[Effect]:
    if event.value == RESET_VALUE:
        return reset_match(state, now_ms)

    modifier = EVENT_MODIFIERS.get(event.value)
    if modifier is None:
        return _reject(None, event.value, "unknown_event")
    if state.phase != "playing":
        return _reject(None, event.value, "phase")

    return _activate_modifier(state, modifier, DEFAULT_MODIFIER_MS, now_ms)


def _apply_cast(state: ArenaState, event: RadioEvent, now_ms: int) -> list[Effect]:
    if not _is_player(event.sender):
        return _reject(event.sender, event.value, "not_a_player")
    if state.phase != "playing":
        return _reject(event.sender, event.value, "phase")

    rule = SPELL_RULES.get(event.value)
    if rule is None:
        return _reject(event.sender, event.value, "unknown_spell")

    caster = state.players[event.sender]
    if caster.cooldown_until_ms.get(event.value, 0) > now_ms:
        return _reject(event.sender, event.value, "cooldown")
    if caster.mana < rule.cost:
        return _reject(event.sender, event.value, "mana")

    caster.mana = max(0.0, caster.mana - rule.cost)
    caster.cooldown_until_ms[event.value] = now_ms + rule.cooldown_ms
    caster.last_spell = event.value
    effects = [Effect(type="cast", player=caster.id, spell=event.value)]

    if rule.shield_ms:
        caster.shield_until_ms = now_ms + rule.shield_ms

    if rule.damage:
        amount = rule.damage
        if state.modifier == "double_damage" and _modifier_active(state, now_ms):
            amount *= 2
        effects.extend(_damage(state, _opponent(caster.id), amount, now_ms))

    return effects


# ---------------------------------------------------------------------------
# modifiers
# ---------------------------------------------------------------------------


def _activate_modifier(
    state: ArenaState, modifier: str, duration_ms: int, now_ms: int
) -> list[Effect]:
    state.modifier = modifier  # type: ignore[assignment]
    state.modifier_until_ms = now_ms + duration_ms
    effects: list[Effect] = [Effect(type="modifier", note=modifier)]

    if modifier == "meteor":
        # Meteor floors at 1 health on purpose: a simultaneous double knockout
        # would leave the match with no winner, and the demo promises exactly one.
        for player_id in PLAYER_IDS:
            effects.extend(
                _damage(
                    state,
                    player_id,
                    METEOR_DAMAGE,
                    now_ms,
                    floor_at=1,
                    lethal=False,
                )
            )
    elif modifier == "mana_rain":
        for player_id in PLAYER_IDS:
            player = state.players[player_id]
            player.mana = min(MANA_MAX, player.mana + MANA_RAIN_AMOUNT)

    return effects


def apply_directive(
    state: ArenaState, directive: ArenaDirective, now_ms: int
) -> list[Effect]:
    """The single gate the OpenAI Director must pass through.

    The directive model already validates itself, so this re-check is defence in
    depth: the engine, not the model, decides what can touch the match.
    """
    if state.phase != "playing":
        return []
    if directive.modifier not in EVENT_MODIFIERS.values():
        return []
    if not DIRECTIVE_MIN_MS <= directive.duration_ms <= DIRECTIVE_MAX_MS:
        return []

    return _activate_modifier(state, directive.modifier, directive.duration_ms, now_ms)


# ---------------------------------------------------------------------------
# time
# ---------------------------------------------------------------------------


def tick(state: ArenaState, now_ms: int) -> list[Effect]:
    """Advance time. Safe to call at any cadence, including irregularly."""
    elapsed_ms = max(0, now_ms - state.last_tick_ms)
    state.last_tick_ms = now_ms
    effects: list[Effect] = []

    if state.phase == "countdown" and now_ms >= state.countdown_ends_ms:
        state.phase = "playing"
        state.started_at_ms = now_ms
        effects.append(Effect(type="phase", note="playing"))

    if state.phase == "playing" and elapsed_ms:
        regen = MANA_REGEN_PER_SECOND * (elapsed_ms / 1000.0)
        for player in state.players.values():
            # Quantize to kill floating point drift: ten 100 ms ticks must sum to
            # exactly 8.0, not 7.999999999999999, or the displayed int floors to 7.
            player.mana = round(min(MANA_MAX, player.mana + regen), 3)

    if state.modifier != "none" and now_ms >= state.modifier_until_ms:
        state.modifier = "none"
        state.modifier_until_ms = 0
        effects.append(Effect(type="modifier", note="none"))

    return effects
