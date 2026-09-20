"""Practice Wizard behaviour against the pure engine, without a room or sockets."""

from phantom_host.duel_bot import BOT_FIRST_ACTION_MS, LEVELS, PracticeBot
from phantom_host.duel_engine import (
    CastCommand,
    DuelEngine,
    Powerup,
    ReadyCommand,
    SPELL_RULES,
)
from phantom_host.duel_models import Phase, PowerupKind, Slot, Spell

ROUND_START_MS = 3_000


class Arena:
    """Ticks an engine every 50 ms and lets the bot cast through the ordinary path."""

    def __init__(self, *, seed: int, level: int = 2, variance: bool = True, adaptive: bool = True) -> None:
        self.engine = DuelEngine(seed=seed, variance=variance)
        self.engine.reset_lobby(now_ms=0, room_generation=1, occupied_slots={Slot.P1, Slot.P2})
        self.bot = PracticeBot(level=level, seed=seed, adaptive=adaptive)
        self.now = 0
        self.sequence = 0
        self.engine.advance(now_ms=0, commands=[
            ReadyCommand(1, Slot.P1, 0, 1, True), ReadyCommand(2, Slot.P2, 0, 2, True),
        ])
        self.tick(ROUND_START_MS)
        assert self.engine.phase is Phase.PLAYING

    def cast(self, slot: Slot, spell: Spell) -> None:
        self.sequence += 1
        evidence = f"{slot.value}:{self.sequence}"
        self.engine.advance(now_ms=self.now, commands=[CastCommand(
            command_id=1_000 + self.sequence, slot=slot, at_ms=self.now, order=self.sequence,
            round_id=self.engine.round_id, attempt_id=evidence, spell=spell,
            gesture_id=f"{evidence}:g", speech_id=f"{evidence}:s",
        )])

    def tick(self, until_ms: int) -> None:
        while self.now < until_ms:
            self.now += 50
            self.engine.advance(now_ms=self.now, commands=[])
            spell = self.bot.choose(self.engine, self.now)
            if spell is not None:
                self.cast(Slot.P2, spell)

    def events(self, kind: str, actor: Slot | None = None):
        return [
            event for event in self.engine.recent_events
            if event.type == kind and (actor is None or event.actor is actor)
        ]


def test_levels_get_faster_and_sharper():
    intervals = [level.interval_ms[1] for level in LEVELS]
    assert intervals == sorted(intervals, reverse=True)
    assert [level.block_chance for level in LEVELS] == sorted(level.block_chance for level in LEVELS)
    assert LEVELS[-1].perfect_block and not LEVELS[0].perfect_block


def test_bot_matches_the_human_tempo_within_its_level_bounds():
    quick = Arena(seed=3, level=2)
    quick.tick(ROUND_START_MS + 200)
    for _ in range(5):
        quick.cast(Slot.P1, Spell.STUPEFY)
        quick.tick(quick.now + 2_600)
    quick.tick(quick.now + 20_000)
    quick_casts = [e.at_ms for e in quick.events("castAccepted", Slot.P2) if e.spell in (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO)]
    quick_gaps = [b - a for a, b in zip(quick_casts, quick_casts[1:])]

    slow = Arena(seed=3, level=2)
    slow.tick(ROUND_START_MS + 200)
    for _ in range(3):
        slow.cast(Slot.P1, Spell.STUPEFY)
        slow.tick(slow.now + 6_500)
    slow.tick(slow.now + 20_000)
    slow_casts = [e.at_ms for e in slow.events("castAccepted", Slot.P2) if e.spell in (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO)]
    slow_gaps = [b - a for a, b in zip(slow_casts, slow_casts[1:])]
    assert quick_gaps and slow_gaps
    assert sum(quick_gaps) / len(quick_gaps) < sum(slow_gaps) / len(slow_gaps), (quick_gaps, slow_gaps)
    low, high = LEVELS[1].interval_ms
    assert all(low <= gap for gap in quick_gaps + slow_gaps)

    silent = Arena(seed=3, level=1)
    silent.tick(ROUND_START_MS + 60_000)
    silent_casts = [e.at_ms for e in silent.events("castAccepted", Slot.P2)]
    assert len(silent_casts) <= 60_000 // LEVELS[0].interval_ms[0] + 1
    assert silent.engine.players[Slot.P1].hp < 100, "a silent player still gets a duel"


def test_apprentice_and_duelist_cannot_react_to_a_stupefy_bolt():
    for level in (1, 2):
        blocked = 0
        for seed in range(8):
            arena = Arena(seed=seed, level=level)
            arena.tick(ROUND_START_MS + 500)
            arena.cast(Slot.P1, Spell.STUPEFY)
            arena.tick(arena.now + SPELL_RULES[Spell.STUPEFY].flight_ms + 100)
            blocked += bool(arena.events("impactBlocked") or arena.events("impactReflected"))
        assert blocked == 0, (level, blocked)


def test_bot_waits_three_seconds_then_attacks_at_its_own_pace():
    for seed in range(6):
        arena = Arena(seed=seed)
        arena.tick(ROUND_START_MS + BOT_FIRST_ACTION_MS - 50)
        assert not arena.events("castAccepted", Slot.P2)
        arena.tick(30_000)
        casts = arena.events("castAccepted", Slot.P2)
        assert casts, f"seed {seed} never attacked"
        assert casts[0].at_ms >= ROUND_START_MS + BOT_FIRST_ACTION_MS
        attacks = [event for event in casts if event.spell in (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO)]
        gaps = [b.at_ms - a.at_ms for a, b in zip(attacks, attacks[1:])]
        assert all(gap >= LEVELS[1].interval_ms[0] for gap in gaps), (seed, gaps)
        assert arena.engine.players[Slot.P1].hp < 100
    used = set()
    for seed in range(8):
        arena = Arena(seed=seed)
        arena.tick(60_000)
        used |= {event.spell for event in arena.events("castAccepted", Slot.P2)}
    assert {Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO} <= used


def test_bot_blocks_visible_fireballs_and_a_master_reflects_some():
    blocked = 0
    for seed in range(10):
        arena = Arena(seed=seed, level=2)
        arena.tick(ROUND_START_MS + 500)
        arena.cast(Slot.P1, Spell.INCENDIO)
        arena.tick(arena.now + SPELL_RULES[Spell.INCENDIO].flight_ms + 100)
        if arena.events("impactBlocked") or arena.events("impactReflected"):
            blocked += 1
    assert 4 <= blocked <= 9, blocked

    reflected = 0
    for seed in range(12):
        arena = Arena(seed=seed, level=3)
        arena.tick(ROUND_START_MS + 500)
        arena.cast(Slot.P1, Spell.INCENDIO)
        arena.tick(arena.now + SPELL_RULES[Spell.INCENDIO].flight_ms + 100)
        reflected += bool(arena.events("impactReflected"))
    assert reflected >= 6, reflected


def test_bot_heals_when_hurt_and_never_attacks_while_disarmed_or_stunned():
    arena = Arena(seed=4, level=2)
    arena.tick(ROUND_START_MS + 200)
    arena.engine.players[Slot.P2].hp = 30
    arena.tick(arena.now + 8_000)
    heals = arena.events("healed", Slot.P2)
    assert heals and heals[0].spell is Spell.EPISKEY

    arena = Arena(seed=9, level=3)
    arena.tick(ROUND_START_MS + 200)
    own = arena.engine.players[Slot.P2]
    own.offense_locked_until_ms = arena.now + 4_000
    own.stunned_until_ms = arena.now + 1_000
    start = arena.now
    arena.tick(start + 4_000)
    for event in arena.events("castAccepted", Slot.P2):
        assert event.at_ms >= start + 1_000, "cast while stunned"
        assert event.spell in (Spell.PROTEGO, Spell.EPISKEY), "attacked while disarmed"


def test_bot_races_for_a_powerup_and_ignores_a_raised_shield_unless_it_can_shatter_it():
    claimed = 0
    for seed in range(8):
        arena = Arena(seed=seed, level=2)
        arena.tick(ROUND_START_MS + 4_000)
        arena.engine.powerup = Powerup(
            id="r1:u1", kind=PowerupKind.PHOENIX, spawned_at_ms=arena.now, expires_at_ms=arena.now + 10_000,
        )
        arena.tick(arena.now + 6_000)
        claimed += any(event.actor is Slot.P2 for event in arena.events("powerupClaimed"))
    assert claimed >= 5, claimed

    arena = Arena(seed=1, level=2)
    arena.tick(ROUND_START_MS + 3_000)
    while arena.engine.projectiles:
        # Let any bolt already in flight land first; a guard is spent by one hit.
        arena.tick(arena.now + 50)
    shield_holder = arena.engine.players[Slot.P1]
    shield_holder.shield_until_ms = arena.now + 20_000
    arena.engine.players[Slot.P2].cooldown_until_ms[Spell.EXPELLIARMUS] = arena.now + 20_000
    start = arena.now
    arena.tick(start + 6_000)
    attacks = [
        event for event in arena.events("castAccepted", Slot.P2)
        if event.at_ms > start and event.spell in (Spell.STUPEFY, Spell.INCENDIO)
    ]
    assert attacks == []
    assert shield_holder.shield_until_ms > arena.now, "nothing was thrown into the guard"
    arena.engine.players[Slot.P2].cooldown_until_ms[Spell.EXPELLIARMUS] = 0
    arena.tick(arena.now + 12_000)
    assert any(event.spell is Spell.EXPELLIARMUS for event in arena.events("castAccepted", Slot.P2))


def test_bot_studies_after_losing_and_relaxes_after_winning():
    arena = Arena(seed=2, level=2)
    arena.tick(ROUND_START_MS + 200)
    arena.engine.players[Slot.P2].hp = 10
    arena.engine.players[Slot.P2].cooldown_until_ms[Spell.PROTEGO] = 10**9
    arena.cast(Slot.P1, Spell.STUPEFY)
    arena.tick(arena.now + 1_000)
    assert arena.engine.phase is Phase.RESULT and arena.engine.result.winner is Slot.P1
    arena.bot.choose(arena.engine, arena.now)
    assert arena.bot.level == 3
    arena.bot.choose(arena.engine, arena.now)
    assert arena.bot.level == 3, "one adjustment per round"

    gentle = Arena(seed=2, level=1)
    gentle.tick(ROUND_START_MS + 200)
    gentle.engine.players[Slot.P1].hp = 1
    gentle.tick(gentle.now + 20_000)
    assert gentle.engine.phase is Phase.RESULT and gentle.engine.result.winner is Slot.P2
    gentle.bot.choose(gentle.engine, gentle.now)
    assert gentle.bot.level == 1, "never below apprentice"

    fixed = Arena(seed=2, level=1, adaptive=False)
    fixed.tick(ROUND_START_MS + 200)
    fixed.engine.players[Slot.P2].hp = 5
    fixed.engine.players[Slot.P2].cooldown_until_ms[Spell.PROTEGO] = 10**9
    fixed.cast(Slot.P1, Spell.STUPEFY)
    fixed.tick(fixed.now + 1_000)
    fixed.bot.choose(fixed.engine, fixed.now)
    assert fixed.bot.level == 1


def test_same_seed_replays_the_same_bot_decisions():
    def play(seed: int):
        arena = Arena(seed=seed)
        arena.tick(ROUND_START_MS + 1_000)
        arena.cast(Slot.P1, Spell.INCENDIO)
        arena.tick(40_000)
        return [(e.type, e.at_ms, e.actor, e.spell) for e in arena.engine.recent_events]

    assert play(5) == play(5)
    assert play(5) != play(6)
