"""Practice Wizard: a paced, adaptive opponent that submits the same spells as a human.

The bot never touches engine state directly. It reads the public snapshot the
human also sees, decides, and returns at most one spell per tick, which the
room submits through the ordinary cast path (cooldowns, locks and evidence
rules apply to it exactly as to a player). Every roll comes from a seeded
generator so a scripted match replays identically.

Fairness rules that keep a voice-and-wand player in the fight:

* The bot matches the human's observed casting tempo (scaled per level and
  clamped), so a player who can only land a spell every six seconds faces a
  rival on a similar clock instead of a machine gun.
* A quick Stupefy bolt lands before Apprentice and Duelist can react; only the
  Master, with a late block, reflects some of them.
* A block is only attempted when it would be an ordinary block; nobody below
  Master stumbles into an accidental reflection.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from phantom_host.duel_engine import SPELL_RULES, DuelEngine
from phantom_host.duel_models import Outcome, Phase, Slot, Spell

BOT_FIRST_ACTION_MS = 3_000
ATTACKS = (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO)
DEFAULT_HUMAN_GAP_MS = 4_500
TEMPO_SAMPLE = 5
ORDINARY_BLOCK_MIN_REMAINING_MS = 450
PERFECT_BLOCK_WINDOW_MS = 300


@dataclass(frozen=True)
class BotLevel:
    name: str
    interval_ms: tuple[int, int]
    tempo: float
    reaction_ms: int
    block_chance: int
    bolt_block_chance: int
    perfect_block: bool
    race_chance: int
    hesitation: int
    heal_at: int
    attack_weights: tuple[int, int, int]
    relic_notice_ms: int


LEVELS: tuple[BotLevel, ...] = (
    BotLevel("Apprentice", (3_500, 8_000), 1.5, 700, 35, 0, False, 30, 25, 35, (60, 20, 20), 2_600),
    BotLevel("Duelist", (2_400, 6_000), 1.05, 500, 55, 0, False, 60, 12, 40, (40, 25, 35), 1_700),
    BotLevel("Master", (1_900, 5_000), 0.85, 300, 60, 20, True, 85, 8, 45, (35, 25, 40), 1_000),
)


class PracticeBot:
    def __init__(self, *, level: int = 2, seed: int = 0, adaptive: bool = True) -> None:
        self.level = max(1, min(len(LEVELS), level))
        self.adaptive = adaptive
        self.seed = seed
        self.round_id = 0
        self.next_action_ms = 0
        self.decisions = 0
        self._rng = random.Random(seed)
        self._threats: dict[str, bool] = {}
        self._adjusted_round = 0

    @property
    def profile(self) -> BotLevel:
        return LEVELS[self.level - 1]

    def choose(self, engine: DuelEngine, now_ms: int) -> Spell | None:
        self._adapt(engine)
        if engine.phase is not Phase.PLAYING:
            return None
        if self.round_id != engine.round_id:
            self.round_id = engine.round_id
            self._rng = random.Random((self.seed * 31 + engine.round_id) & 0xFFFFFFFF)
            self.next_action_ms = engine.countdown_ends_at_ms + BOT_FIRST_ACTION_MS
            self.decisions = 0
            self._threats.clear()
        own = engine.players[Slot.P2]
        rival = engine.players[Slot.P1]
        if now_ms < own.stunned_until_ms:
            return None

        def available(spell: Spell) -> bool:
            return now_ms >= own.cooldown_until_ms.get(spell, 0)

        # Reactive defense runs every tick; it is a reflex, not a turn.
        guard = self._defend(engine, now_ms, available)
        if guard is not None:
            return guard

        if now_ms < self.next_action_ms:
            return None
        profile = self.profile
        # Pacing is an opponent decision, never an extra player or engine cooldown.
        self.next_action_ms = now_ms + self._interval(engine, now_ms)
        self.decisions += 1

        can_attack = now_ms >= own.offense_locked_until_ms
        # A relic is noticed after a moment, so a quick human can still win the race.
        relic_visible = (
            engine.powerup is not None
            and now_ms - engine.powerup.spawned_at_ms >= profile.relic_notice_ms
        )
        if relic_visible and self._rng.randrange(100) < profile.race_chance:
            claim = self._claim(available, can_attack, own.hp, rival, now_ms)
            if claim is not None:
                return claim
        if self._rng.randrange(100) < profile.hesitation:
            return None
        hurt = own.hp <= profile.heal_at or (own.burn_until_ms > now_ms and own.hp <= profile.heal_at + 15)
        if hurt and available(Spell.EPISKEY) and own.hp < 100:
            return Spell.EPISKEY
        if not can_attack:
            return None
        shielded = rival.shield_until_ms > now_ms + 200 or rival.mirror_until_ms > now_ms + 200
        if shielded:
            # Do not waste a bolt into a raised guard; shatter it instead.
            return Spell.EXPELLIARMUS if available(Spell.EXPELLIARMUS) else None
        helpless = rival.offense_locked_until_ms > now_ms or rival.stunned_until_ms > now_ms
        if helpless and available(Spell.INCENDIO):
            return Spell.INCENDIO
        choices = [(spell, weight) for spell, weight in zip(ATTACKS, profile.attack_weights) if available(spell)]
        if not choices:
            return None
        spells = [spell for spell, _ in choices]
        weights = [weight for _, weight in choices]
        return self._rng.choices(spells, weights=weights, k=1)[0]

    def _interval(self, engine: DuelEngine, now_ms: int) -> int:
        """Next decision delay: the human's recent casting tempo, scaled and clamped per level."""
        profile = self.profile
        casts = [
            event.at_ms for event in engine.recent_events
            if event.type == "castAccepted" and event.actor is Slot.P1
            and event.round_id == engine.round_id
        ][-TEMPO_SAMPLE:]
        if len(casts) >= 2:
            gap = (casts[-1] - casts[0]) / (len(casts) - 1)
        else:
            gap = DEFAULT_HUMAN_GAP_MS
        if casts:
            # A player who has gone quiet is met at their silence, not punished for it.
            gap = max(gap, now_ms - casts[-1])
        low, high = profile.interval_ms
        interval = max(low, min(high, gap * profile.tempo))
        jitter = 1 + (self._rng.random() - 0.5) * 0.3
        return int(max(low, min(high, interval * jitter)))

    def _defend(self, engine: DuelEngine, now_ms: int, available) -> Spell | None:
        own = engine.players[Slot.P2]
        if own.mirror_until_ms > now_ms or own.shield_until_ms > now_ms:
            return None
        profile = self.profile
        for projectile in engine.projectiles:
            if projectile.target is not Slot.P2:
                continue
            if now_ms - projectile.launch_at_ms < profile.reaction_ms:
                continue
            if projectile.id not in self._threats:
                # One roll per incoming spell; the bot sometimes simply misses it.
                chance = profile.bolt_block_chance if projectile.spell is Spell.STUPEFY else profile.block_chance
                self._threats[projectile.id] = self._rng.randrange(100) < chance
            if not self._threats[projectile.id] or not available(Spell.PROTEGO):
                continue
            remaining = projectile.impact_at_ms - now_ms
            if profile.perfect_block and projectile.spell is not Spell.EXPELLIARMUS:
                # The Master waits for the late window and sends the spell back.
                if 50 <= remaining <= PERFECT_BLOCK_WINDOW_MS:
                    return Spell.PROTEGO
                continue
            # Everyone else raises early enough for an ordinary block, or not at all.
            if ORDINARY_BLOCK_MIN_REMAINING_MS <= remaining <= 900:
                return Spell.PROTEGO
        if len(self._threats) > 64:
            self._threats = dict(list(self._threats.items())[-32:])
        return None

    def _claim(self, available, can_attack: bool, hp: int, rival, now_ms: int) -> Spell | None:
        # Any accepted cast claims the powerup; prefer one that also matters.
        if can_attack:
            if rival.shield_until_ms > now_ms and available(Spell.EXPELLIARMUS):
                return Spell.EXPELLIARMUS
            for spell in (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO):
                if available(spell):
                    return spell
        if hp < 100 and available(Spell.EPISKEY):
            return Spell.EPISKEY
        if available(Spell.PROTEGO):
            return Spell.PROTEGO
        return None

    def _adapt(self, engine: DuelEngine) -> None:
        if (
            not self.adaptive
            or engine.phase is not Phase.RESULT
            or engine.result is None
            or engine.result.outcome is not Outcome.WIN
            or self._adjusted_round == engine.round_id
        ):
            return
        self._adjusted_round = engine.round_id
        # A beaten wizard studies harder; a beaten learner gets a gentler rival.
        if engine.result.winner is Slot.P1:
            self.level = min(len(LEVELS), self.level + 1)
        else:
            self.level = max(1, self.level - 1)


__all__ = ["ATTACKS", "BOT_FIRST_ACTION_MS", "LEVELS", "BotLevel", "PracticeBot", "SPELL_RULES"]
