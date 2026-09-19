#!/usr/bin/env python3
"""Badge bring-up monitor. Read raw serial from the gateway badge and diagnose it.

    python tools/badge_monitor.py              # auto-detect, run until Ctrl-C
    python tools/badge_monitor.py --seconds 20
    python tools/badge_monitor.py --port /dev/cu.usbmodem1101
    python tools/badge_monitor.py --raw        # show every line, not just interesting ones

This is the first thing to run when a badge is plugged in. It answers, in order:

1. Is the port there and can we open it? (If not: the Badge IDE probably owns it.)
2. Is the badge printing anything at all? (Proves the USB cable carries data.)
3. What firmware is installed? Builds before 2026-09-16 allow 6 ms per tick
   instead of 250 ms, which changes what a badge app can afford to do.
4. Did radio.enable() succeed? A successful USB push does not prove it did.
5. Do the packets our own parser expects actually arrive, and do the triple-send
   copies get de-duplicated the way the host assumes?
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from collections import Counter
from pathlib import Path

HOST_DIR = Path(__file__).resolve().parents[1] / "apps" / "host"
if str(HOST_DIR) not in sys.path:
    sys.path.insert(0, str(HOST_DIR))

import serial  # noqa: E402
from serial import SerialException  # noqa: E402

from phantom_host.config import find_serial_port  # noqa: E402
from phantom_host.dedup import PacketDeduper  # noqa: E402
from phantom_host.protocol import parse_radio_line  # noqa: E402

FIRMWARE_CUTOFF = "2026-09-16"
VERSION_LINE = re.compile(r"fw=(\S+)")
DATE_IN_VERSION = re.compile(r"(\d{4}-\d{2}-\d{2})")

INTERESTING = (
    "PA1|",
    "fw=",
    "radio_ok",
    "radio_enable_failed",
    "phantom_",
    "error",
    "Error",
    "ERROR",
    "Traceback",
    "lua:",
    "script_app",
    "app_reg",
    "heap",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=None, help="serial device (default: auto)")
    parser.add_argument("--baudrate", type=int, default=115200)
    parser.add_argument("--seconds", type=float, default=0.0, help="0 = until Ctrl-C")
    parser.add_argument("--raw", action="store_true", help="print every line")
    args = parser.parse_args()

    port = args.port or find_serial_port()
    if port is None:
        print("No badge found.")
        print()
        print("Check: is it plugged in with a USB DATA cable, and switched on")
        print("normally (not holding Start)? Run `ls /dev/cu.*` to look manually.")
        return 1

    print(f"port      {port}")
    print(f"baudrate  {args.baudrate}")
    print()

    try:
        connection = serial.Serial(port, args.baudrate, timeout=0.3)
    except SerialException as error:
        print(f"Could not open {port}: {error}")
        print()
        print("Almost always this means the Badge IDE still owns the port.")
        print("Click Disconnect in the IDE (or close the tab) and try again.")
        print("Only one process can read a serial port at a time.")
        return 1

    print("Listening. Press A/B/START/UP on a sender badge to generate packets.")
    print("Ctrl-C to stop and print the summary.")
    print()

    lines = 0
    accepted = 0
    duplicates = 0
    unparsed_with_prefix = 0
    firmware: str | None = None
    radio_state: str | None = None
    senders: Counter[str] = Counter()
    kinds: Counter[str] = Counter()
    macs: dict[str, str] = {}
    deduper = PacketDeduper()
    started = time.monotonic()
    deadline = started + args.seconds if args.seconds > 0 else None

    try:
        while deadline is None or time.monotonic() < deadline:
            raw = connection.readline()
            if not raw:
                continue

            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            lines += 1
            elapsed = time.monotonic() - started

            match = VERSION_LINE.search(line)
            if match and firmware is None:
                firmware = match.group(1)
            if "radio_enable_failed" in line:
                radio_state = "FAILED"
            elif "radio_ok" in line and radio_state is None:
                radio_state = "ok"

            event = parse_radio_line(line, int(elapsed * 1000))
            if event is not None:
                if deduper.accept(event):
                    accepted += 1
                    senders[event.sender] += 1
                    kinds[event.kind] += 1
                    if event.mac:
                        macs[event.sender] = event.mac
                    print(
                        f"{elapsed:7.2f}s  PACKET  {event.sender:>2} {event.kind:<5} "
                        f"{event.value:<4} seq={event.sequence:<3}"
                        f"{'  mac=' + event.mac if event.mac else ''}"
                    )
                else:
                    duplicates += 1
                    print(f"{elapsed:7.2f}s  dup     {event.sender} seq={event.sequence}")
                continue

            if "PA1|" in line:
                unparsed_with_prefix += 1
                print(f"{elapsed:7.2f}s  UNPARSED  {line!r}")
            elif args.raw or any(token in line for token in INTERESTING):
                print(f"{elapsed:7.2f}s  {line}")

    except KeyboardInterrupt:
        pass
    finally:
        connection.close()

    elapsed = time.monotonic() - started
    print()
    print("=" * 62)
    print(f"listened          {elapsed:.1f}s")
    print(f"serial lines      {lines}")
    print(f"packets accepted  {accepted}")
    print(f"duplicates        {duplicates}")

    if accepted:
        expected = accepted * 2
        verdict = "as expected" if duplicates == expected else f"expected {expected}"
        print(f"  triple-send     {duplicates} dropped for {accepted} packets, {verdict}")
        print(f"  senders         {dict(senders)}")
        print(f"  kinds           {dict(kinds)}")
        for sender, mac in sorted(macs.items()):
            print(f"  {sender} radio mac    {mac}")

    if unparsed_with_prefix:
        print(f"MALFORMED         {unparsed_with_prefix} lines had PA1| but did not parse")

    print()
    if lines == 0:
        print("NOTHING RECEIVED.")
        print("  - Is a badge app actually open? Apps only run in the foreground.")
        print("  - The launcher itself prints little; push phantom_gateway and open it.")
        print("  - Confirm the cable is a data cable, not charge-only.")
        return 1

    if firmware:
        print(f"firmware          {firmware}")
        found = DATE_IN_VERSION.search(firmware)
        if found and found.group(1) < FIRMWARE_CUTOFF:
            print(f"  WARNING: older than {FIRMWARE_CUTOFF}.")
            print("  That firmware allows only 6 ms per tick instead of 250 ms.")
        elif found:
            print(f"  OK: {FIRMWARE_CUTOFF} or newer, 250 ms tick budget.")
        else:
            print(f"  Could not date this string; compare it against {FIRMWARE_CUTOFF}.")
    else:
        print("firmware          unknown (no 'fw=' line seen)")
        print("  Our apps log it on entry. Open phantom_gateway to capture it.")

    if radio_state == "FAILED":
        print("radio             ENABLE FAILED - reboot the badge and reopen the app")
        return 1
    if radio_state == "ok":
        print("radio             enabled")
    else:
        print("radio             unknown (no radio_ok line seen)")

    if accepted == 0:
        print()
        print("Serial works but no PA1 packets arrived. Either no sender badge is")
        print("running phantom_player/phantom_chaos, or its radio did not start.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
