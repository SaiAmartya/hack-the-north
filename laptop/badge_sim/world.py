"""A virtual room full of badges: shared clock, broadcast radio with RSSI and loss,
and helpers to inject gestures, taps, shakes and NFC tags."""
from __future__ import annotations

import random
from pathlib import Path
from typing import Callable

from .badge import SimBadge

TICK_MS = 20


class World:
    def __init__(self, loss: float = 0.0, seed: int = 7, default_rssi: int = -50):
        self.now = 0
        self.badges: list[SimBadge] = []
        self.rng = random.Random(seed)
        self.loss = loss
        self.default_rssi = default_rssi
        self.rssi_overrides: dict[tuple[str, str], int] = {}
        self.transcript: list[tuple[int, str, int, str]] = []  # (ms, sender_mac, rssi, payload)
        self.log_lines: list[tuple[int, str, str]] = []  # (ms, badge name, line)
        self.nfc_reads = 0
        self.listeners: list[Callable[[int, str, int, str], None]] = []

    # ---------- setup ----------
    def add_badge(self, app_dir: str | Path, mac: str, name: str = "Ada", **kw) -> SimBadge:
        b = SimBadge(self, app_dir, mac, name=name, seed=len(self.badges) + 1, **kw)
        self.badges.append(b)
        return b

    def set_rssi(self, a: SimBadge, b: SimBadge, rssi: int) -> None:
        self.rssi_overrides[(a.mac, b.mac)] = rssi
        self.rssi_overrides[(b.mac, a.mac)] = rssi

    def rssi(self, sender: SimBadge, receiver: SimBadge) -> int:
        return self.rssi_overrides.get((sender.mac, receiver.mac), self.default_rssi)

    # ---------- radio ----------
    def broadcast(self, sender: SimBadge, payload: str) -> None:
        for b in self.badges:
            if b is sender:
                continue
            if self.loss and self.rng.random() < self.loss:
                continue
            rssi = self.rssi(sender, b)
            b.receive(sender.mac, rssi, payload)
        # a base station hears everything (own listeners simulate the laptop)
        rssi = self.default_rssi
        self.transcript.append((self.now, sender.mac, rssi, payload))
        for fn in self.listeners:
            fn(self.now, sender.mac, rssi, payload)

    def on_log(self, badge: SimBadge, line: str) -> None:
        self.log_lines.append((self.now, badge.name, line))

    def base_station_lines(self) -> list[str]:
        """What the pa_base badge would print over USB serial."""
        return [f"PARX|{mac}|{rssi}|{payload}" for _, mac, rssi, payload in self.transcript]

    # ---------- time ----------
    def step(self, ms: int = TICK_MS) -> None:
        self.now += ms
        for b in self.badges:
            b.tick()

    def run(self, ms: int) -> None:
        steps = max(1, ms // TICK_MS)
        for _ in range(steps):
            self.step()

    # ---------- gestures ----------
    def gesture(self, badge: SimBadge, symbols: list[str], amplitude: int = 900, seg_ms: int = 120,
                rest_ms: int = 80, gravity=(0, 0, 1000), hold_extra_ms: int = 0) -> None:
        """Hold A, play one accelerometer impulse per symbol ("+Y", "-Z", ...), release A."""
        gx, gy, gz = gravity
        badge.accel = (gx, gy, gz)
        badge.press("A")
        self.run(60)
        for sym in symbols:
            sign = 1 if sym[0] == "+" else -1
            axis = sym[1]
            dx, dy, dz = 0, 0, 0
            if axis == "X":
                dx = sign * amplitude
            elif axis == "Y":
                dy = sign * amplitude
            else:
                dz = sign * amplitude
            badge.accel = (gx + dx, gy + dy, gz + dz)
            self.run(seg_ms)
            badge.accel = (gx, gy, gz)
            self.run(rest_ms)
        if hold_extra_ms:
            self.run(hold_extra_ms)
        badge.release("A")
        self.step()

    def button_cast(self, badge: SimBadge, button: str, hold_ms: int = 300) -> None:
        """Fallback casting: hold A, press a direction/B/START, release A."""
        badge.press("A")
        self.run(40)
        badge.click(button)
        self.run(hold_ms)
        badge.release("A")
        self.step()

    def tap(self, badge: SimBadge) -> None:
        badge.tap_pending = True
        self.step()

    def shake(self, badge: SimBadge) -> None:
        badge.shake_pending = True
        self.step()
