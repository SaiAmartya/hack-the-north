#!/usr/bin/env python3
"""Plan the NFC shrine stickers: 100 NDEF text payloads with weighted rarities.

    python tools/nfc_tags.py                 # writes dist/shrine_tags.csv (+ prints a summary)
    python tools/nfc_tags.py --count 40 --seed 3

Write each payload as an NDEF *Text* record (language "en") with the NFC Tools app
(Write > Add a record > Text) or with the altar Arduino:
    python -m phantom_host.altar --port COM7 --batch dist/shrine_tags.csv

Payload grammar understood by the badge (badge/phantom_arena/main.lua, handle_tag):
    pa:loot:<item>:<qty>     item = p|e|k or potion|ember|cloak, qty 1-9
    pa:decree:<card>:<secs>  card = 1-based index into deck.txt, secs 0-90
One pickup per sticker per badge (the badge remembers tag UIDs in appdata/claimed.txt).
"""
from __future__ import annotations

import argparse
import csv
import random
from collections import Counter
from pathlib import Path

ITEMS = {"p": ("Potion", 50), "e": ("Ember Core", 30), "k": ("Phase Cloak", 20)}
QTY = {1: 70, 2: 25, 3: 5}


def plan(count: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    items = [k for k, (_, w) in ITEMS.items() for _ in range(w)]
    qtys = [q for q, w in QTY.items() for _ in range(w)]
    rows = []
    for i in range(1, count + 1):
        item, qty = rng.choice(items), rng.choice(qtys)
        rows.append({"sticker": f"S{i:03d}", "item": ITEMS[item][0], "qty": qty, "payload": f"pa:loot:{item}:{qty}",
                     "hint": rng.choice(["stairwell", "sponsor booth", "water station", "library", "hardware lab", "quiet room", "food line", "lounge"])})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "dist" / "shrine_tags.csv"))
    a = ap.parse_args()
    rows = plan(a.count, a.seed)
    out = Path(a.out)
    out.parent.mkdir(exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    c = Counter(f"{r['item']} x{r['qty']}" for r in rows)
    print(f"wrote {len(rows)} stickers to {out}")
    for k, n in sorted(c.items()):
        print(f"  {n:3d}  {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
