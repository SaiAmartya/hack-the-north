import asyncio

import pytest

from phantom_host.duel_models import (
    CastMessage,
    HeartbeatMessage,
    Mode,
    Phase,
    ReadyMessage,
    Slot,
    Source,
    Spell,
)
from phantom_host.duel_room import (
    DuelRoom,
    GamePeer,
    OutboundMailbox,
    RoomError,
    SESSION_LEASE_MS,
)

from phantom_host.duel_engine import SPELL_RULES


class FakeClock:
    def __init__(self, now_ms: int = 0) -> None:
        self.now_ms = now_ms

    def __call__(self) -> int:
        return self.now_ms


def _heartbeat(
    *, generation: int = 1, healthy: bool = True, client_ms: float = 1.0
) -> HeartbeatMessage:
    return HeartbeatMessage(
        client_ms=client_ms,
        input_generation=generation,
        healthy=healthy,
    )


def _ready(
    device_id: str,
    *,
    ready: bool = True,
    generation: int = 1,
    healthy: bool = True,
) -> ReadyMessage:
    return ReadyMessage(
        ready=ready,
        input_generation=generation,
        healthy=healthy,
        device_id=device_id,
        boot_id=1,
    )


@pytest.mark.asyncio
async def test_session_slots_and_virtual_sources_are_explicitly_gated():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock)
    with pytest.raises(RoomError, match="phone_source_disabled"):
        await room.create_session(name="Phone", source=Source.PHONE)
    with pytest.raises(RoomError, match="virtual_source_disabled"):
        await room.create_session(name="Replay", source=Source.REPLAY)

    first = await room.create_session(name="One", source=Source.BLE)
    second = await room.create_session(name="Two", source=Source.BLE)
    assert (first.slot, second.slot) == (Slot.P1, Slot.P2)
    with pytest.raises(RoomError, match="room_full"):
        await room.create_session(name="Three", source=Source.BLE)

    phone_room = DuelRoom(clock_ms=clock, allow_phone=True)
    assert (
        await phone_room.create_session(name="Phone", source=Source.PHONE)
    ).slot is Slot.P1
    replay_room = DuelRoom(clock_ms=clock, allow_replay=True)
    assert (
        await replay_room.create_session(name="Replay", source=Source.REPLAY)
    ).slot is Slot.P1


@pytest.mark.asyncio
async def test_two_players_ready_play_duplicate_cast_and_exact_heartbeat_timeout():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock, allow_replay=True)
    first = await room.create_session(name="One", source=Source.REPLAY)
    second = await room.create_session(name="Two", source=Source.REPLAY)
    peer_one = GamePeer()
    peer_two = GamePeer()
    await room.attach(token=first.token, peer=peer_one, now_ms=0)
    await room.attach(token=second.token, peer=peer_two, now_ms=0)

    pong = await room.heartbeat(
        peer=peer_one,
        message=_heartbeat(client_ms=12.5),
        receipt_ms=100,
    )
    await room.heartbeat(peer=peer_two, message=_heartbeat(), receipt_ms=100)
    assert pong.client_ms == 12.5
    assert pong.server_ms == 100

    assert await room.submit_ready(
        peer=peer_one,
        message=_ready("device-one"),
        receipt_ms=100,
    ) is None
    assert await room.submit_ready(
        peer=peer_two,
        message=_ready("device-two"),
        receipt_ms=100,
    ) is None
    await room.tick(100)
    assert room.engine.phase is Phase.COUNTDOWN

    await room.heartbeat(peer=peer_one, message=_heartbeat(), receipt_ms=3_000)
    await room.heartbeat(peer=peer_two, message=_heartbeat(), receipt_ms=3_000)
    await room.tick(3_100)
    assert room.engine.phase is Phase.PLAYING

    cast = CastMessage(
        round_id=1,
        attempt_id="attempt-one",
        spell=Spell.STUPEFY,
        gesture_id="gesture-one",
        speech_id="speech-one",
        input_generation=1,
    )
    assert await room.submit_cast(
        peer=peer_one, message=cast, receipt_ms=3_200
    ) is None
    # A retry while the original is pending does not enqueue a second command.
    assert await room.submit_cast(
        peer=peer_one, message=cast, receipt_ms=3_201
    ) is None
    await room.tick(3_250)
    assert len(room.engine.projectiles) == 1

    cached = await room.submit_cast(
        peer=peer_one, message=cast, receipt_ms=3_300
    )
    assert cached is not None
    assert cached.accepted is True
    assert cached.action_id == "r1:a1"
    assert cached.projectile_id == "r1:p1"

    # The boundary is fail-closed: 3_000 + 1_500 is already timed out.
    closed = await room.tick(4_500)
    assert {id(peer) for peer in closed} == {id(peer_one), id(peer_two)}
    assert room.engine.phase is Phase.RESULT
    assert room.engine.result is not None
    assert room.engine.result.reason == "heartbeat_timeout"
    assert room.engine.projectiles == []


@pytest.mark.asyncio
async def test_both_players_receive_the_same_damage_healing_lock_and_cooldown_state():
    room = DuelRoom(clock_ms=FakeClock(), allow_replay=True, seed=1)
    room.engine.variance = False
    sessions = [await room.create_session(name=name, source=Source.REPLAY) for name in ("One", "Two")]
    peers = [GamePeer(), GamePeer()]
    for index, (session, peer) in enumerate(zip(sessions, peers, strict=True)):
        await room.attach(token=session.token, peer=peer, now_ms=0)
        await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=100)
        await room.submit_ready(peer=peer, message=_ready(f"wand-{index}"), receipt_ms=100)
    await room.tick(100)

    async def advance(at_ms):
        for peer in peers:
            await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=at_ms)
        await room.tick(at_ms)

    async def cast(peer, spell, at_ms, attempt):
        await room.submit_cast(
            peer=peer,
            message=CastMessage(
                round_id=1,
                attempt_id=attempt,
                spell=spell,
                gesture_id=f"g-{attempt}",
                speech_id=f"s-{attempt}",
                input_generation=1,
            ),
            receipt_ms=at_ms,
        )

    async def both_snapshots():
        snapshots = []
        for peer in peers:
            for _ in range(10):
                message = await asyncio.wait_for(peer.mailbox.next_message(), 0.1)
                if message["type"] == "snapshot":
                    snapshots.append(message["snapshot"])
                    break
        assert len(snapshots) == 2 and snapshots[0] == snapshots[1]
        return snapshots[0]

    await advance(3_100)
    for spell in (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO):
        await cast(peers[0], spell, 3_200, spell.value)
    await advance(3_200)
    flight = await both_snapshots()
    assert len(flight["projectiles"]) == 3
    assert flight["powerup"] is None
    assert all(projectile["reflected"] is False for projectile in flight["projectiles"])
    await advance(5_600)
    hit = await both_snapshots()
    assert hit["players"]["P2"]["hp"] == 56  # 14 + 8 + 22 before the first burn tick
    assert hit["players"]["P2"]["offenseLockedUntilMs"] == 6_800
    assert hit["players"]["P2"]["burnUntilMs"] == 9_000
    assert hit["players"]["P2"]["stunnedUntilMs"] == 0 and hit["players"]["P2"]["lucky"] is False
    assert any(event["type"] == "burning" for event in hit["recentEvents"])
    await cast(peers[1], Spell.EPISKEY, 5_601, "heal")
    await cast(peers[1], Spell.PROTEGO, 5_601, "guard")
    await advance(5_601)
    restored = await both_snapshots()
    defender = restored["players"]["P2"]
    assert defender["hp"] == 78
    assert defender["burnUntilMs"] == 0
    assert defender["shieldUntilMs"] == 7_101
    assert defender["cooldownUntilMs"]["episkey"] == 17_601
    assert defender["cooldownUntilMs"]["protego"] == 9_601
    healed = [event for event in restored["recentEvents"] if event["type"] == "healed"]
    assert healed and healed[-1]["amount"] == 22 and healed[-1]["reason"] == "cured"


@pytest.mark.asyncio
async def test_generation_or_health_change_aborts_and_requires_fresh_ready():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock, allow_replay=True)
    sessions = [
        await room.create_session(name=name, source=Source.REPLAY)
        for name in ("One", "Two")
    ]
    peers = [GamePeer(), GamePeer()]
    for session, peer in zip(sessions, peers, strict=True):
        await room.attach(token=session.token, peer=peer, now_ms=0)
        await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=100)
    await room.submit_ready(
        peer=peers[0], message=_ready("device-one"), receipt_ms=100
    )
    await room.submit_ready(
        peer=peers[1], message=_ready("device-two"), receipt_ms=100
    )
    await room.tick(100)
    for peer in peers:
        await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=3_000)
    await room.tick(3_100)
    assert room.engine.phase is Phase.PLAYING

    await room.heartbeat(
        peer=peers[0],
        message=_heartbeat(generation=2),
        receipt_ms=3_150,
    )
    await room.tick(3_150)
    assert room.engine.result is not None
    assert room.engine.result.reason == "input_generation_changed"
    assert room.engine.players[Slot.P1].ready is False

    # Result -> explicit fresh Ready starts a new round, not a resume.
    await room.submit_ready(
        peer=peers[0],
        message=_ready("device-one", generation=2),
        receipt_ms=3_200,
    )
    await room.submit_ready(
        peer=peers[1],
        message=_ready("device-two"),
        receipt_ms=3_200,
    )
    await room.tick(3_200)
    assert room.engine.phase is Phase.COUNTDOWN
    assert room.engine.round_id == 2


@pytest.mark.asyncio
async def test_duplicate_device_identity_cannot_ready_both_slots():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock, allow_replay=True)
    first = await room.create_session(name="One", source=Source.REPLAY)
    second = await room.create_session(name="Two", source=Source.REPLAY)
    one, two = GamePeer(), GamePeer()
    await room.attach(token=first.token, peer=one, now_ms=0)
    await room.attach(token=second.token, peer=two, now_ms=0)
    await room.heartbeat(peer=one, message=_heartbeat(), receipt_ms=1)
    await room.heartbeat(peer=two, message=_heartbeat(), receipt_ms=1)
    await room.submit_ready(
        peer=one, message=_ready("same-device"), receipt_ms=2
    )
    rejection = await room.submit_ready(
        peer=two, message=_ready("same-device"), receipt_ms=2
    )
    assert rejection is not None
    assert rejection.accepted is False
    assert rejection.reason == "device_in_use"


@pytest.mark.asyncio
async def test_reconnect_invalidates_old_peer_and_never_preserves_ready():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock)
    session = await room.create_session(name="One", source=Source.BLE)
    old_peer = GamePeer()
    await room.attach(token=session.token, peer=old_peer, now_ms=0)
    await room.heartbeat(peer=old_peer, message=_heartbeat(), receipt_ms=10)
    await room.submit_ready(
        peer=old_peer,
        message=_ready("device-one"),
        receipt_ms=10,
    )
    await room.tick(10)
    assert room.engine.players[Slot.P1].ready is True
    await room.detach(peer=old_peer, now_ms=20)
    await room.tick(20)

    new_peer = GamePeer()
    welcome = await room.attach(token=session.token, peer=new_peer, now_ms=30)
    assert new_peer.connection_generation == 2
    assert welcome.snapshot.players["P1"] is not None
    assert welcome.snapshot.players["P1"].ready is False
    stale = await room.heartbeat(
        peer=old_peer,
        message=_heartbeat(),
        receipt_ms=31,
    )
    assert stale.type == "error"


@pytest.mark.asyncio
async def test_never_attached_and_disconnected_sessions_expire_at_lease_boundary():
    clock = FakeClock(100)
    room = DuelRoom(clock_ms=clock)
    never_attached = await room.create_session(name="Reserved", source=Source.BLE)

    await room.tick(100 + SESSION_LEASE_MS - 1)
    assert room.session_for_token(never_attached.token) is not None
    await room.tick(100 + SESSION_LEASE_MS)
    assert room.session_for_token(never_attached.token) is None

    replacement = await room.create_session(name="Connected", source=Source.BLE)
    assert replacement.slot is Slot.P1
    peer = GamePeer()
    await room.attach(token=replacement.token, peer=peer, now_ms=6_000)
    await room.detach(peer=peer, now_ms=6_100)

    await room.tick(6_100 + SESSION_LEASE_MS - 1)
    assert room.session_for_token(replacement.token) is not None
    await room.tick(6_100 + SESSION_LEASE_MS)
    assert room.session_for_token(replacement.token) is None


@pytest.mark.asyncio
async def test_connected_session_never_lease_expires_and_reconnect_is_fresh():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock)
    session = await room.create_session(name="Harry", source=Source.BLE)
    first_peer = GamePeer()
    await room.attach(token=session.token, peer=first_peer, now_ms=0)
    await room.heartbeat(peer=first_peer, message=_heartbeat(), receipt_ms=10)
    await room.submit_ready(
        peer=first_peer,
        message=_ready("badge-one"),
        receipt_ms=10,
    )
    await room.tick(10)
    assert room.engine.players[Slot.P1].ready is True

    await room.detach(peer=first_peer, now_ms=100)
    await room.tick(100 + SESSION_LEASE_MS - 1)
    second_peer = GamePeer()
    welcome = await room.attach(
        token=session.token,
        peer=second_peer,
        now_ms=100 + SESSION_LEASE_MS - 1,
    )
    assert second_peer.connection_generation == 2
    assert welcome.snapshot.players["P1"] is not None
    assert welcome.snapshot.players["P1"].ready is False

    # Lease age cannot remove a currently connected player. A current heartbeat
    # isolates that assertion from the independent 1.5 second liveness timeout.
    await room.heartbeat(
        peer=second_peer,
        message=_heartbeat(),
        receipt_ms=20_000,
    )
    await room.tick(20_001)
    stored = room.session_for_token(session.token)
    assert stored is not None
    assert stored.connected is True


@pytest.mark.asyncio
async def test_heartbeat_timeout_starts_disconnected_lease_at_exact_deadline():
    room = DuelRoom(clock_ms=FakeClock())
    session = await room.create_session(name="Harry", source=Source.BLE)
    peer = GamePeer()
    await room.attach(token=session.token, peer=peer, now_ms=0)

    await room.tick(1_500)
    stored = room.session_for_token(session.token)
    assert stored is not None
    assert stored.connected is False
    assert stored.lease_started_at_ms == 1_500

    await room.tick(1_500 + SESSION_LEASE_MS - 1)
    assert room.session_for_token(session.token) is not None
    await room.tick(1_500 + SESSION_LEASE_MS)
    assert room.session_for_token(session.token) is None


@pytest.mark.asyncio
async def test_active_disconnect_aborts_before_session_lease_expires():
    room = DuelRoom(clock_ms=FakeClock(), allow_replay=True)
    sessions = [
        await room.create_session(name=name, source=Source.REPLAY)
        for name in ("Harry", "Draco")
    ]
    peers = [GamePeer(), GamePeer()]
    for index, (session, peer) in enumerate(
        zip(sessions, peers, strict=True), start=1
    ):
        await room.attach(token=session.token, peer=peer, now_ms=0)
        await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=100)
        await room.submit_ready(
            peer=peer,
            message=_ready(f"badge-{index}"),
            receipt_ms=100,
        )
    await room.tick(100)
    for peer in peers:
        await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=3_000)
    await room.tick(3_100)
    assert room.engine.phase is Phase.PLAYING

    await room.detach(peer=peers[0], now_ms=3_200)
    await room.tick(3_200)
    assert room.engine.phase is Phase.RESULT
    assert room.engine.result is not None
    assert room.engine.result.reason == "game_disconnected"
    assert room.session_for_token(sessions[0].token) is not None


@pytest.mark.asyncio
async def test_release_rejects_active_session_and_frees_disconnected_slot():
    room = DuelRoom(clock_ms=FakeClock())
    session = await room.create_session(name="Harry", source=Source.BLE)
    peer = GamePeer()
    await room.attach(token=session.token, peer=peer, now_ms=0)

    with pytest.raises(RoomError, match="session_active") as active_error:
        await room.release_session(token=session.token, now_ms=1)
    assert active_error.value.status_code == 409
    assert room.session_for_token(session.token) is not None

    await room.detach(peer=peer, now_ms=2)
    await room.release_session(token=session.token, now_ms=2)
    assert room.session_for_token(session.token) is None
    replacement = await room.create_session(name="Replacement", source=Source.BLE)
    assert replacement.slot is Slot.P1

    with pytest.raises(RoomError, match="invalid_token") as missing_error:
        await room.release_session(token=session.token, now_ms=3)
    assert missing_error.value.status_code == 401


@pytest.mark.asyncio
async def test_mailbox_bounds_reliable_messages_and_coalesces_snapshots():
    mailbox = OutboundMailbox(reliable_limit=1)
    assert mailbox.offer_reliable({"type": "first"})
    assert not mailbox.offer_reliable({"type": "overflow"})
    assert mailbox.offer_snapshot({"version": 1})
    assert mailbox.offer_snapshot({"version": 2})
    assert await asyncio.wait_for(mailbox.next_message(), 0.1) == {"type": "first"}
    assert await asyncio.wait_for(mailbox.next_message(), 0.1) == {"version": 2}
    mailbox.close()
    assert await asyncio.wait_for(mailbox.next_message(), 0.1) is None


async def _solo_playing():
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock, mode=Mode.SOLO, seed=7)
    session = await room.create_session(name="Human", source=Source.BLE)
    peer = GamePeer()
    await room.attach(token=session.token, peer=peer, now_ms=0)
    rejected = await room.submit_ready(
        peer=peer, message=_ready("real-wand", healthy=False), receipt_ms=0,
    )
    assert rejected is not None and rejected.reason == "input_unhealthy"
    assert not room.engine.players[Slot.P2].ready
    await room.submit_ready(peer=peer, message=_ready("real-wand"), receipt_ms=0)
    await room.tick(0)
    assert room.engine.phase is Phase.COUNTDOWN
    assert all(player.ready for player in room.engine.players.values())
    for now in range(500, 3_001, 500):
        await _solo_tick(room, peer, clock, now)
    assert room.engine.phase is Phase.PLAYING
    return clock, room, session, peer


async def _solo_tick(room, peer, clock, now):
    clock.now_ms = now
    await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=now)
    await room.tick(now)


@pytest.mark.asyncio
async def test_solo_duelist_bot_fights_back_while_the_human_uses_all_five_spells():
    clock, room, _session, peer = await _solo_playing()
    schedule = {
        7_900: [Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO],
        12_000: [Spell.PROTEGO],
        13_500: [Spell.STUPEFY],
        16_000: [Spell.EPISKEY],
    }
    events = {}
    for now in range(3_050, 40_001, 50):
        for spell in schedule.get(now, []):
            evidence = f"human-{now}-{spell.value}"
            await room.submit_cast(peer=peer, receipt_ms=now, message=CastMessage(
                round_id=1, attempt_id=evidence, spell=spell,
                gesture_id=f"{evidence}-motion", speech_id=f"{evidence}-voice",
                input_generation=1,
            ))
        await _solo_tick(room, peer, clock, now)
        events.update((event.id, event) for event in room.engine.recent_events)
        if room.engine.phase is Phase.RESULT:
            break
    snapshot = await room.current_snapshot()
    assert snapshot.mode is Mode.SOLO
    casts = [event for event in events.values() if event.type == "castAccepted"]
    own_casts = [event for event in casts if event.actor is Slot.P1]
    assert {event.spell for event in own_casts} == set(Spell)
    for spell in Spell:
        times = [event.at_ms for event in own_casts if event.spell is spell]
        assert all(b - a >= SPELL_RULES[spell].cooldown_ms for a, b in zip(times, times[1:]))
    bot_casts = [event for event in casts if event.actor is Slot.P2]
    assert bot_casts and bot_casts[0].at_ms >= 6_000, "three seconds of play before the first bot action"
    attacks = [event for event in bot_casts if event.spell in (Spell.STUPEFY, Spell.EXPELLIARMUS, Spell.INCENDIO)]
    assert len(attacks) >= 4
    assert all(b.at_ms - a.at_ms >= 1_600 for a, b in zip(attacks, attacks[1:]))
    assert any(event.type == "damage" and event.target is Slot.P1 for event in events.values())
    assert any(event.type == "offenseLocked" and event.target is Slot.P2 for event in events.values())
    assert snapshot.players[Slot.P2].hp < 100


@pytest.mark.asyncio
async def test_solo_bot_never_attacks_while_disarmed():
    clock, room, _session, peer = await _solo_playing()
    await _solo_tick(room, peer, clock, 7_000)
    await room.submit_cast(peer=peer, receipt_ms=7_000, message=CastMessage(
        round_id=1, attempt_id="disarm", spell=Spell.EXPELLIARMUS,
        gesture_id="disarm-motion", speech_id="disarm-voice", input_generation=1,
    ))
    await _solo_tick(room, peer, clock, 7_000)
    landed = None
    for now in range(7_050, 8_200, 50):
        await _solo_tick(room, peer, clock, now)
        if room.engine.players[Slot.P2].offense_locked_until_ms:
            landed = now
            break
    assert landed is not None, "disarm should land (a broken shield still disarms)"
    lock_until = room.engine.players[Slot.P2].offense_locked_until_ms
    assert lock_until == 8_100 + 2_500
    for now in range(landed + 50, lock_until + 1, 50):
        await _solo_tick(room, peer, clock, now)
        # A bolt already in the air when the disarm landed may still finish its flight.
        assert not any(
            p.caster is Slot.P2 and p.launch_at_ms > landed for p in room.engine.projectiles
        ), now
    for now in range(lock_until + 50, lock_until + 8_001, 50):
        await _solo_tick(room, peer, clock, now)
        if any(p.caster is Slot.P2 for p in room.engine.projectiles):
            break
    assert any(p.caster is Slot.P2 for p in room.engine.projectiles), "attacks resume after the lock"


@pytest.mark.asyncio
@pytest.mark.parametrize("human_attacks", [False, True])
async def test_solo_normal_result_stops_bot_and_rematch_restores_full_opening_grace(human_attacks):
    clock, room, _session, peer = await _solo_playing()
    if human_attacks:
        room.engine.players[Slot.P2].hp = 10
        # Keep the finishing bolt unblockable so the knockout path itself is what is checked.
        room.engine.players[Slot.P2].cooldown_until_ms[Spell.PROTEGO] = 999_999
    schedule = {3_500: [Spell.STUPEFY], 6_100: [Spell.STUPEFY], 8_700: [Spell.STUPEFY]} if human_attacks else {}
    bot_casts = {}
    for now in range(3_050, 96_001, 50):
        for spell in schedule.get(now, []):
            evidence = f"human-{now}-{spell.value}"
            await room.submit_cast(peer=peer, receipt_ms=now, message=CastMessage(
                round_id=1, attempt_id=evidence, spell=spell,
                gesture_id=f"{evidence}-motion", speech_id=f"{evidence}-voice",
                input_generation=1,
            ))
        await _solo_tick(room, peer, clock, now)
        bot_casts.update((event.id, event) for event in room.engine.recent_events
                         if event.type == "castAccepted" and event.actor is Slot.P2)
        if room.engine.phase is Phase.RESULT:
            break
    assert room.engine.result is not None
    if human_attacks:
        assert room.engine.result.reason == "knockout" and room.engine.result.winner is Slot.P1
        assert room.engine.players[Slot.P2].hp == 0
    else:
        assert room.engine.result.winner is Slot.P2
        assert room.engine.players[Slot.P1].hp < 100
        assert bot_casts and {event.spell for event in bot_casts.values()} & {Spell.STUPEFY, Spell.INCENDIO, Spell.EXPELLIARMUS}
    ended = clock.now_ms
    event_count = len(room.engine.recent_events)
    await _solo_tick(room, peer, clock, ended + 500)
    assert len(room.engine.recent_events) == event_count
    await room.submit_ready(peer=peer, message=_ready("real-wand"), receipt_ms=ended + 600)
    await _solo_tick(room, peer, clock, ended + 600)
    assert room.engine.phase is Phase.COUNTDOWN and room.engine.round_id == 2
    assert room.engine.result is None
    assert all(player.hp == 100 and not player.cooldown_until_ms for player in room.engine.players.values())
    assert room.engine.powerup is None
    # Full opening grace: no bot spell for three seconds after the new round begins.
    for now in range(ended + 650, ended + 3_600 + 3_000, 50):
        await _solo_tick(room, peer, clock, now)
        assert not any(event.actor is Slot.P2 and event.type == "castAccepted"
                       for event in room.engine.recent_events), now
    for now in range(ended + 6_650, ended + 16_000, 50):
        await _solo_tick(room, peer, clock, now)
        if any(p.caster is Slot.P2 for p in room.engine.projectiles):
            break
    assert any(p.caster is Slot.P2 for p in room.engine.projectiles)


@pytest.mark.asyncio
async def test_solo_disconnect_reconnect_and_leave_keep_bot_owned_by_the_human_session():
    clock, room, session, peer = await _solo_playing()
    for now in range(3_050, 15_001, 50):
        await _solo_tick(room, peer, clock, now)
        if room.engine.projectiles:
            break
    assert room.engine.projectiles
    await room.detach(peer=peer, now_ms=15_100)
    await room.tick(15_100)
    assert room.engine.result is not None and room.engine.result.reason == "game_disconnected"
    assert not room.engine.projectiles
    replacement = GamePeer()
    welcome = await room.attach(token=session.token, peer=replacement, now_ms=15_200)
    assert welcome.mode is Mode.SOLO and replacement.connection_generation == 2
    assert welcome.snapshot.players[Slot.P2].source is Source.BOT
    await room.submit_ready(peer=replacement, message=_ready("real-wand"), receipt_ms=15_300)
    await _solo_tick(room, replacement, clock, 15_300)
    assert room.engine.phase is Phase.COUNTDOWN
    await room.leave(peer=replacement, now_ms=15_400)
    assert not room.has_sessions()
    assert room.session_for_token(session.token) is None
    snapshot = await room.current_snapshot()
    assert snapshot.players == {"P1": None, "P2": None}
    assert not room.engine.players and not room.engine.projectiles


@pytest.mark.asyncio
@pytest.mark.parametrize("release", [True, False])
async def test_unused_solo_reservation_release_or_expiry_removes_bot(release):
    clock = FakeClock()
    room = DuelRoom(clock_ms=clock, mode=Mode.SOLO)
    session = await room.create_session(name="Human", source=Source.BLE)
    if release:
        await room.release_session(token=session.token, now_ms=1)
    else:
        await room.tick(SESSION_LEASE_MS)
    assert not room.has_sessions()
    assert not room.engine.players
    assert (await room.current_snapshot()).players == {"P1": None, "P2": None}


@pytest.mark.asyncio
async def test_tutorial_requires_real_effects_and_pauses_then_runs_short_free_duel():
    from phantom_host.duel_models import TutorialContinueMessage

    room = DuelRoom(clock_ms=FakeClock(), mode=Mode.TUTORIAL, seed=7)
    session = await room.create_session(name="Learner", source=Source.BLE)
    peer = GamePeer()
    await room.attach(token=session.token, peer=peer, now_ms=0)
    now = 0
    sequence = 0

    async def tick(at_ms):
        nonlocal now
        now = at_ms
        await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=now)
        await room.tick(now)
        return await room.current_snapshot(now)

    async def proceed(step, *, accepted=True):
        reply = await room.submit_tutorial_continue(
            peer=peer, receipt_ms=now,
            message=TutorialContinueMessage(round_id=room.engine.round_id, step=step),
        )
        assert reply.accepted is accepted, reply
        return reply

    async def cast(spell):
        nonlocal sequence
        sequence += 1
        message = CastMessage(
            round_id=room.engine.round_id, attempt_id=f"tutorial-{sequence}", spell=spell,
            gesture_id=f"gesture-{sequence}", speech_id=f"speech-{sequence}", input_generation=1,
        )
        reply = await room.submit_cast(peer=peer, message=message, receipt_ms=now)
        await tick(now)
        return reply

    await room.submit_ready(peer=peer, message=_ready("tutorial-wand"), receipt_ms=0)
    await tick(0)
    # Even a delayed tick crossing the countdown and an entire normal round
    # cannot time out training. An early cast cannot sneak across that boundary.
    assert (await cast(Spell.STUPEFY)).reason == "tutorial_paused"
    start = await tick(90_000)
    assert start.phase is Phase.PLAYING and start.tutorial.stage == "instruction"
    assert start.round_ends_at_ms == 0
    # Read for longer than a whole round; no bot damage, timeout, or accepted casts.
    idle = await tick(180_000)
    assert idle.phase is Phase.PLAYING and idle.players["P1"].hp == 100
    assert idle.projectiles == ()
    assert (await cast(Spell.STUPEFY)).reason == "tutorial_paused"
    assert (await proceed(1, accepted=False)).reason == "tutorial_wrong_step"
    await proceed(0)
    assert (await proceed(0, accepted=False)).reason == "tutorial_not_paused"
    assert (await cast(Spell.INCENDIO)).reason == "tutorial_spell_required"
    assert await cast(Spell.STUPEFY) is None
    assert (await proceed(0, accepted=False)).reason == "tutorial_not_paused"
    assert (await cast(Spell.STUPEFY)).reason == "tutorial_wait_for_effect"
    hit = await tick(now + 2_000)
    assert hit.players["P2"].hp == 86 and hit.tutorial.stage == "complete"
    assert hit.players["P2"].stunned_until_ms == 0, "lessons roll no variance"
    remaining = hit.players["P1"].cooldown_until_ms["stupefy"] - now
    paused = await tick(now + 120_000)
    assert paused.tutorial.stage == "complete" and paused.players["P2"].hp == 86
    assert max(0, paused.players["P1"].cooldown_until_ms["stupefy"] - now) == max(0, remaining)

    # Protego only succeeds on a real block. A miss pauses and offers a checkpoint retry.
    await proceed(0)
    assert (await room.current_snapshot(now)).tutorial.spell is Spell.PROTEGO
    await proceed(1)
    await tick(now + 1_500)
    assert room.engine.projectiles[0].caster is Slot.P2
    assert room.engine.projectiles[0].spell is Spell.INCENDIO, "a slow, visible first fireball"
    miss = await tick(now + 1_800)
    assert miss.players["P1"].hp == 78 and miss.tutorial.stage == "instruction"
    assert miss.players["P1"].burn_until_ms > 0
    await tick(now + 120_000)
    await proceed(1)
    assert room.engine.players[Slot.P1].hp == 100
    assert room.engine.players[Slot.P1].burn_until_ms == 0, "the retry clears the burn"
    await tick(now + 1_500)
    await tick(now + 1_300)
    assert not room.engine.projectiles, "after a miss the rival waits for the raised shield"
    assert await cast(Spell.PROTEGO) is None
    assert room.engine.projectiles and room.engine.projectiles[0].spell is Spell.STUPEFY
    blocked = await tick(now + 800)
    assert blocked.players["P1"].hp == 100 and blocked.tutorial.stage == "complete"
    assert any(e.type == "impactBlocked" and e.target is Slot.P1 for e in blocked.recent_events)
    guard_cd = blocked.players["P1"].cooldown_until_ms["protego"] - now
    after_reading = await tick(now + 10_000)
    assert after_reading.players["P1"].cooldown_until_ms["protego"] - now == guard_cd

    # Episkey has to heal actual incoming damage, not cast into full health.
    await proceed(1)
    await proceed(2)
    await cast(Spell.EPISKEY)
    assert room._tutorial.stage == "practice" and room.engine.players[Slot.P1].hp == 100
    await tick(now + 1_500)
    for _ in range(8):
        # The rival's own Stupefy cooldown from the shield lesson may still be recovering.
        if any(p.caster is Slot.P2 for p in room.engine.projectiles):
            break
        await tick(now + 250)
    assert room.engine.projectiles and room.engine.projectiles[0].caster is Slot.P2
    hurt = await tick(room.engine.projectiles[0].impact_at_ms)
    assert hurt.players["P1"].hp == 86
    assert await cast(Spell.EPISKEY) is None
    healed = await room.current_snapshot(now)
    assert healed.players["P1"].hp == 100 and healed.tutorial.stage == "complete"
    assert any(e.type == "healed" and e.amount == 14 for e in healed.recent_events)

    # Disarm is completed by its real offense lock, and Incendio by its 22 damage.
    await proceed(2)
    await proceed(3)
    await cast(Spell.EXPELLIARMUS)
    disarmed = await tick(now + 1_100)
    assert disarmed.players["P2"].hp == 78 and disarmed.tutorial.stage == "complete"
    assert disarmed.players["P2"].offense_locked_until_ms == now + 2_500
    await proceed(3)
    await proceed(4)
    await cast(Spell.INCENDIO)
    burned = await tick(now + 1_800)
    assert burned.players["P2"].hp == 56 and burned.tutorial.stage == "complete"
    assert burned.players["P2"].burn_until_ms == now + 4_000
    await proceed(4)
    briefing = await tick(now + 70_000)
    assert briefing.tutorial.step == 5 and briefing.tutorial.spell is None
    assert briefing.phase is Phase.PLAYING and briefing.tutorial.paused
    assert briefing.players["P2"].hp == 56, "a paused lesson never burns"
    assert briefing.powerup is None
    await proceed(5)
    free = await room.current_snapshot(now)
    assert free.tutorial.stage == "free" and free.round_ends_at_ms == now + 45_000
    assert free.players["P1"].hp == free.players["P2"].hp == 100
    assert free.players["P2"].burn_until_ms == 0
    assert all(value == 0 for player in free.players.values() for value in player.cooldown_until_ms.values())
    assert room.engine.variance and room.engine.powerup_spawn_at_ms is not None
    assert await cast(Spell.INCENDIO) is None
    await tick(now + 12_000)
    assert any(e.actor is Slot.P2 and e.type == "castAccepted" for e in room.engine.recent_events)
    finished = await tick(free.round_ends_at_ms)
    assert finished.phase is Phase.RESULT and finished.result.reason in ("timeout", "knockout")

    # Rematch restarts instruction zero with normal 100 HP countdown.
    await room.submit_ready(peer=peer, message=_ready("tutorial-wand"), receipt_ms=now)
    restarted = await tick(now)
    assert restarted.round_id == 2 and restarted.phase is Phase.COUNTDOWN
    assert restarted.tutorial.step == 0 and restarted.tutorial.stage == "instruction"
    assert restarted.players["P1"].hp == restarted.players["P2"].hp == 100


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["heartbeat", "unhealthy", "disconnect"])
async def test_tutorial_pauses_keep_real_input_failure_abort_and_lease_semantics(failure):
    from phantom_host.duel_models import TutorialContinueMessage

    room = DuelRoom(clock_ms=FakeClock(), mode=Mode.TUTORIAL)
    session = await room.create_session(name="Learner", source=Source.BLE)
    peer = GamePeer()
    await room.attach(token=session.token, peer=peer, now_ms=0)
    await room.submit_ready(peer=peer, message=_ready("tutorial-wand"), receipt_ms=0)
    await room.tick(0)
    await room.heartbeat(peer=peer, message=_heartbeat(), receipt_ms=3_000)
    await room.tick(3_000)
    assert (await room.current_snapshot(3_000)).tutorial.paused
    if failure == "unhealthy":
        await room.heartbeat(peer=peer, message=_heartbeat(healthy=False), receipt_ms=3_100)
        denied = await room.submit_tutorial_continue(
            peer=peer, message=TutorialContinueMessage(round_id=1, step=0), receipt_ms=3_100,
        )
        assert denied.reason == "input_unhealthy"
        await room.tick(3_100)
    elif failure == "disconnect":
        await room.detach(peer=peer, now_ms=3_100)
        await room.tick(3_100)
    else:
        denied = await room.submit_tutorial_continue(
            peer=peer, message=TutorialContinueMessage(round_id=1, step=0), receipt_ms=4_500,
        )
        assert denied.reason == "input_unhealthy"
        await room.tick(4_500)
    assert room.engine.phase is Phase.RESULT and room.engine.result.outcome.value == "aborted"
    assert room.engine.projectiles == []
    if failure == "disconnect":
        replacement = GamePeer()
        welcome = await room.attach(token=session.token, peer=replacement, now_ms=3_200)
        assert welcome.mode is Mode.TUTORIAL and welcome.snapshot.result.outcome.value == "aborted"
        await room.detach(peer=replacement, now_ms=3_300)
        await room.tick(3_300 + SESSION_LEASE_MS)
        assert not room.has_sessions() and room.engine.players == {}
