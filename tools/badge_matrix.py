"""Approved 0.1.9 diagnostic matrix only. Never flashes, writes NVS, or qualifies a release.

Keep one serial handle open: reopening this Mac's USB console may reset the badge.
Requires pyserial and bleak. Close the browser's BLE connection first.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import time
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from badge_flash import open_console
from wand_ble_check import Link, INFO, MOTION, STATUS, wp


async def collect(console, duration=0.7):
    def read():
        end = time.monotonic() + duration
        result = bytearray()
        while time.monotonic() < end:
            result.extend(console.read(1024))
            if len(result) > 32000:
                raise RuntimeError("Console output exceeded diagnostic bound")
        return result.decode("utf-8", "replace")
    return await asyncio.to_thread(read)


async def query(console, command, duration=0.7):
    console.write(command.encode("ascii") + b"\r")
    return await collect(console, duration)


async def select_profile(console, profile, mode):
    """Observe the device's disconnect/boot boundaries, not host BLE completion."""
    idle = False
    for _ in range(8):
        state = await query(console, "status", .4)
        if "connected=0 motion_sub=0 status_sub=0" in state:
            idle = True
            break
    if not idle:
        raise RuntimeError("Badge did not acknowledge BLE disconnect; close other centrals")
    # Collect the exact guard/acceptance reply so a rejected row can never be measured.
    expected = f"next_boot profile={profile} ble={mode} caps=0"
    for _ in range(3):
        reply = await query(console, f"profile {profile} {mode}", 2)
        if expected in reply:
            break
        if "disconnect BLE before selecting a boot profile" not in reply:
            raise RuntimeError(f"Profile command was not acknowledged: {reply}")
        await query(console, "status", .5)
    else:
        raise RuntimeError("Badge repeatedly rejected profile selection while connected")
    for _ in range(8):
        state = await query(console, "status", .5)
        if f"profile={profile} ble={mode} caps=0" in state and "sensor=1" in state:
            return state
    raise RuntimeError(f"Accepted diagnostic row did not boot honestly: {state}")


async def loaded(console, name, expected_hz, expected_range, seconds):
    from bleak import BleakClient, BleakScanner
    device = await BleakScanner.find_device_by_filter(lambda d, a: (a.local_name or d.name) == name, timeout=8)
    if device is None:
        raise RuntimeError("Selected badge did not advertise")
    async with BleakClient(device, timeout=15) as client:
        info = wp.decode_info(bytes(await client.read_gatt_char(INFO)))
        if info is None or info.caps != 0 or info.fw != (0, 1, 9) or (info.sample_hz, info.range_g) != (expected_hz, expected_range):
            raise RuntimeError("Diagnostic INFO does not match selected row")
        link = Link(client)
        await client.start_notify(STATUS, link.on_status)
        await client.start_notify(MOTION, link.on_motion)
        result, _ = await link.command(wp.OP_OPEN)
        if not result or result.detail1 != wp.R_OK:
            raise RuntimeError("Diagnostic OPEN failed")
        probes = []
        for _ in range(5):
            before = time.monotonic()
            result, rtt = await link.command(wp.OP_SYNC)
            if result and result.detail1 == wp.R_OK:
                probes.append((rtt, result.device_ms - (before + rtt / 2000) * 1000))
        if not probes:
            raise RuntimeError("No diagnostic clock replies")
        link.offset_ms = min(probes)[1]
        serial_before = await query(console, "status")
        await query(console, "trace reset", .2)
        started, first = time.monotonic(), len(link.motion)
        rtts, failed = [], 0
        while time.monotonic() - started < seconds:
            for opcode, a0, a1, a2 in (
                (wp.OP_SET_STATE, wp.set_state_args(wp.PH_PLAYING, 100, 0, 100), 7, link.device_now() + 1200),
                (wp.OP_CUE, wp.cue_args(wp.FX_ACCEPTED_CAST, wp.SP_STUPEFY, 180), 7, link.device_now() + 300),
                (wp.OP_SYNC, 0, 0, 0),
            ):
                result, rtt = await link.command(opcode, a0, a1, a2)
                failed += int(not result or result.detail1 != wp.R_OK)
                rtts.append(rtt)
            await asyncio.sleep(.4)
        elapsed = time.monotonic() - started
        samples = [sample for sample, _ in link.motion[first:]]
        serial_after = await query(console, "status")
        trace = await query(console, "trace", 1)
        rtts.sort()
        return {"seconds": elapsed, "motion_count": len(samples), "received_hz": len(samples) / elapsed,
                "discontinuity": sum(bool(s.flags & 4) for s in samples),
                "malformed": link.raw_motion_bad, "failed_commands": failed,
                "command_p95_ms": rtts[max(0, int(len(rtts) * .95) - 1)],
                "status_before": serial_before, "status_after": serial_after, "trace": trace}


async def run(args):
    results = []
    with open_console(args.port) as console:
        await collect(console, 2)
        identity = await query(console, "id")
        if "fw=0.1.9" not in identity or args.name not in identity:
            raise RuntimeError("Console is not the selected 0.1.9 diagnostic badge")
        for profile, hz, range_g in [("creator", 100, 2), ("rate", 50, 2), ("range", 50, 8), ("high", 50, 8)]:
            for radio in (False, True):
                mode = "on" if radio else "off"
                print(f"Measuring {profile}: {hz}Hz ±{range_g}g BLE {mode}", flush=True)
                await select_profile(console, profile, mode)
                if radio:
                    row = await loaded(console, args.name, hz, range_g, args.seconds)
                else:
                    await query(console, "trace reset", .2)
                    before = await query(console, "status")
                    await asyncio.sleep(args.seconds)
                    row = {"seconds": args.seconds, "status_before": before, "status_after": await query(console, "status"), "trace": await query(console, "trace", 1)}
                row.update(profile=profile, ble=mode, configured_hz=hz, range_g=range_g)
                results.append(row)
                args.output.write_text(json.dumps({"firmware": "0.1.9", "evidence": "USB-powered diagnostic; no controlled orientation or movement; NOT release acceptance", "rows": results}, indent=2))
                print(json.dumps({k: v for k, v in row.items() if not k.startswith("status") and k != "trace"}), flush=True)
        # Leave a truthful creator baseline rather than an unqualified gameplay profile.
        await select_profile(console, "creator", "on")
    print(f"Saved eight diagnostic comparisons to {args.output}; capabilities remain zero.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--seconds", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 3 <= args.seconds <= 60:
        parser.error("Use 3..60 seconds per row")
    if args.output.exists():
        parser.error("Choose a new result file; existing evidence is not overwritten")
    asyncio.run(run(args))
