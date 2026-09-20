"""A gentle practice partner that casts ordinary Stupefy at a predictable pace."""

from phantom_host.duel_engine import DuelEngine
from phantom_host.duel_models import Phase, Slot, Spell

BOT_FIRST_ACTION_MS = 12_000
BOT_ACTION_INTERVAL_MS = 12_000


class PracticeBot:
    def __init__(self) -> None:
        self.round_id = 0
        self.next_action_ms = 0

    def choose(self, engine: DuelEngine, now_ms: int) -> Spell | None:
        if engine.phase is not Phase.PLAYING:
            return None
        if self.round_id != engine.round_id:
            self.round_id = engine.round_id
            self.next_action_ms = engine.countdown_ends_at_ms + BOT_FIRST_ACTION_MS
        if now_ms < self.next_action_ms:
            return None
        # Pacing is an opponent decision, never an extra player or engine cooldown.
        self.next_action_ms = now_ms + BOT_ACTION_INTERVAL_MS
        own = engine.players[Slot.P2]
        if now_ms < own.offense_locked_until_ms:
            return None
        if now_ms < own.cooldown_until_ms.get(Spell.STUPEFY, 0):
            return None
        return Spell.STUPEFY
