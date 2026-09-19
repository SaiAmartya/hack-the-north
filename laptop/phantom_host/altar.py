"""Oracle Altar bridge (Tier 2): an Arduino with a PN532 rewrites one NFC tag whenever the
Game Master issues a decree. Players tap the altar to receive the mutation on their badge.

Serial protocol to the Arduino (see altar/altar.ino):
    laptop -> arduino:  W|<ndef text>\\n      write this text record to the tag on the reader
    arduino -> laptop:  OK|<text>  or  ERR|<reason>  or  READY

Also usable as a tag-writing station for the loot stickers:
    python -m phantom_host.altar --port COM7 --write pa:loot:e:2
    python -m phantom_host.altar --port COM7 --batch dist/shrine_tags.csv
"""
from __future__ import annotations

import argparse
import csv
import sys
import threading
import time


class AltarBridge:
    def __init__(self, port: str, baud: int = 115200):
        self.port = port
        self.baud = baud
        self._ser = None
        self._lock = threading.Lock()
        self.last_written: str | None = None

    def open(self) -> None:
        import serial
        self._ser = serial.Serial(self.port, self.baud, timeout=3)
        time.sleep(2.0)  # Arduino resets on connect
        self._ser.reset_input_buffer()

    def write_tag(self, text: str, wait: float = 6.0) -> bool:
        """Ask the Arduino to write `text`; returns True on OK."""
        if self._ser is None:
            self.open()
        with self._lock:
            self._ser.write((f"W|{text}\n").encode("ascii", errors="ignore"))
            deadline = time.time() + wait
            while time.time() < deadline:
                line = self._ser.readline().decode("ascii", errors="replace").strip()
                if line.startswith("OK|"):
                    self.last_written = text
                    return True
                if line.startswith("ERR|"):
                    print(f"[altar] {line}", file=sys.stderr)
                    return False
        print("[altar] timeout waiting for the Arduino", file=sys.stderr)
        return False

    def hook(self, ev: dict) -> None:
        """Hub hook: publish every decree to the altar tag."""
        if ev.get("kind") == "decree" and ev.get("v"):
            card = ev.get("card") or {}
            dur = int(card.get("dur", 20) or 20)
            threading.Thread(target=self.write_tag, args=(f"pa:decree:{ev['v']}:{dur}",), daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write NDEF text tags through the altar Arduino")
    ap.add_argument("--port", required=True)
    ap.add_argument("--write", help="one NDEF text to write, e.g. pa:loot:e:2")
    ap.add_argument("--batch", help="CSV from tools/nfc_tags.py; waits for a new tag before each write")
    a = ap.parse_args(argv)
    altar = AltarBridge(a.port)
    altar.open()
    if a.write:
        print("OK" if altar.write_tag(a.write) else "FAILED")
        return 0
    if a.batch:
        with open(a.batch, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        for i, row in enumerate(rows, 1):
            input(f"[{i}/{len(rows)}] place sticker for {row['payload']} on the reader, then press Enter ")
            print("  ->", "OK" if altar.write_tag(row["payload"]) else "FAILED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
