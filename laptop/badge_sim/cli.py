"""phantom-sim: watch the real badge app play itself without hardware.

    phantom-sim                          # 3 badges, 60 simulated seconds, battle log + screens
    phantom-sim --players 4 --raid       # one badge becomes the Phantom and a raid starts
    phantom-sim --serial > logs/demo.txt # emit base-station lines (feed them to phantom-host --replay)
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from .world import World

ROOT = Path(__file__).resolve().parents[2]
NAMES = ["Ada", "Linus", "Grace", "Alan", "Radia", "Ken", "Margaret", "Tim"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="phantom-sim", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--app", default=str(ROOT / "badge" / "phantom_arena"))
    ap.add_argument("--players", type=int, default=3)
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--loss", type=float, default=0.1, help="fraction of frames dropped")
    ap.add_argument("--rssi", type=int, default=-50)
    ap.add_argument("--raid", action="store_true")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--serial", action="store_true", help="print base-station PARX lines instead of the summary")
    a = ap.parse_args(argv)

    rng = random.Random(a.seed)
    w = World(loss=a.loss, seed=a.seed, default_rssi=a.rssi)
    badges = [w.add_badge(a.app, f"AA:BB:CC:DD:00:{i + 1:02X}", name=NAMES[i % len(NAMES)]) for i in range(max(1, min(8, a.players)))]
    for b in badges:
        b.open()
    if a.serial:
        w.listeners.append(lambda t, mac, rssi, p: print(f"PARX|{mac}|{rssi}|{p}"))
    w.run(3000)
    if a.raid and len(badges) > 1:
        boss = badges[-1]
        boss.click("START")
        for _ in range(3):
            boss.click("DOWN")
        boss.click("A")
        boss.click("B")
        w.run(1500)
        badges[0].click("START")
        badges[0].click("DOWN")
        badges[0].click("DOWN")
        badges[0].click("A")
    elif len(badges) > 1:
        badges[0].click("START")
        badges[0].click("A")
    spells = ["UP", "UP", "B", "DOWN", "LEFT", "RIGHT", "START"]
    while w.now < a.seconds * 1000:
        b = rng.choice(badges)
        r = rng.random()
        if r < 0.1:
            w.tap(b)
        elif r < 0.15:
            w.shake(b)
        elif r < 0.3:
            b.click(rng.choice(["LEFT", "RIGHT"]))
        else:
            w.button_cast(b, rng.choice(spells), hold_ms=rng.choice([300, 600, 1100]))
        w.run(rng.randint(600, 2200))
    if a.serial:
        return 0
    print(f"== {len(badges)} badges, {w.now // 1000} s simulated, {len(w.transcript)} frames, loss {a.loss:.0%} ==")
    for b in badges:
        print(f"\n--- {b.name} ({b.mac[-5:]}) avg tick {b.tick_time_total / max(1, b.tick_count):.2f} ms, dropped {b.dropped} ---")
        print(b.screen_text())
        if b.violations:
            print("VIOLATIONS:", b.violations)
    kinds = {}
    for _, _, _, p in w.transcript:
        kinds[p[2]] = kinds.get(p[2], 0) + 1
    print("\nframes by kind:", kinds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
