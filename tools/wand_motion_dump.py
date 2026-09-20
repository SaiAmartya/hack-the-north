#!/usr/bin/env python3
"""Print live accelerometer samples from a badge over BLE, for input QA (no browser needed).

    uv run --python 3.12 --with bleak python tools/wand_motion_dump.py                 # first WAND-xxxx it sees
    uv run --python 3.12 --with bleak python tools/wand_motion_dump.py --name WAND-B602 --seconds 20
    uv run --python 3.12 --with bleak python tools/wand_motion_dump.py --all --csv jabs.csv

Scans, connects, reads INFO, subscribes STATUS + MOTION, sends OPEN and five SYNC probes, then
streams MOTION records until --seconds elapse or Ctrl-C. Each printed line is one raw sample
straight from the contract's 20-byte record: device capture time, sequence, x/y/z in mg (gravity
included; 1000 mg = 1 g), the vector magnitude, and flags (V valid, S saturated, D discontinuity).
A still badge should read about 1000 mg magnitude with the 1 g on whichever axis points up
(+Z with the screen facing the ceiling). The summary at the end reports rate, sequence gaps,
per-axis extremes and how many samples were invalid or clipped.

Run it from a normal Terminal window on the Mac (Bluetooth permission is per app). Chrome must
not be connected to the same badge at the same time: a badge accepts one central.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import math
import random
import statistics
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
STATE_REFRESH_S = 0.5


class Link:
    """Command sequencing and notification capture for one physical connection."""

    def __init__(self, client) -> None:
        self.client = client
        self.seq = 65535  # next_seq() makes the initial OPEN exactly zero.
        self.nonce = random.randrange(1, 2**32)
        self.results: dict[int, tuple[wp.Status, float]] = {}
        self.result_event = asyncio.Event()
        self.offset_ms = 0.0  # device_ms - host_ms
        self.samples: list[tuple[float, wp.Motion]] = []
        self.malformed = 0
        self.on_sample = lambda host_ms, motion: None

    def on_status(self, _sender, data: bytearray) -> None:
        status = wp.decode_status(bytes(data))
        if status is None:
            print(f"STATUS malformed: {bytes(data).hex()}", flush=True)
            return
        if status.kind == 1:
            self.results[status.seq] = (status, time.monotonic())
            self.result_event.set()

    def on_motion(self, _sender, data: bytearray) -> None:
        motion = wp.decode_motion(bytes(data))
        if motion is None:
            self.malformed += 1
            return
        host_ms = time.monotonic() * 1000
        self.samples.append((host_ms, motion))
        self.on_sample(host_ms, motion)

    def next_seq(self) -> int:
        self.seq = (self.seq + 1) & 0xFFFF
        return self.seq

    def device_now(self) -> int:
        return int(time.monotonic() * 1000 + self.offset_ms) & 0xFFFFFFFF

    async def command(self, opcode: int, a0: int = 0, a1: int = 0, a2: int = 0, timeout: float = 1.5):
        seq = self.next_seq()
        record = wp.encode_control(wp.Control(opcode, seq, self.nonce, a0, a1, a2))
        self.result_event.clear()
        t0 = time.monotonic()
        await self.client.write_gatt_char(CONTROL, record, response=True)
        deadline = t0 + timeout
        while seq not in self.results:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, (time.monotonic() - t0) * 1000
            try:
                await asyncio.wait_for(self.result_event.wait(), remaining)
            except asyncio.TimeoutError:
                pass
            self.result_event.clear()
        status, t1 = self.results[seq]
        return status, (t1 - t0) * 1000


def flags_of(motion: wp.Motion) -> str:
    return "".join(
        letter if condition else "."
        for letter, condition in (("V", motion.valid), ("S", motion.saturated), ("D", motion.discontinuity))
    )


def summarize(samples: list[tuple[float, wp.Motion]], malformed: int) -> None:
    print("\n--- summary ---")
    if not samples:
        print("no motion samples received (was OPEN accepted and MOTION subscribed?)")
        return
    host_span_s = (samples[-1][0] - samples[0][0]) / 1000
    rate = (len(samples) - 1) / host_span_s if host_span_s > 0 else float("nan")
    gaps = 0
    biggest_gap = 0
    previous = None
    for _, motion in samples:
        if previous is not None:
            step = (motion.seq - previous) & 0xFFFF
            if step != 1:
                gaps += 1
                biggest_gap = max(biggest_gap, step - 1)
        previous = motion.seq
    arrivals = [b[0] - a[0] for a, b in zip(samples, samples[1:])]
    valid = [m for _, m in samples if m.valid]
    print(f"samples {len(samples)}  over {host_span_s:.1f} s  = {rate:.1f} Hz  (malformed records {malformed})")
    print(
        f"sequence gaps {gaps} (largest {biggest_gap} missing)  discontinuity flags {sum(m.discontinuity for _, m in samples)}"
        f"  invalid {len(samples) - len(valid)}  saturated {sum(m.saturated for _, m in samples)}"
    )
    if arrivals:
        print(f"arrival gap ms: median {statistics.median(arrivals):.0f}  p95 {sorted(arrivals)[int(0.95 * (len(arrivals) - 1))]:.0f}  max {max(arrivals):.0f}")
    if valid:
        for axis, values in (("x", [m.ax for m in valid]), ("y", [m.ay for m in valid]), ("z", [m.az for m in valid])):
            print(f"{axis}: min {min(values):6d}  mean {statistics.fmean(values):8.1f}  max {max(values):6d} mg")
        magnitudes = [math.sqrt(m.ax**2 + m.ay**2 + m.az**2) for m in valid]
        print(f"|a|: min {min(magnitudes):.0f}  median {statistics.median(magnitudes):.0f}  max {max(magnitudes):.0f} mg (about 1000 when still)")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", help="badge name (default: first WAND-* found)")
    parser.add_argument("--seconds", type=float, default=0, help="stop after this long (default: until Ctrl-C)")
    parser.add_argument("--scan", type=float, default=8.0, help="scan timeout in seconds")
    parser.add_argument("--every", type=int, default=5, help="print every Nth sample (default 5 = 10 lines/s at 50 Hz)")
    parser.add_argument("--all", action="store_true", help="print every sample")
    parser.add_argument("--csv", type=Path, help="also write every sample to this CSV file")
    args = parser.parse_args()
    if args.seconds < 0 or args.seconds > 3600:
        parser.error("--seconds must be between 0 and 3600")
    if args.every < 1:
        parser.error("--every must be at least 1")
    every = 1 if args.all else args.every

    from bleak import BleakClient, BleakScanner

    print(f"scanning {args.scan:.0f} s for {args.name or 'WAND-*'} ...", flush=True)
    found = await BleakScanner.discover(timeout=args.scan, return_adv=True)
    target = None
    for device, advertisement in found.values():
        name = advertisement.local_name or device.name or ""
        if name.startswith("WAND-") and (args.name is None or name == args.name):
            target = (device, advertisement, name)
            break
    if target is None:
        print(f"no badge found among {len(found)} BLE devices. Is it powered on and not connected to Chrome?")
        return 1
    device, advertisement, name = target
    print(f"found {name} {device.address} rssi={advertisement.rssi}")

    writer = None
    csv_file = None
    if args.csv:
        csv_file = args.csv.open("w", newline="")
        writer = csv.writer(csv_file)
        writer.writerow(["host_ms", "capture_ms", "seq", "ax_mg", "ay_mg", "az_mg", "valid", "saturated", "discontinuity"])

    try:
        async with BleakClient(device, timeout=15.0) as client:
            link = Link(client)
            info = wp.decode_info(bytes(await client.read_gatt_char(INFO)))
            if info is None:
                print("INFO did not decode; is this the 0.2.x gameplay image?")
                return 1
            print(
                f"INFO fw={info.fw[0]}.{info.fw[1]}.{info.fw[2]} caps=0x{info.caps:02x} {info.sample_hz} Hz ±{info.range_g} g"
                f" id={info.device_id.hex()} boot={info.boot_id:08x}"
            )
            if info.caps != wp.CAP_ALL:
                print("note: capabilities are not 0x0F, so this is a diagnostic image; samples still print")

            first_capture = {"ms": None}
            count = {"n": 0}

            def on_sample(host_ms: float, motion: wp.Motion) -> None:
                count["n"] += 1
                if first_capture["ms"] is None:
                    first_capture["ms"] = motion.capture_ms
                if writer is not None:
                    writer.writerow([f"{host_ms:.1f}", motion.capture_ms, motion.seq, motion.ax, motion.ay, motion.az, int(motion.valid), int(motion.saturated), int(motion.discontinuity)])
                if count["n"] % every:
                    return
                relative = (motion.capture_ms - first_capture["ms"]) & 0xFFFFFFFF
                magnitude = math.sqrt(motion.ax**2 + motion.ay**2 + motion.az**2)
                print(f"+{relative / 1000:7.3f}s seq {motion.seq:5d}  x {motion.ax:6d}  y {motion.ay:6d}  z {motion.az:6d}  |a| {magnitude:6.0f} mg  {flags_of(motion)}", flush=True)

            link.on_sample = on_sample
            await client.start_notify(STATUS, link.on_status)
            await client.start_notify(MOTION, link.on_motion)

            status, rtt = await link.command(wp.OP_OPEN)
            if status is None or status.detail1 != wp.R_OK:
                print(f"OPEN was not accepted ({status}); no motion will stream")
                return 1
            print(f"OPEN ok in {rtt:.0f} ms")
            probes = []
            for _ in range(5):
                t0 = time.monotonic()
                status, rtt = await link.command(wp.OP_SYNC)
                if status is not None and status.detail1 == wp.R_OK:
                    probes.append((rtt, status.device_ms - (t0 + rtt / 2000) * 1000))
            if probes:
                probes.sort()
                link.offset_ms = probes[0][1]
                print(f"SYNC ok: best round trip {probes[0][0]:.0f} ms, device clock offset {link.offset_ms:.0f} ms")
            print("streaming (move the badge; Ctrl-C to stop) ...", flush=True)

            started = time.monotonic()
            epoch = 1
            try:
                while args.seconds == 0 or time.monotonic() - started < args.seconds:
                    # A live practice state keeps the badge's own display truthful while we stream.
                    await link.command(wp.OP_SET_STATE, wp.set_state_args(wp.PH_PRACTICE, 100, 0, 100), epoch, link.device_now() + 1200)
                    await asyncio.sleep(STATE_REFRESH_S)
            except (KeyboardInterrupt, asyncio.CancelledError):
                pass
            summarize(link.samples, link.malformed)
    except KeyboardInterrupt:
        return 0
    finally:
        if csv_file is not None:
            csv_file.close()
            print(f"wrote {args.csv}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
