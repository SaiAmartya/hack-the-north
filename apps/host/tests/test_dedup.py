from phantom_host.contracts import RadioEvent
from phantom_host.dedup import PacketDeduper


def event(sequence: int, received_at_ms: int, sender: str = "P1") -> RadioEvent:
    return RadioEvent(
        sender=sender,  # type: ignore[arg-type]
        kind="CAST",
        value="F",
        sequence=sequence,
        received_at_ms=received_at_ms,
    )


def test_accepts_the_first_packet() -> None:
    deduper = PacketDeduper()
    assert deduper.accept(event(17, 1000)) is True


def test_rejects_an_immediate_retry() -> None:
    deduper = PacketDeduper()
    assert deduper.accept(event(17, 1000)) is True
    assert deduper.accept(event(17, 1040)) is False
    assert deduper.accept(event(17, 1080)) is False


def test_accepts_the_same_sequence_again_after_the_window_expires() -> None:
    deduper = PacketDeduper(window_ms=2000)
    assert deduper.accept(event(17, 1000)) is True
    assert deduper.accept(event(17, 1000 + 2000)) is False
    assert deduper.accept(event(17, 1000 + 2001)) is True


def test_treats_senders_independently() -> None:
    deduper = PacketDeduper()
    assert deduper.accept(event(17, 1000, sender="P1")) is True
    assert deduper.accept(event(17, 1000, sender="P2")) is True
    assert deduper.accept(event(17, 1000, sender="J")) is True
    assert deduper.accept(event(17, 1010, sender="P1")) is False


def test_different_sequences_from_one_sender_all_pass() -> None:
    deduper = PacketDeduper()
    for sequence in range(10):
        assert deduper.accept(event(sequence, 1000 + sequence)) is True


def test_evicts_expired_keys_so_the_table_cannot_grow_forever() -> None:
    deduper = PacketDeduper(window_ms=2000)
    for sequence in range(200):
        deduper.accept(event(sequence % 256, 1000 + sequence * 100))
    # 200 packets spaced 100 ms apart spans 20 s; only the last 2 s can be live.
    assert len(deduper) <= 25


def test_a_full_triple_send_burst_applies_exactly_once() -> None:
    """The badge sends each packet three times ~40 ms apart."""
    deduper = PacketDeduper()
    accepted = [deduper.accept(event(5, 1000 + offset)) for offset in (0, 40, 80)]
    assert accepted == [True, False, False]


def test_sequence_wraparound_is_handled_as_a_fresh_packet() -> None:
    deduper = PacketDeduper()
    assert deduper.accept(event(255, 1000)) is True
    assert deduper.accept(event(0, 1500)) is True
    assert deduper.accept(event(1, 2000)) is True


def test_reset_clears_the_table() -> None:
    deduper = PacketDeduper()
    assert deduper.accept(event(17, 1000)) is True
    deduper.reset()
    assert deduper.accept(event(17, 1010)) is True
