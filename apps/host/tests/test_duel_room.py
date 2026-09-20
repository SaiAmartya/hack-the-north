import asyncio

import pytest

from phantom_host.duel_models import (
    CastMessage,
    HeartbeatMessage,
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
    room = DuelRoom(clock_ms=FakeClock(), allow_replay=True)
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
    await advance(5_600)
    hit = await both_snapshots()
    assert hit["players"]["P2"]["hp"] == 40
    assert hit["players"]["P2"]["offenseLockedUntilMs"] == 6_400
    await cast(peers[1], Spell.EPISKEY, 5_601, "heal")
    await cast(peers[1], Spell.PROTEGO, 5_601, "guard")
    await advance(5_601)
    restored = await both_snapshots()
    defender = restored["players"]["P2"]
    assert defender["hp"] == 58
    assert defender["shieldUntilMs"] == 6_801
    assert defender["cooldownUntilMs"]["episkey"] == 17_601
    assert defender["cooldownUntilMs"]["protego"] == 8_601
    assert any(event["type"] == "healed" and event["amount"] == 18 for event in restored["recentEvents"])


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
    assert welcome.connection_generation == 2
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
    assert welcome.connection_generation == 2
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
