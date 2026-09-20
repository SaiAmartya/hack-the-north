"""Server-owned, effect-confirmed lessons around the ordinary combat engine."""

from phantom_host.duel_bot import BOT_FIRST_ACTION_MS, PracticeBot
from phantom_host.duel_engine import MAX_HP, SPELL_RULES, DuelEngine
from phantom_host.duel_models import Phase, Slot, Spell, TutorialSnapshot

LESSONS = (
    Spell.STUPEFY, Spell.PROTEGO, Spell.EPISKEY,
    Spell.EXPELLIARMUS, Spell.INCENDIO,
)
FREE_DUEL_MS = 45_000


class TutorialDuel:
    def __init__(self, now_ms: int, *, seed: int = 0, variance: bool = True) -> None:
        self.seed = seed
        self.variance = variance
        self.round_id = 0
        self.step = 0
        self.stage = "instruction"
        self.last_tick_ms = now_ms
        self.next_attack_ms = 0
        self.checkpoint_hp = MAX_HP
        self.protego_misses = 0
        self._seen_events: set[str] = set()
        self._free_bot = self._new_free_bot()

    @property
    def paused(self) -> bool:
        return self.stage in ("instruction", "complete")

    @property
    def spell(self) -> Spell | None:
        return LESSONS[self.step] if self.step < len(LESSONS) else None

    def snapshot(self) -> TutorialSnapshot:
        return TutorialSnapshot(
            step=self.step, spell=self.spell, stage=self.stage, paused=self.paused,
        )

    def before_advance(self, engine: DuelEngine, now_ms: int) -> None:
        if self.round_id != engine.round_id:
            self._new_round(engine, now_ms)
        # Lessons are deterministic; only the closing duel rolls crits, stuns and powerups.
        engine.variance = self.stage == "free" and self.variance
        if engine.phase is Phase.PLAYING and self.stage != "free":
            if self.paused:
                engine.pause_timeline(
                    after_ms=self.last_tick_ms,
                    elapsed_ms=max(0, now_ms - self.last_tick_ms),
                )
        self.last_tick_ms = now_ms

    def after_advance(self, engine: DuelEngine, now_ms: int) -> None:
        if self.round_id != engine.round_id:
            self._new_round(engine, now_ms)
        events = [event for event in engine.recent_events if event.id not in self._seen_events]
        self._seen_events = {event.id for event in engine.recent_events}
        if engine.phase is not Phase.PLAYING or self.stage != "practice":
            return
        for event in events:
            succeeded = (
                self.spell in (Spell.STUPEFY, Spell.INCENDIO)
                and event.type == "damage" and event.actor is Slot.P1
                and event.spell is self.spell
            ) or (
                self.spell is Spell.PROTEGO
                and event.type in ("impactBlocked", "impactReflected")
                and event.target is Slot.P1
            ) or (
                self.spell is Spell.EPISKEY and event.type == "healed"
                and event.actor is Slot.P1 and (event.amount or 0) > 0
            ) or (
                self.spell is Spell.EXPELLIARMUS and event.type == "offenseLocked"
                and event.actor is Slot.P1
            )
            if succeeded:
                self.stage = "complete"
                engine.state_version += 1
                return
            if self.spell is Spell.PROTEGO and event.type == "damage" and event.target is Slot.P1:
                # A miss pauses at the visible real damage. Continue retries from
                # the checkpoint instead of letting repeated attempts kill the learner.
                self.protego_misses += 1
                self.stage = "instruction"
                engine.state_version += 1
                return

    def continue_lesson(self, engine: DuelEngine, now_ms: int) -> str | None:
        self.before_advance(engine, now_ms)
        if self.stage == "complete":
            self.step += 1
            self.stage = "instruction"
        elif self.stage == "instruction":
            if self.step == len(LESSONS):
                self.stage = "free"
                engine.variance = self.variance
                engine.restore_training_checkpoint(
                    health={Slot.P1: MAX_HP, Slot.P2: MAX_HP}, clear_effects=True,
                )
                engine.round_ends_at_ms = now_ms + FREE_DUEL_MS
                engine.schedule_powerups(now_ms=now_ms)
                self._free_bot = self._new_free_bot()
                self._free_bot.round_id = engine.round_id
                self._free_bot.next_action_ms = now_ms + BOT_FIRST_ACTION_MS
            else:
                self.stage = "practice"
                if self.spell is Spell.PROTEGO:
                    engine.restore_training_checkpoint(health={Slot.P1: self.checkpoint_hp})
                else:
                    self.checkpoint_hp = engine.players[Slot.P1].hp
                self.next_attack_ms = now_ms + 1_500
                self._seen_events = {event.id for event in engine.recent_events}
        else:
            return "tutorial_not_paused"
        engine.state_version += 1
        return None

    def cast_rejection(self, engine: DuelEngine, spell: Spell) -> str | None:
        if self.paused:
            return "tutorial_paused"
        if self.stage == "practice" and spell is not self.spell:
            return "tutorial_spell_required"
        if self.stage == "practice" and any(p.caster is Slot.P1 for p in engine.projectiles):
            return "tutorial_wait_for_effect"
        return None

    def choose(self, engine: DuelEngine, now_ms: int) -> Spell | None:
        if engine.phase is not Phase.PLAYING:
            return None
        if self.stage == "free":
            return self._free_bot.choose(engine, now_ms)
        if self.stage != "practice" or self.spell not in (Spell.PROTEGO, Spell.EPISKEY):
            return None
        if any(p.caster is Slot.P2 for p in engine.projectiles):
            return None
        rival = engine.players[Slot.P2]
        learner = engine.players[Slot.P1]

        def ready(spell: Spell) -> bool:
            return now_ms >= rival.cooldown_until_ms.get(spell, 0)

        if self.spell is Spell.PROTEGO:
            if self.protego_misses:
                # After a miss, the rival waits for a raised shield and fires into it,
                # so the retry teaches the cast itself rather than raw reaction time.
                if learner.shield_until_ms - now_ms < SPELL_RULES[Spell.STUPEFY].flight_ms + 100:
                    return None
                return Spell.STUPEFY if ready(Spell.STUPEFY) else None
            # First attempt: a slow, visible fireball to block on reaction.
            if now_ms < self.next_attack_ms or not ready(Spell.INCENDIO):
                return None
            self.next_attack_ms = now_ms + 6_000
            return Spell.INCENDIO
        if learner.hp < MAX_HP:
            return None
        if now_ms < self.next_attack_ms or not ready(Spell.STUPEFY):
            return None
        self.next_attack_ms = now_ms + 5_000
        return Spell.STUPEFY

    def _new_free_bot(self) -> PracticeBot:
        return PracticeBot(level=1, seed=self.seed, adaptive=False)

    def _new_round(self, engine: DuelEngine, now_ms: int) -> None:
        self.round_id = engine.round_id
        self.step = 0
        self.stage = "instruction"
        self.last_tick_ms = now_ms
        self.next_attack_ms = 0
        self.checkpoint_hp = MAX_HP
        self.protego_misses = 0
        self._seen_events = {event.id for event in engine.recent_events}
        self._free_bot = self._new_free_bot()
