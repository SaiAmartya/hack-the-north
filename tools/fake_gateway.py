#!/usr/bin/env python3
"""Pretend to be the gateway badge, so the whole system can run with no hardware.

Opens a pseudo terminal and writes exactly what phantom_gateway.lua would write:
the slug tag, the sender's BLE address, then the packet, with every packet sent
three times 40 ms apart.

    python tools/fake_gateway.py

It prints the device path to point the host at, then plays a full duel on a loop:
reset, both players ready, spells traded, a judge event, someone wins, repeat.

    PHANTOM_SERIAL_PORT=/dev/ttys003 PHANTOM_CAMERA_ENABLED=0 \
        uvicorn phantom_host.main:app --host 127.0.0.1 --port 8000

It loops on purpose. Anything written to the pty before the host opens the other
end is lost, so a single-shot script would miss its own READY packets whenever
the host starts second. Each cycle begins with a reset, so attaching at any
moment lands you in a clean match within one cycle.
"""

from __future__ import annotations

import argparse
import os
import pty
import sys
import time

SEND_REPEATS = 3
SEND_SPACING_S = 0.04

MACS = {
    "P1": "AA:BB:CC:00:00:01",
    "P2": "AA:BB:CC:00:00:02",
    "J": "AA:BB:CC:00:00:03",
}

Step = tuple[float, str, str, str]  # (delay before sending, sender, kind, value)


def duel_script() -> list[Step]:
    """One full cycle: reset, ready up, then trade spells until someone drops.

    Fireball is 18 damage and costs 20 mana against 8 mana/second regeneration,
    so roughly 2.6 s between casts is sustainable. Six landed Fireballs take a
    player from 100 to 0.
    """
    steps: list[Step] = [
        (1.5, "J", "EVT", "RST"),
        (0.5, "P1", "READY", "1"),
        (0.5, "P2", "READY", "1"),
        (3.5, "P1", "CAST", "F"),  # countdown is 3 s, so this lands in play
    ]

    for round_index in range(9):
        steps.append((1.3, "P2", "CAST", "F"))
        steps.append((1.3, "P1", "CAST", "F"))
        if round_index == 2:
            steps.append((0.6, "J", "EVT", "MET"))
        if round_index == 4:
            steps.append((0.6, "P2", "CAST", "S"))
        if round_index == 6:
            steps.append((0.6, "J", "EVT", "DBL"))

    steps.append((2.5, "P1", "CAST", "A"))
    return steps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--once", action="store_true", help="play one duel instead of looping"
    )
    parser.add_argument(
        "--speed", type=float, default=1.0, help="time multiplier (2 = twice as fast)"
    )
    parser.add_argument("--quiet", action="store_true", help="do not print each packet")
    args = parser.parse_args()
    speed = max(0.01, args.speed)

    master, slave = pty.openpty()
    device = os.ttyname(slave)

    print(f"fake gateway on {device}")
    print()
    print("point the host at it:")
    print(f"  PHANTOM_SERIAL_PORT={device} PHANTOM_CAMERA_ENABLED=0 \\")
    print("      uvicorn phantom_host.main:app --host 127.0.0.1 --port 8000")
    print()
    print("Ctrl-C to stop.", flush=True)
    print()

    sequences = {"P1": 0, "P2": 0, "J": 0}
    script = duel_script()
    cycle = 0

    try:
        while True:
            cycle += 1
            if not args.quiet:
                print(f"--- duel {cycle} ---", flush=True)

            for delay, sender, kind, value in script:
                time.sleep(delay / speed)

                sequence = sequences[sender]
                sequences[sender] = (sequence + 1) % 256
                payload = f"PA1|{sender}|{kind}|{value}|{sequence}"
                line = f"[phantom_gateway] {MACS[sender]} {payload}\r\n"

                # Three copies, exactly like the badge's tick-driven send queue.
                for copy in range(SEND_REPEATS):
                    os.write(master, line.encode())
                    if copy < SEND_REPEATS - 1:
                        time.sleep(SEND_SPACING_S / speed)

                if not args.quiet:
                    print(f"  {payload} x{SEND_REPEATS}", flush=True)

            if args.once:
                print("\nduel finished. Ctrl-C to exit.", flush=True)
                while True:
                    time.sleep(1.0)

            time.sleep(3.0 / speed)

    except KeyboardInterrupt:
        print("\nstopped")
        return 0
    finally:
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    sys.exit(main())
