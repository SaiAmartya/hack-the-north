"""Where base-station lines come from: a USB serial badge, a replay file, or the simulator."""
from __future__ import annotations

import random
import sys
import threading
import time
from pathlib import Path
from typing import Callable

OnLine = Callable[[str], None]
ESPRESSIF_VID = 0x303A


def find_badge_port() -> str | None:
    """Pick the Espressif USB JTAG/serial port if present, else the first serial port."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    ports = list(list_ports.comports())
    for p in ports:
        if p.vid == ESPRESSIF_VID or "JTAG" in (p.description or "") or "Espressif" in (p.description or ""):
            return p.device
    return ports[0].device if ports else None


class SerialSource:
    """Reads lines from the pa_base badge; reconnects with capped backoff."""

    def __init__(self, port: str = "auto", baud: int = 115200):
        self.port_arg = port
        self.baud = baud
        self.connected = False
        self.port: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.lines = 0

    def start(self, on_line: OnLine) -> None:
        self._thread = threading.Thread(target=self._run, args=(on_line,), daemon=True, name="serial")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self, on_line: OnLine) -> None:
        import serial
        backoff = 0.5
        while not self._stop.is_set():
            port = find_badge_port() if self.port_arg == "auto" else self.port_arg
            if not port:
                time.sleep(backoff)
                backoff = min(5.0, backoff * 1.5)
                continue
            try:
                with serial.Serial(port, self.baud, timeout=1) as ser:
                    self.port, self.connected, backoff = port, True, 0.5
                    print(f"[serial] connected to {port}", file=sys.stderr)
                    while not self._stop.is_set():
                        raw = ser.readline()
                        if not raw:
                            continue
                        line = raw.decode("utf-8", errors="replace").strip()
                        if line:
                            self.lines += 1
                            on_line(line)
            except (serial.SerialException, OSError) as e:
                print(f"[serial] {e}; retrying in {backoff:.1f}s", file=sys.stderr)
            self.connected = False
            time.sleep(backoff)
            backoff = min(5.0, backoff * 1.5)


class ReplaySource:
    """Replays a saved serial log (one PARX line per line), optionally in real time."""

    def __init__(self, path: str | Path, realtime: bool = True, loop: bool = True):
        self.path = Path(path)
        self.realtime = realtime
        self.loop = loop
        self.connected = True
        self._stop = threading.Event()

    def start(self, on_line: OnLine) -> None:
        threading.Thread(target=self._run, args=(on_line,), daemon=True, name="replay").start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self, on_line: OnLine) -> None:
        while not self._stop.is_set():
            for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
                if self._stop.is_set():
                    return
                if line.strip():
                    on_line(line.strip())
                if self.realtime:
                    time.sleep(0.15)
            if not self.loop:
                return
            time.sleep(2)


class SimSource:
    """Runs the real badge Lua in the simulator with a few bot mages, in real time.

    Everything the arena shows in this mode comes from the actual app code, not a
    mock: casts, host election, snapshots, decrees and loot all flow through the
    same 44-byte frames a base station would relay.
    """

    NAMES = ["Ada", "Linus", "Grace", "Alan"]

    def __init__(self, app_dir: str | Path, players: int = 3, speed: float = 1.0, seed: int = 1, raid: bool = False):
        self.app_dir = Path(app_dir)
        self.players = max(1, min(8, players))
        self.speed = speed
        self.rng = random.Random(seed)
        self.raid = raid
        self.connected = True
        self._stop = threading.Event()
        self.world = None

    def start(self, on_line: OnLine) -> None:
        threading.Thread(target=self._run, args=(on_line,), daemon=True, name="sim").start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self, on_line: OnLine) -> None:
        from badge_sim import World
        w = World(default_rssi=-52, seed=self.rng.randrange(1 << 30))
        self.world = w
        w.listeners.append(lambda t, mac, rssi, p: on_line(f"PARX|{mac}|{rssi}|{p}"))
        badges = [w.add_badge(self.app_dir, f"AA:BB:CC:DD:00:{i + 1:02X}", name=self.NAMES[i % 4] + ("" if i < 4 else str(i)))
                  for i in range(self.players)]
        for b in badges:
            b.open()
        spells = ["UP", "UP", "B", "DOWN", "LEFT", "RIGHT", "START"]
        next_action = 4000
        started_at = None
        boss_set = False
        while not self._stop.is_set():
            t0 = time.perf_counter()
            w.step()
            now = w.now
            if now >= next_action:
                next_action = now + self.rng.randint(900, 2600)
                b = self.rng.choice(badges)
                if self.raid and not boss_set and now > 3000:
                    b.click("START")
                    for _ in range(3):
                        b.click("DOWN")
                    b.click("A")
                    b.click("B")
                    boss_set = True
                elif started_at is None and now > 6000 and len(badges) > 1:
                    b.click("START")
                    if self.raid:
                        b.click("DOWN")
                        b.click("DOWN")
                    b.click("A")
                    started_at = now
                elif b.open_state:
                    r = self.rng.random()
                    if r < 0.12:
                        w.tap(b)
                    elif r < 0.18:
                        w.shake(b)
                    elif r < 0.3:
                        b.click(self.rng.choice(["LEFT", "RIGHT"]))
                    else:
                        w.button_cast(b, self.rng.choice(spells), hold_ms=self.rng.choice([300, 600, 1100]))
                if started_at is not None and now - started_at > 90000:
                    started_at = None  # let the next start request happen after the match ends
            elapsed = time.perf_counter() - t0
            time.sleep(max(0.0, 0.02 / self.speed - elapsed))
