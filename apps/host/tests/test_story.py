"""Story mode: a ladder of bot rivals that get strictly harder per level."""

import pytest

from phantom_host.duel_bot import (
    LEVELS,
    STORY_LEVEL_COUNT,
    STORY_NAMES,
    StoryBot,
    story_level,
)
from phantom_host.duel_engine import SPELL_RULES
from phantom_host.duel_models import CastMessage, Mode, Phase, Slot, Source, Spell
from phantom_host.duel_registry import RoomRegistry
from phantom_host.duel_room import DuelRoom, GamePeer, RoomError
from tests.test_duel_bot import ROUND_START_MS, Arena
from tests.test_duel_room import FakeClock, _heartbeat, _ready


def test_ladder_has_at_least_twenty_uniquely_named_levels():
    assert STORY_LEVEL_COUNT >= 20
    assert len(set(STORY_NAMES)) == STORY_LEVEL_COUNT
    assert story_level(1).name == "Hedge Witch"
    assert story_level(STORY_LEVEL_COUNT).name == STORY_NAMES[-1]


def test_every_rung_is_no_easier_than_the_one_below():
    previous = story_level(1)
    first = previous.profile
    apprentice = LEVELS[0]
    # The first rung is gentler than the practice Apprentice on every axis that hurts.
    assert first.interval_ms[0] >= apprentice.interval_ms[0]
    assert first.tempo >= apprentice.tempo
    assert first.reaction_ms >= apprentice.reaction_ms
    assert first.block_chance <= apprentice.block_chance
    assert first.attack_weights == (100, 0, 0)
    assert not first.perfect_block and first.bolt_block_chance == 0
    for level in range(2, STORY_LEVEL_COUNT + 1):
        current = story_level(level)
        a, b = previous.profile, current.profile
        assert current.first_action_ms <= previous.first_action_ms
        assert b.interval_ms[0] <= a.interval_ms[0] and b.interval_ms[1] <= a.interval_ms[1]
        assert b.tempo <= a.tempo
        assert b.reaction_ms <= a.reaction_ms
        assert b.block_chance >= a.block_chance
        assert b.bolt_block_chance >= a.bolt_block_chance
        assert b.perfect_block >= a.perfect_block
        assert b.hesitation <= a.hesitation
        assert b.heal_at >= a.heal_at
        assert b.attack_weights[0] <= a.attack_weights[0]
        previous = current
    last = story_level(STORY_LEVEL_COUNT).profile
    master = LEVELS[-1]
    assert last.perfect_block and last.bolt_block_chance >= master.bolt_block_chance
    assert last.interval_ms[1] <= master.interval_ms[1]


@pytest.mark.parametrize("level", [0, STORY_LEVEL_COUNT + 1])
def test_unknown_levels_are_rejected(level):
    with pytest.raises(ValueError):
        story_level(level)
    with pytest.raises(RoomError):
        DuelRoom(clock_ms=lambda: 0, mode=Mode.STORY, level=level)


def test_story_rooms_need_a_level_and_other_modes_refuse_one():
    with pytest.raises(RoomError, match="story_requires_level"):
        DuelRoom(clock_ms=lambda: 0, mode=Mode.STORY)
    with pytest.raises(RoomError, match="solo_has_no_levels"):
        DuelRoom(clock_ms=lambda: 0, mode=Mode.SOLO, level=1)


class StoryArena(Arena):
    def __init__(self, *, seed: int, level: int, variance: bool = False) -> None:
        super().__init__(seed=seed, level=1, variance=variance, adaptive=False)
        self.bot = StoryBot(level, seed=seed)


def test_first_rung_waits_ten_seconds_and_only_ever_casts_stupefy():
    for seed in range(6):
        arena = StoryArena(seed=seed, level=1)
        arena.tick(ROUND_START_MS + story_level(1).first_action_ms - 50)
        assert not arena.events("castAccepted", Slot.P2)
        arena.tick(60_000)
        casts = arena.events("castAccepted", Slot.P2)
        assert casts, "a silent player still gets a duel"
        assert {event.spell for event in casts} <= {Spell.STUPEFY, Spell.EPISKEY}


def test_first_rung_never_blocks_a_bolt_so_a_learner_can_land_hits():
    for seed in range(8):
        arena = StoryArena(seed=seed, level=1)
        arena.tick(ROUND_START_MS + 500)
        arena.cast(Slot.P1, Spell.STUPEFY)
        arena.tick(arena.now + SPELL_RULES[Spell.STUPEFY].flight_ms + 100)
        assert not arena.events("impactBlocked") and not arena.events("impactReflected")
        assert arena.engine.players[Slot.P2].hp < 100


def test_second_rung_opens_sooner_than_the_first():
    assert story_level(2).first_action_ms < story_level(1).first_action_ms
    opening = {}
    for level in (1, 2):
        first = []
        for seed in range(4):
            arena = StoryArena(seed=seed, level=level)
            arena.tick(40_000)
            casts = arena.events("castAccepted", Slot.P2)
            assert casts, (level, seed)
            first.append(casts[0].at_ms)
        opening[level] = sum(first) / len(first)
    assert opening[2] < opening[1]


def test_top_rung_blocks_and_reflects_and_never_adapts():
    reactions = 0
    for seed in range(8):
        arena = StoryArena(seed=seed, level=STORY_LEVEL_COUNT)
        arena.tick(ROUND_START_MS + 500)
        for _ in range(3):
            arena.cast(Slot.P1, Spell.INCENDIO)
            arena.tick(arena.now + 9_500)
        reactions += len(arena.events("impactBlocked")) + len(arena.events("impactReflected"))
        assert arena.bot.profile == story_level(STORY_LEVEL_COUNT).profile
    assert reactions > 0, "the final rival never raised Protego"


def test_story_bot_keeps_its_rung_after_a_result():
    bot = StoryBot(3, seed=1)
    arena = StoryArena(seed=1, level=3)
    arena.bot = bot
    arena.tick(ROUND_START_MS + 100)
    for _ in range(8):
        arena.cast(Slot.P1, Spell.STUPEFY)
        arena.tick(arena.now + 2_600)
        if arena.engine.phase is Phase.RESULT:
            break
    bot.choose(arena.engine, arena.now)
    assert bot.profile.name == "Pixie Wrangler"
    assert bot.level == 1 and not bot.adaptive


async def _story_playing(level: int):
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock, mode=Mode.STORY, level=level, seed=7, variance=False)
    session = await room.create_session(name="Human", source=Source.BLE)
    peer = GamePeer()
    await room.attach(token=session.token, peer=peer, now_ms=0)
    await room.submit_ready(peer=peer, message=_ready("real-wand"), receipt_ms=0)
    await room.tick(0)
    assert room.engine.phase is Phase.COUNTDOWN
    for now in range(500, 3_001, 500):
        await _tick(room, peer, clock, now)
    assert room.engine.phase is Phase.PLAYING
    return clock, room, peer


async def _tick(room, peer, clock, now):
    clock.now_ms = now
    await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=now)
    await room.tick(now)


@pytest.mark.asyncio
async def test_story_room_names_the_rival_and_carries_the_level_card():
    clock, room, peer = await _story_playing(1)
    snapshot = await room.current_snapshot()
    assert snapshot.mode is Mode.STORY
    assert snapshot.story is not None
    assert (snapshot.story.level, snapshot.story.name, snapshot.story.total) == (
        1, "Hedge Witch", STORY_LEVEL_COUNT,
    )
    assert snapshot.players[Slot.P2].name == "Hedge Witch"
    assert snapshot.players[Slot.P2].source is Source.BOT
    for now in range(3_050, 12_001, 50):
        await _tick(room, peer, clock, now)
    assert not [e for e in room.engine.recent_events if e.type == "castAccepted" and e.actor is Slot.P2]
    for now in range(12_050, 40_001, 50):
        await _tick(room, peer, clock, now)
    casts = [e for e in room.engine.recent_events if e.type == "castAccepted" and e.actor is Slot.P2]
    assert casts and all(e.spell is Spell.STUPEFY for e in casts)


@pytest.mark.asyncio
async def test_human_knockout_ends_a_story_round_with_the_human_as_winner():
    clock, room, peer = await _story_playing(1)
    now = 3_050
    while room.engine.phase is Phase.PLAYING and now < 60_000:
        evidence = f"human-{now}"
        await room.submit_cast(peer=peer, receipt_ms=now, message=CastMessage(
            round_id=1, attempt_id=evidence, spell=Spell.STUPEFY,
            gesture_id=f"{evidence}-motion", speech_id=f"{evidence}-voice",
            input_generation=1,
        ))
        for step in range(now, now + 2_600, 50):
            await _tick(room, peer, clock, step)
            if room.engine.phase is not Phase.PLAYING:
                break
        now += 2_600
    assert room.engine.result is not None
    assert room.engine.result.winner is Slot.P1 and room.engine.result.reason == "knockout"
    assert room.engine.players[Slot.P2].hp == 0


@pytest.mark.asyncio
async def test_registry_creates_private_story_rooms_only_with_a_level():
    registry = RoomRegistry(clock_ms=lambda: 0)
    with pytest.raises(RoomError, match="story_requires_level"):
        await registry.create_session(name="Harry", source=Source.BLE, mode=Mode.STORY)
    assert len(registry) == 0
    session = await registry.create_session(
        name="Harry", source=Source.BLE, mode=Mode.STORY, level=2,
    )
    assert session.mode is Mode.STORY
    room = registry.room_for_code(session.room_id)
    assert room is not None and room.mode is Mode.STORY
    with pytest.raises(RoomError, match="story_room_private"):
        await registry.create_session(name="Ron", source=Source.BLE, code=session.room_id)
    with pytest.raises(RoomError, match="story_requires_new_room"):
        await registry.create_session(
            name="Ron", source=Source.BLE, code=session.room_id, level=3,
        )
