"""Serial gateway tests. No badge is attached, so the serial port is faked."""

from __future__ import annotations

import threading

import pytest
from serial import SerialException

from phantom_host.serial_gateway import SerialGateway


class FakeSerial:
    """Yields scripted lines, then behaves like an unplugged device."""

    def __init__(self, lines: list[bytes], *, fail_after: bool = True) -> None:
        self._lines = list(lines)
        self._fail_after = fail_after
        self.closed = False

    def readline(self) -> bytes:
        if self._lines:
            return self._lines.pop(0)
        if self._fail_after:
            raise SerialException("device disconnected")
        return b""

    def close(self) -> None:
        self.closed = True


class RecordingSleep:
    def __init__(self) -> None:
        self.delays: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)


def test_reads_lines_and_hands_them_to_the_callback() -> None:
    received: list[str] = []
    opened = FakeSerial([b"PA1|P1|CAST|F|1\r\n", b"PA1|P1|CAST|A|2\n"])

    gateway = SerialGateway(
        on_line=received.append,
        port="/dev/fake",
        serial_factory=lambda *a, **k: opened,
        sleep=RecordingSleep(),
    )
    gateway.run(threading.Event(), max_reconnects=0)

    assert received == ["PA1|P1|CAST|F|1", "PA1|P1|CAST|A|2"]
    assert opened.closed is True


def test_blank_lines_are_skipped() -> None:
    received: list[str] = []
    gateway = SerialGateway(
        on_line=received.append,
        port="/dev/fake",
        serial_factory=lambda *a, **k: FakeSerial([b"\r\n", b"  \n", b"ok\n"]),
        sleep=RecordingSleep(),
    )
    gateway.run(threading.Event(), max_reconnects=0)
    assert received == ["ok"]


def test_undecodable_bytes_do_not_crash_the_reader() -> None:
    received: list[str] = []
    gateway = SerialGateway(
        on_line=received.append,
        port="/dev/fake",
        serial_factory=lambda *a, **k: FakeSerial([b"\xff\xfePA1|P1|CAST|F|1\n"]),
        sleep=RecordingSleep(),
    )
    gateway.run(threading.Event(), max_reconnects=0)
    assert len(received) == 1
    assert "PA1|P1|CAST|F|1" in received[0]


def test_reconnects_after_a_disconnect_with_capped_exponential_backoff() -> None:
    attempts: list[str] = []
    sleep = RecordingSleep()

    def factory(port: str, *args: object, **kwargs: object) -> FakeSerial:
        attempts.append(port)
        return FakeSerial([b"line\n"])

    gateway = SerialGateway(
        on_line=lambda _line: None,
        port="/dev/fake",
        serial_factory=factory,
        sleep=sleep,
        backoff_initial_s=0.5,
        backoff_max_s=2.0,
    )
    gateway.run(threading.Event(), max_reconnects=5)

    assert len(attempts) == 6, "one initial open plus five reconnects"
    assert sleep.delays == [0.5, 1.0, 2.0, 2.0, 2.0], "doubling, then capped"


def test_a_port_held_by_another_process_is_a_recoverable_condition() -> None:
    """The badge IDE owning the port must not crash the host."""
    calls = {"count": 0}
    sleep = RecordingSleep()

    def factory(*args: object, **kwargs: object) -> FakeSerial:
        calls["count"] += 1
        if calls["count"] == 1:
            raise SerialException("could not open port: Resource busy")
        return FakeSerial([b"PA1|P1|CAST|F|1\n"])

    received: list[str] = []
    gateway = SerialGateway(
        on_line=received.append,
        port="/dev/fake",
        serial_factory=factory,
        sleep=sleep,
    )
    gateway.run(threading.Event(), max_reconnects=1)

    assert received == ["PA1|P1|CAST|F|1"]
    assert len(sleep.delays) >= 1


def test_connected_flag_tracks_the_link_state() -> None:
    seen: list[bool] = []

    def on_line(_line: str) -> None:
        seen.append(gateway.connected)

    gateway = SerialGateway(
        on_line=on_line,
        port="/dev/fake",
        serial_factory=lambda *a, **k: FakeSerial([b"line\n"]),
        sleep=RecordingSleep(),
    )
    assert gateway.connected is False
    gateway.run(threading.Event(), max_reconnects=0)

    assert seen == [True], "connected while reading"
    assert gateway.connected is False, "and disconnected once the link drops"


def test_a_set_stop_event_returns_immediately() -> None:
    stop = threading.Event()
    stop.set()
    opened: list[object] = []

    gateway = SerialGateway(
        on_line=lambda _line: None,
        port="/dev/fake",
        serial_factory=lambda *a, **k: opened.append(1) or FakeSerial([]),
        sleep=RecordingSleep(),
    )
    gateway.run(stop)
    assert opened == []


def test_no_port_found_backs_off_instead_of_raising() -> None:
    sleep = RecordingSleep()
    gateway = SerialGateway(
        on_line=lambda _line: None,
        port=None,
        port_finder=lambda: None,
        serial_factory=lambda *a, **k: pytest.fail("must not open without a port"),
        sleep=sleep,
    )
    gateway.run(threading.Event(), max_reconnects=2)
    assert len(sleep.delays) == 2, "one backoff wait per reconnect attempt"
    assert gateway.connected is False


def test_uses_the_port_finder_when_no_port_is_configured() -> None:
    used: list[str] = []
    gateway = SerialGateway(
        on_line=lambda _line: None,
        port=None,
        port_finder=lambda: "/dev/cu.usbmodem1234",
        serial_factory=lambda port, *a, **k: used.append(port) or FakeSerial([]),
        sleep=RecordingSleep(),
    )
    gateway.run(threading.Event(), max_reconnects=0)
    assert used == ["/dev/cu.usbmodem1234"]
