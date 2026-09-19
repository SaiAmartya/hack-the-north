"""Read lines from the gateway badge over USB serial.

Runs on its own thread and hands each decoded line to a callback. Reconnects
with capped exponential backoff, because the two most likely failures on demo
day are a replugged cable (the device renumbers) and the badge IDE still holding
the port. Neither should take the host down.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from serial import Serial, SerialException

from phantom_host.config import find_serial_port

logger = logging.getLogger(__name__)

READ_TIMEOUT_S = 0.2


class SerialGateway:
    def __init__(
        self,
        on_line: Callable[[str], None],
        *,
        port: str | None = None,
        baudrate: int = 115200,
        serial_factory: Callable[..., object] | None = None,
        port_finder: Callable[[], str | None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        backoff_initial_s: float = 0.5,
        backoff_max_s: float = 5.0,
        backoff_reset_after_s: float = 2.0,
    ) -> None:
        self._on_line = on_line
        self._port = port
        self._baudrate = baudrate
        self._serial_factory = serial_factory or Serial
        self._port_finder = port_finder or find_serial_port
        self._sleep = sleep
        self._backoff_initial_s = backoff_initial_s
        self._backoff_max_s = backoff_max_s
        self._backoff_reset_after_s = backoff_reset_after_s
        self._connected = False
        self._last_port: str | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def port(self) -> str | None:
        return self._last_port

    def run(self, stop: threading.Event, max_reconnects: int | None = None) -> None:
        """Read until ``stop`` is set.

        ``max_reconnects`` bounds the loop for tests: 0 means open once and do not
        retry, 2 means open three times with two backoff waits in between.
        """
        backoff = self._backoff_initial_s
        reconnects = 0

        while not stop.is_set():
            port = self._port or self._port_finder()

            if port is None:
                logger.debug("no serial port found, retrying in %.1fs", backoff)
            else:
                self._last_port = port
                held_s = self._read_from(port, stop)
                # Only reset the backoff if the link actually lasted. A port that
                # connects and instantly drops would otherwise be hammered at the
                # initial interval forever.
                if held_s is not None and held_s >= self._backoff_reset_after_s:
                    backoff = self._backoff_initial_s

            if stop.is_set():
                return
            if max_reconnects is not None and reconnects >= max_reconnects:
                return

            reconnects += 1
            self._sleep(backoff)
            backoff = min(backoff * 2, self._backoff_max_s)

    def _read_from(self, port: str, stop: threading.Event) -> float | None:
        """Open the port and pump lines.

        Returns how long the link was held in seconds, or None if it never opened.
        """
        try:
            connection = self._serial_factory(
                port, self._baudrate, timeout=READ_TIMEOUT_S
            )
        except SerialException as error:
            # Includes "Resource busy" when the badge IDE still owns the port.
            logger.warning("cannot open %s: %s", port, error)
            return None
        except OSError as error:
            logger.warning("cannot open %s: %s", port, error)
            return None

        self._connected = True
        opened_at = time.monotonic()
        logger.info("gateway connected on %s", port)

        try:
            while not stop.is_set():
                raw = connection.readline()  # type: ignore[attr-defined]
                if not raw:
                    continue
                line = raw.decode("utf-8", errors="replace").strip()
                if line:
                    self._on_line(line)
        except SerialException as error:
            logger.warning("serial link lost: %s", error)
        except OSError as error:
            logger.warning("serial link lost: %s", error)
        finally:
            self._connected = False
            try:
                connection.close()  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover - close must never mask the cause
                pass

        return time.monotonic() - opened_at

    def start(self) -> tuple[threading.Thread, threading.Event]:
        """Run the reader on a daemon thread."""
        stop = threading.Event()
        thread = threading.Thread(
            target=self.run, args=(stop,), name="serial-gateway", daemon=True
        )
        thread.start()
        return thread, stop
