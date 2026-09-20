"""Stream a badge's MOTION notifications and print every accelerometer frame.

Signed milli-g per axis exactly as the browser sees them (int16 x/y/z from the MOTION
record), one line per frame at the badge's native 50 Hz, plus an optional CSV.

    uv run --python 3.12 --with bleak python tools/wand_motion_log.py --name WAND-46BA --seconds 10
    uv run --python 3.12 --with bleak python tools/wand_motion_log.py --seconds 15 --csv motion.csv --every 5

Wave the wand while it runs. The summary at the end reports the peak signed value on each
axis so a jab (+x), pull (-x), flick (+z), chop (-z) or slash (-y) is easy to spot.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "host"))
from phantom_host import wand_protocol as wp  # noqa: E402

SERVICE = "7f510000-1b15-4f0d-8f3c-8db47a812000"
INFO = "7f510001-1b15-4f0d-8f3c-8db47a812000"
MOTION = "7f510002-1b15-4f0d-8f3c-8db47a812000"
CONTROL = "7f510003-1b15-4f0d-8f3c-8db47a812000"
STATUS = "7f510004-1b15-4f0d-8f3c-8db47a812000"

LEASE_PING_S = 0.45  # same cadence wand_ble_check.py uses to keep the OPEN lease alive


class Link:
    def __init__(self, client, every: int, writer) -> None:
        self.client = client
        self.every = max(1, every)
        self.writer = writer
        self.seq = 65535
        self.nonce = random.randrange(1, 2**32)
        self.results: dict[int, wp.Status] = {}
        self.result_event = asyncio.Event()
        self.frames: list[wp.Motion] = []
        self.bad = 0
        self.t0: float | None = None
        self.last_seq: int | None = None
        self.gaps = 0

    def on_status(self, _sender, data: bytearray) -> None:
        s = wp.decode_status(bytes(data))
        if s is not None and s.kind == 1:
            self.results[s.seq] = s
            self.result_event.set()

    def on_motion(self, _sender, data: bytearray) -> None:
        m = wp.decode_motion(bytes(data))
        if m is None:
            self.bad += 1
            return
        now = time.monotonic()
        if self.t0 is None:
            self.t0 = now
        if self.last_seq is not None and (m.seq - self.last_seq) % 65536 != 1:
            self.gaps += 1
        self.last_seq = m.seq
        self.frames.append(m)
        mag = round((m.ax**2 + m.ay**2 + m.az**2) ** 0.5)
        flags = "".join(
            ch
            for ch, on in (
                ("V", m.valid),
                ("S", m.saturated),
                ("D", m.discontinuity),
            )
            if on
        )
        if self.writer is not None:
            self.writer.writerow(
                [f"{now - self.t0:.3f}", m.seq, m.capture_ms, m.ax, m.ay, m.az, mag, flags]
            )
        if len(self.frames) % self.every == 0:
            print(
                f"+{now - self.t0:6.3f}s seq={m.seq:5d} cap={m.capture_ms:9d}  "
                f"x={m.ax:6d} y={m.ay:6d} z={m.az:6d}  |a|={mag:5d} mg  {flags}",
                flush=True,
            )

    def next_seq(self) -> int:
        self.seq = (self.seq + 1) & 0xFFFF
        return self.seq

    async def command(self, opcode: int, a0: int = 0, a1: int = 0, a2: int = 0, timeout: float = 1.5):
        seq = self.next_seq()
        rec = wp.encode_control(wp.Control(opcode, seq, self.nonce, a0, a1, a2))
        self.result_event.clear()
        await self.client.write_gatt_char(CONTROL, rec, response=True)
        deadline = time.monotonic() + timeout
        while seq not in self.results:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                await asyncio.wait_for(self.result_event.wait(), remaining)
            except asyncio.TimeoutError:
                pass
            self.result_event.clear()
        return self.results.pop(seq)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", help="badge name (default: first WAND-* found)")
    ap.add_argument("--seconds", type=float, default=10.0, help="how long to stream")
    ap.add_argument("--scan", type=float, default=10.0, help="scan timeout")
    ap.add_argument("--every", type=int, default=1, help="print every Nth frame (CSV always gets all)")
    ap.add_argument("--csv", type=Path, help="also write t_s,seq,capture_ms,x_mg,y_mg,z_mg,mag_mg,flags")
    a = ap.parse_args()
    if not 1 <= a.seconds <= 600:
        ap.error("--seconds must be between 1 and 600")

    from bleak import BleakClient, BleakScanner

    print(f"scanning up to {a.scan:.0f} s for {a.name or 'WAND-*'} ...", flush=True)
    found = {}

    def on_adv(dev, adv):
        n = adv.local_name or dev.name or ""
        if (a.name and n == a.name) or (not a.name and n.startswith("WAND-")):
            found[dev.address] = (dev, adv, n)

    scanner = BleakScanner(on_adv, service_uuids=[SERVICE])
    await scanner.start()
    t_end = time.monotonic() + a.scan
    while not found and time.monotonic() < t_end:
        await asyncio.sleep(0.2)
    await scanner.stop()
    if not found:
        print("no badge found (is it advertising? a dead client leaves connections=1 until `cmd reboot`)")
        return 1
    dev, adv, name = next(iter(found.values()))
    print(f"found {name} {dev.address} rssi={adv.rssi}", flush=True)

    csv_file = None
    writer = None
    if a.csv:
        a.csv.parent.mkdir(parents=True, exist_ok=True)
        csv_file = a.csv.open("w", newline="", encoding="utf-8")
        writer = csv.writer(csv_file)
        writer.writerow(["t_s", "seq", "capture_ms", "x_mg", "y_mg", "z_mg", "mag_mg", "flags"])

    try:
        async with BleakClient(dev, timeout=15.0) as client:
            info = wp.decode_info(bytes(await client.read_gatt_char(INFO)))
            if info is None:
                print("INFO did not decode")
                return 1
            print(
                f"INFO fw={info.fw} hz={info.sample_hz} range={info.range_g}g axes={info.axis_convention} boot={info.boot_id:08x}",
                flush=True,
            )
            link = Link(client, a.every, writer)
            await client.start_notify(STATUS, link.on_status)
            await client.start_notify(MOTION, link.on_motion)
            st = await link.command(wp.OP_OPEN)
            if st is None or st.detail1 != wp.R_OK:
                print(f"OPEN rejected: {st}")
                return 1
            print(
                f"streaming {a.seconds:.0f} s (signed mg; flags V=valid S=saturated D=discontinuity). Wave the wand.",
                flush=True,
            )
            t_stop = time.monotonic() + a.seconds
            while time.monotonic() < t_stop:
                await asyncio.sleep(LEASE_PING_S)
                await link.command(wp.OP_SYNC)
            await client.stop_notify(MOTION)
            await client.stop_notify(STATUS)
    finally:
        if csv_file is not None:
            csv_file.close()

    frames = link.frames
    if not frames:
        print("no MOTION frames received")
        return 1
    elapsed = time.monotonic() - (link.t0 or time.monotonic())
    xs = [m.ax for m in frames]
    ys = [m.ay for m in frames]
    zs = [m.az for m in frames]
    print(
        f"\n{len(frames)} frames in {elapsed:.1f} s = {len(frames) / elapsed:.1f} Hz; seq gaps {link.gaps}; malformed {link.bad}"
    )
    print(f"x: min {min(xs):6d}  max {max(xs):6d}  mean {sum(xs) / len(xs):7.0f}")
    print(f"y: min {min(ys):6d}  max {max(ys):6d}  mean {sum(ys) / len(ys):7.0f}")
    print(f"z: min {min(zs):6d}  max {max(zs):6d}  mean {sum(zs) / len(zs):7.0f}")
    if a.csv:
        print(f"csv: {a.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
