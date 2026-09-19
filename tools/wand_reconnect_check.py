"""Bounded, real-badge reconnect QA. Never flashes or modifies stored settings.

Requires the same Python/Bleak environment as wand_ble_check.py. Close Chrome's
badge connection first. A pass qualifies these native reconnects only, not Chrome,
battery endurance, six-face axes or a second central.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="Exact displayed WAND-xxxx name")
    parser.add_argument("--cycles", type=int, default=20)
    parser.add_argument("--seconds", type=int, default=2)
    args = parser.parse_args()
    if not re.fullmatch(r"WAND-[0-9A-F]{4}", args.name):
        parser.error("Use the exact displayed WAND-xxxx identifier")
    if not 1 <= args.cycles <= 20 or not 1 <= args.seconds <= 60:
        parser.error("Cycles must be 1..20 and seconds 1..60")
    checker = Path(__file__).with_name("wand_ble_check.py")
    for cycle in range(1, args.cycles + 1):
        print(f"Reconnect {cycle}/{args.cycles}: {args.name}", flush=True)
        try:
            result = subprocess.run(
                [sys.executable, str(checker), "--name", args.name,
                 "--scan", "3", "--seconds", str(args.seconds)],
                capture_output=True, text=True, timeout=args.seconds + 40,
            )
        except subprocess.TimeoutExpired:
            print("FAIL: bounded connection test timed out", flush=True)
            return 1
        for line in result.stdout.splitlines():
            if line.startswith(("MOTION ", "SYNC rtt", "FAIL", "ALL PASS")):
                print(line, flush=True)
        if result.returncode:
            print("FAIL: reconnect gate stopped; run the single-link checker for diagnostics", flush=True)
            return 1
    print(f"PASS: {args.cycles} native connect/OPEN/SYNC/stream/feedback/disconnect cycles", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
