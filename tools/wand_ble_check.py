#!/usr/bin/env python3
"""Laptop-side transport gate for the wand badge over BLE (no browser needed).

    uv run --python 3.12 --with bleak python tools/wand_ble_check.py            # first WAND-xxxx it sees
    uv run --python 3.12 --with bleak python tools/wand_ble_check.py --name WAND-46BA --seconds 5

Walks the whole BADGE-FIRMWARE-CONTRACT.md v1 session from a laptop: scan, connect, read INFO,
subscribe STATUS + MOTION, OPEN, SYNC x5 (clock offset + RTT), SET_STATE playing, CUE cast,
stream motion for a few seconds (rate, sequence gaps, discontinuities), SET_STATE won + result
CUE, disconnect. Prints PASS/FAIL lines and exits non-zero on any failure.

Chrome must not be connected to the badge at the same time (one connection).
"""
from __future__ import annotations

import argparse
import asyncio
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
RESULT_NAMES = ["ok", "malformed", "wrong session", "invalid arg", "expired", "unsupported", "stale seq"]

failures: list[str] = []


def check(cond: bool, what: str, detail: str = "") -> None:
    line = f"{'PASS' if cond else 'FAIL'} {what}" + (f"  ({detail})" if detail else "")
    print(line, flush=True)
    if not cond:
        failures.append(what)


class Link:
    def __init__(self, client) -> None:
        self.client = client
        self.seq = 65535  # next_seq() makes the initial OPEN exactly zero.
        self.nonce = random.randrange(1, 2**32)
        self.results: dict[int, tuple[wp.Status, float]] = {}
        self.health: list[wp.Status] = []
        self.motion: list[tuple[wp.Motion, float]] = []
        self.raw_motion_bad = 0
        self.result_event = asyncio.Event()
        self.offset_ms = 0.0  # device_ms - host_ms
        self.loop = asyncio.get_running_loop()

    def on_status(self, _sender, data: bytearray) -> None:
        s = wp.decode_status(bytes(data))
        if s is None:
            print(f"STATUS malformed: {bytes(data).hex()}")
            return
        if s.kind == 1:
            self.results[s.seq] = (s, time.monotonic())
            self.result_event.set()
        else:
            self.health.append(s)

    def on_motion(self, _sender, data: bytearray) -> None:
        m = wp.decode_motion(bytes(data))
        if m is None:
            self.raw_motion_bad += 1
            return
        self.motion.append((m, time.monotonic()))

    def next_seq(self) -> int:
        self.seq = (self.seq + 1) & 0xFFFF
        return self.seq

    def device_now(self) -> int:
        return int(time.monotonic() * 1000 + self.offset_ms) & 0xFFFFFFFF

    async def command(self, opcode: int, a0: int = 0, a1: int = 0, a2: int = 0, timeout: float = 1.5) -> tuple[wp.Status | None, float]:
        seq = self.next_seq()
        rec = wp.encode_control(wp.Control(opcode, seq, self.nonce, a0, a1, a2))
        self.result_event.clear()
        t0 = time.monotonic()
        await self.client.write_gatt_char(CONTROL, rec, response=True)
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
        st, t1 = self.results[seq]
        return st, (t1 - t0) * 1000


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", help="badge name (default: first WAND-* found)")
    ap.add_argument("--seconds", type=float, default=4.0, help="how long to stream motion")
    ap.add_argument("--scan", type=float, default=8.0, help="scan timeout")
    a = ap.parse_args()
    if not 1 <= a.seconds <= 600:
        ap.error("--seconds must be between 1 and 600")

    from bleak import BleakClient, BleakScanner

    print(f"scanning {a.scan:.0f} s for {a.name or 'WAND-*'} ...", flush=True)
    found = await BleakScanner.discover(timeout=a.scan, return_adv=True)
    target = None
    for dev, adv in found.values():
        name = adv.local_name or dev.name or ""
        if name.startswith("WAND-") and (a.name is None or name == a.name):
            target = (dev, adv, name)
            break
    check(target is not None, "badge advertising", f"{len(found)} BLE devices seen")
    if target is None:
        return 1
    dev, adv, name = target
    print(f"found {name} {dev.address} rssi={adv.rssi} services={adv.service_uuids}")
    check(SERVICE in [u.lower() for u in adv.service_uuids], "service UUID in advertisement")

    async with BleakClient(dev, timeout=15.0) as client:
        check(client.is_connected, "connected")
        link = Link(client)

        raw = bytes(await client.read_gatt_char(INFO))
        info = wp.decode_info(raw)
        check(info is not None, "INFO decodes", raw.hex())
        if info is None:
            return 1
        print(f"INFO caps=0x{info.caps:02x} hz={info.sample_hz} range={info.range_g}g id={info.device_id.hex()} boot={info.boot_id:08x} fw={info.fw} axes={info.axis_convention}")
        check(info.caps == wp.CAP_ALL and info.sample_hz == 50 and info.range_g == 8 and info.axis_convention == 1, "INFO profile matches contract")
        check(name.endswith(info.device_id.hex()[-4:].upper()), "name suffix matches device id", name)

        await client.start_notify(STATUS, link.on_status)
        await client.start_notify(MOTION, link.on_motion)
        await asyncio.sleep(0.3)
        check(len(link.motion) == 0, "no motion before OPEN", f"{len(link.motion)} frames")

        st, rtt = await link.command(wp.OP_OPEN)
        check(st is not None and st.detail1 == wp.R_OK and st.detail0 == wp.OP_OPEN, "OPEN accepted", f"rtt {rtt:.0f} ms, result {st}")
        if st is None:
            return 1

        # SYNC x5: clock offset from the lowest-RTT sample
        samples = []
        for _ in range(5):
            t0 = time.monotonic()
            st, rtt = await link.command(wp.OP_SYNC)
            if st is None or st.detail1 != wp.R_OK:
                continue
            host_mid_ms = (t0 + rtt / 2000) * 1000
            samples.append((rtt, st.device_ms - host_mid_ms))
        check(len(samples) >= 3, "SYNC replies", f"{len(samples)}/5")
        if samples:
            samples.sort()
            link.offset_ms = samples[0][1]
            rtts = [s[0] for s in samples]
            print(f"SYNC rtt min/median/max = {min(rtts):.0f}/{statistics.median(rtts):.0f}/{max(rtts):.0f} ms, offset {link.offset_ms:.0f} ms, uncertainty +/-{samples[0][0] / 2:.0f} ms")
            check(min(rtts) <= 100, "SYNC round trip meets 100 ms setup limit")

        epoch = 7
        st, _ = await link.command(wp.OP_SET_STATE, wp.set_state_args(wp.PH_PLAYING, 100, 0, 100), epoch, link.device_now() + 1200)
        check(st is not None and st.detail1 == wp.R_OK, "SET_STATE playing accepted", f"{st}")
        st, _ = await link.command(wp.OP_CUE, wp.cue_args(wp.FX_ACCEPTED_CAST, wp.SP_STUPEFY, 700), epoch, link.device_now() + 300)
        check(st is not None and st.detail1 == wp.R_OK, "CUE cast Stupefy accepted", f"{st}")
        st, _ = await link.command(wp.OP_CUE, wp.cue_args(wp.FX_ACCEPTED_CAST, wp.SP_STUPEFY, 700), epoch + 1, link.device_now() + 300)
        check(st is not None and st.detail1 == wp.R_INVALID_ARG, "CUE with wrong epoch rejected (3)", f"{st}")
        st, _ = await link.command(wp.OP_CUE, wp.cue_args(wp.FX_DAMAGE, wp.SP_NONE, 500), epoch, link.device_now() - 50)
        check(st is not None and st.detail1 == wp.R_EXPIRED, "CUE already due rejected (4)", f"{st}")

        # keep the lease alive while streaming, and measure command round trips under load
        stream_started = time.monotonic()
        t_end = stream_started + a.seconds
        first = len(link.motion)
        load_rtts = []
        while time.monotonic() < t_end:
            await asyncio.sleep(0.45)
            st, rtt = await link.command(wp.OP_SET_STATE, wp.set_state_args(wp.PH_PLAYING, 100, 0, 100), epoch, link.device_now() + 1200)
            if st is not None:
                load_rtts.append(rtt)
            await asyncio.sleep(0.45)
            st, rtt = await link.command(wp.OP_SYNC)
            if st is not None:
                load_rtts.append(rtt)
        if load_rtts:
            load_rtts.sort()
            print(f"command RTT while streaming: min {load_rtts[0]:.0f} median {statistics.median(load_rtts):.0f} max {load_rtts[-1]:.0f} ms over {len(load_rtts)} commands")
            check(statistics.median(load_rtts) < 100, "command RTT under load stays under 100 ms (browser sync policy)", f"median {statistics.median(load_rtts):.0f} ms")
        frames = [m for m, _ in link.motion[first:]]
        elapsed = time.monotonic() - stream_started
        rate = len(frames) / elapsed if elapsed else 0
        check(len(frames) > 0, "MOTION notifications arrive", f"{len(frames)} frames, {link.raw_motion_bad} undecodable")
        if frames:
            gaps = sum(1 for p, n in zip(frames, frames[1:]) if (n.seq - p.seq) % 65536 != 1)
            disc = sum(1 for m in frames if m.discontinuity)
            sat = sum(1 for m in frames if m.saturated)
            boot_ok = all(m.boot_id == info.boot_id for m in frames)
            ax = [m.ax for m in frames]
            ay = [m.ay for m in frames]
            az = [m.az for m in frames]
            print(f"MOTION {len(frames)} frames in {elapsed:.1f} s = {rate:.1f} Hz; seq gaps {gaps}, discontinuity flags {disc}, saturated {sat}")
            print(f"       mean mg x={statistics.mean(ax):.0f} y={statistics.mean(ay):.0f} z={statistics.mean(az):.0f}; last capture_ms {frames[-1].capture_ms}")
            iv = [(n.capture_ms - p.capture_ms) & 0xFFFFFFFF for p, n in zip(frames, frames[1:])]
            if iv:
                span = (frames[-1].capture_ms - frames[0].capture_ms) & 0xFFFFFFFF
                buckets = {}
                for d in iv:
                    b = min(d // 5 * 5, 100)
                    buckets[b] = buckets.get(b, 0) + 1
                print(f"       capture interval ms: mean {statistics.mean(iv):.1f} min {min(iv)} max {max(iv)}; badge-side rate {1000 * len(iv) / span:.1f} Hz; histogram {dict(sorted(buckets.items()))}")
                arrival = [(tb - ta) * 1000 for (_, ta), (_, tb) in zip(link.motion[first:], link.motion[first + 1:])]
                print(f"       host arrival interval ms: mean {statistics.mean(arrival):.1f} max {max(arrival):.0f}")
            check(boot_ok, "MOTION boot_id matches INFO")
            check(40 <= rate <= 60, "MOTION rate about 50 Hz", f"{rate:.1f} Hz")
            check(gaps <= max(2, len(frames) // 50), "MOTION sequence mostly contiguous", f"{gaps} gaps")
            check(all(m.valid for m in frames), "MOTION frames flagged valid")

        st, _ = await link.command(wp.OP_SET_STATE, wp.set_state_args(wp.PH_WON, 100, 0, 100), epoch, link.device_now() + 1200)
        check(st is not None and st.detail1 == wp.R_OK, "SET_STATE won accepted", f"{st}")
        st, _ = await link.command(wp.OP_CUE, wp.cue_args(wp.FX_RESULT, wp.SP_NONE, 900), epoch, link.device_now() + 300)
        check(st is not None and st.detail1 == wp.R_OK, "CUE result accepted", f"{st}")
        st, _ = await link.command(wp.OP_CUE, wp.cue_args(wp.FX_RESULT, wp.SP_NONE, 1500), epoch, link.device_now() + 300)
        check(st is not None and st.detail1 == wp.R_INVALID_ARG, "CUE duration over 1000 ms rejected (3)", f"{st}")
        await asyncio.sleep(1.5)

        h = link.health[-1] if link.health else None
        check(h is not None, "health STATUS notifications", f"{len(link.health)} received")
        if h is not None:
            bits = h.detail1
            print(f"health bits=0x{bits:x} sensor={bool(bits & wp.H_SENSOR)} stream={bool(bits & wp.H_STREAM)} presentation={bool(bits & wp.H_PRESENTATION)} stale={bool(bits & wp.H_STATE_STALE)} dropped={h.detail0}")
            check(bits & wp.H_SENSOR and bits & wp.H_STREAM, "health reports sensor + stream")

        await client.stop_notify(MOTION)
        await client.stop_notify(STATUS)
    print(f"\n{'ALL PASS' if not failures else str(len(failures)) + ' FAILURE(S): ' + ', '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
