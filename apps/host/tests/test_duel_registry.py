import pytest

from phantom_host.duel_models import Source
from phantom_host.duel_registry import MAX_ROOMS, ROOM_IDLE_MS, RoomRegistry
from phantom_host.duel_room import RoomError


class FakeClock:
    def __init__(self) -> None:
        self.now_ms = 0

    def __call__(self) -> int:
        return self.now_ms


@pytest.mark.asyncio
async def test_rooms_are_independent_and_tokens_resolve_to_their_room():
    clock = FakeClock()
    registry = RoomRegistry(clock_ms=clock)
    first = registry.create_room()
    second = registry.create_room()
    assert first != second and len(registry) == 2

    harry = await registry.room_for_code(first).create_session(name="Harry", source=Source.BLE)
    draco = await registry.room_for_code(second).create_session(name="Draco", source=Source.BLE)
    assert harry.slot.value == "P1" and draco.slot.value == "P1"
    assert harry.room_id == first and draco.room_id == second
    assert registry.room_for_token(harry.token) is registry.room_for_code(first)
    assert registry.room_for_token(draco.token) is registry.room_for_code(second)
    assert registry.session_for_token(harry.token).name == "Harry"
    assert registry.room_for_token("nobody") is None
    assert registry.session_for_token("nobody") is None
    assert registry.room_for_code("ZZZZZZ") is None


@pytest.mark.asyncio
async def test_only_rooms_that_stay_empty_are_reaped():
    clock = FakeClock()
    registry = RoomRegistry(clock_ms=clock)
    idle = registry.create_room()
    busy = registry.create_room()
    await registry.room_for_code(busy).create_session(name="Harry", source=Source.BLE)

    clock.now_ms = 1_000
    await registry.tick_all()
    assert registry.room_for_code(busy).has_sessions()

    # The unattached reservation lapses under the room's own 5 s lease; the room then
    # gets its own idle window from that moment, not from its creation.
    emptied_at = clock.now_ms = 6_000
    await registry.tick_all()
    assert not registry.room_for_code(busy).has_sessions()

    clock.now_ms = ROOM_IDLE_MS - 1
    await registry.tick_all()
    assert registry.room_for_code(idle) is not None

    clock.now_ms = ROOM_IDLE_MS
    await registry.tick_all()
    assert registry.room_for_code(idle) is None
    assert registry.room_for_code(busy) is not None

    clock.now_ms = emptied_at + ROOM_IDLE_MS - 1
    await registry.tick_all()
    assert registry.room_for_code(busy) is not None
    clock.now_ms = emptied_at + ROOM_IDLE_MS
    await registry.tick_all()
    assert registry.room_for_code(busy) is None
    assert len(registry) == 0


def test_room_cap_and_code_shape():
    registry = RoomRegistry(clock_ms=FakeClock())
    codes = {registry.create_room() for _ in range(MAX_ROOMS)}
    assert len(codes) == MAX_ROOMS
    for code in codes:
        assert len(code) == 6
        assert not set(code) & set("01IO")
        assert code.isupper() and code.isalnum()
    with pytest.raises(RoomError) as caught:
        registry.create_room()
    assert caught.value.code == "too_many_rooms" and caught.value.status_code == 429
