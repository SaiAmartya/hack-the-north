"""A deliberately paced opponent that submits the same spells as a human player."""

from phantom_host.duel_engine import DuelEngine
from phantom_host.duel_models import Phase, Slot, Spell

BOT_FIRST_ACTION_MS = 3_000
BOT_ACTION_INTERVAL_MS = 1_800
ATTACKS = (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO)


class PracticeBot:
    def __init__(self) -> None:
        self.round_id = 0
        self.next_action_ms = 0
        self.attack_index = 0
        self.decisions = 0

    def choose(self, engine: DuelEngine, now_ms: int) -> Spell | None:
        if engine.phase is not Phase.PLAYING:
            return None
        if self.round_id != engine.round_id:
            self.round_id = engine.round_id
            self.next_action_ms = engine.countdown_ends_at_ms + BOT_FIRST_ACTION_MS
            self.attack_index = 0
            self.decisions = 0
        if now_ms < self.next_action_ms:
            return None
        # Pacing is an opponent decision, never an extra player or engine cooldown.
        self.next_action_ms = now_ms + BOT_ACTION_INTERVAL_MS
        self.decisions += 1
        own = engine.players[Slot.P2]

        def available(spell: Spell) -> bool:
            return now_ms >= own.cooldown_until_ms.get(spell, 0)

        threat = any(
            projectile.target is Slot.P2
            and now_ms - projectile.launch_at_ms >= 400
            and 200 <= projectile.impact_at_ms - now_ms <= 900
            for projectile in engine.projectiles
        )
        # It reacts to visible flight, checks only on its turn, and sometimes misses.
        if threat and self.decisions % 3 != 0 and available(Spell.PROTEGO):
            return Spell.PROTEGO
        if own.hp <= 65 and available(Spell.EPISKEY):
            return Spell.EPISKEY
        if now_ms < own.offense_locked_until_ms:
            return None
        for _ in ATTACKS:
            spell = ATTACKS[self.attack_index % len(ATTACKS)]
            self.attack_index += 1
            if available(spell):
                return spell
        return None
