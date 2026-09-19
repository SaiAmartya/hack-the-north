#!/usr/bin/env python3
"""Flash, back up and restore the Hacker Badge over USB.

    uv run --with pyserial python tools/badge_flash.py list
    uv run --with pyserial python tools/badge_flash.py backup            # 4 MB dump -> firmware/backups/<mac>-<time>.bin
    uv run --with pyserial python tools/badge_flash.py flash             # pio run -t upload (builds first)
    uv run --with pyserial python tools/badge_flash.py restore <file>    # write a backup back, byte for byte
    uv run --with pyserial python tools/badge_flash.py monitor           # raw serial console at 115200 (--seconds N to auto-stop)
    uv run --with pyserial python tools/badge_flash.py cmd selftest axes # send console commands, print replies

Always run `backup` once per badge before the first `flash`: the dump contains the
stock firmware, its partition table and the badge's identity, and `restore` puts
everything back exactly as it was.

Requirements: `esptool` and `pio` on PATH (both installed with `uv tool install esptool platformio`).
The badge IDE tab must be closed: only one program can hold the serial port.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware"
BACKUPS = FIRMWARE / "backups"
ESPRESSIF_VID = 0x303A
FLASH_SIZE = 0x400000


def find_ports() -> list[tuple[str, str]]:
    from serial.tools import list_ports

    found = []
    for p in list_ports.comports():
        if getattr(p, "vid", None) == ESPRESSIF_VID:
            found.append((p.device, p.description or ""))
    return found


def pick_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    ports = find_ports()
    if not ports:
        sys.exit("no Espressif USB device found. Badge on? Cable is a data cable? IDE tab closed?")
    if len(ports) > 1:
        names = ", ".join(f"{d} ({desc})" for d, desc in ports)
        sys.exit(f"several badges connected: {names}. Pass --port.")
    return ports[0][0]


def tool(name: str) -> str:
    path = shutil.which(name)
    if path:
        return path
    home = Path.home() / ".local" / "bin" / (name + (".exe" if os.name == "nt" else ""))
    if home.exists():
        return str(home)
    sys.exit(f"{name} not found on PATH. Install with: uv tool install {name if name != 'pio' else 'platformio'}")


def run(cmd: list[str]) -> int:
    print("$", " ".join(cmd), flush=True)
    return subprocess.call(cmd)


def parse_mac(text: str) -> str:
    for line in text.splitlines():
        if line.strip().startswith("MAC:") and ":" in line:
            return line.split()[-1].replace(":", "").lower()
    return "unknown"


def open_console(port: str):
    """Open the badge console without touching DTR/RTS: native USB-Serial-JTAG resets the chip on
    DTR/RTS edges, so the lines are pinned low before the port opens."""
    import serial

    s = serial.Serial()
    s.port = port
    s.baudrate = 115200
    s.timeout = 0.1
    s.dtr = False
    s.rts = False
    s.open()
    return s


def cmd_list(_: argparse.Namespace) -> int:
    ports = find_ports()
    if not ports:
        print("no Espressif USB device found")
        return 1
    for device, desc in ports:
        print(f"{device}\t{desc}")
    return 0


def cmd_backup(a: argparse.Namespace) -> int:
    port = pick_port(a.port)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    tmp = BACKUPS / f"pending-{stamp}.bin"
    print(f"backing up 4 MB from {port} to {BACKUPS} ... about a minute", flush=True)
    # --after no-reset keeps the chip in the bootloader, so a manual download-mode entry (hold START
    # while plugging in) only has to happen once for backup + flash.
    cmd = [tool("esptool"), "--chip", "esp32c3", "--port", port, "--baud", "921600", "--after", "no-reset", "read-flash", "0", hex(FLASH_SIZE), str(tmp)]
    print("$", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    text = proc.stdout + proc.stderr
    print(text.strip()[-1500:])
    mac = parse_mac(text)
    if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size == FLASH_SIZE:
        out = BACKUPS / f"{mac}-{stamp}.bin"
        tmp.rename(out)
        print(f"OK {out} ({out.stat().st_size} bytes). Keep this file: it is the badge's stock firmware and identity.")
        return 0
    if tmp.exists():
        tmp.unlink()
    print("backup FAILED - do not flash until a full 4 MB backup exists")
    print(DOWNLOAD_MODE_HINT)
    return 1


DOWNLOAD_MODE_HINT = (
    "Could not talk to the badge's bootloader. Native USB has no auto-reset (official custom-flash guide):\n"
    "  1. unplug USB, 2. hold START (the play button, GPIO9) while plugging USB back in, 3. release, 4. retry.\n"
    "A blank screen in that state is download mode, not a brick.\n"
    "'port is busy' / 'Access is denied': another program owns the COM port (badge IDE tab, a serial monitor,\n"
    "or a Windows service that probes new serial ports). Close it, or simply replug the badge, which drops the stale handle."
)


def console_query(port: str, command: str, wait: float = 1.5) -> str:
    """Send one console command to a running wand firmware and return what came back ('' if silent)."""
    try:
        with open_console(port) as s:
            time.sleep(0.3)
            s.reset_input_buffer()
            s.write(command.encode() + b"\r")
            deadline = time.time() + wait
            out = b""
            while time.time() < deadline:
                out += s.read(256)
                if b"HPOK|" in out or b"HPERR|" in out:
                    break
            return out.decode("utf-8", "replace")
    except Exception as e:  # port busy, re-enumerating, or in the ROM bootloader
        return f"<{e}>"


def app_is_up(port: str) -> bool:
    for _ in range(3):
        if "HPOK|name=" in console_query(port, "id"):
            return True
        time.sleep(1.5)
    return False


def enter_download_mode(port: str) -> None:
    """Ask a running wand firmware to reboot into the ROM bootloader (its `flashmode` command)."""
    reply = console_query(port, "flashmode", wait=1.0)
    if "HPOK|entering download mode" in reply:
        print("badge is rebooting into download mode ...", flush=True)
        time.sleep(3.0)
    else:
        print("no wand firmware answered on the console (stock firmware, or already in download mode)", flush=True)


def boot_app(port: str) -> bool:
    """After flashing, make sure the application is running: the RTS-emulated hard reset over native
    USB does not leave the bootloader on this badge, but a watchdog reset from the stub does."""
    print("waiting for the application ...", flush=True)
    time.sleep(2.5)
    if app_is_up(port):
        return True
    print("application not answering, forcing a watchdog reset out of the bootloader", flush=True)
    subprocess.run([tool("esptool"), "--chip", "esp32c3", "--port", port, "--before", "no-reset", "--after", "watchdog-reset", "chip-id"], capture_output=True, text=True)
    time.sleep(3.0)
    return app_is_up(pick_port(None) if port else port)


def cmd_flash(a: argparse.Namespace) -> int:
    port = pick_port(a.port)
    if not a.no_backup_check and not any(BACKUPS.glob("*.bin")):
        sys.exit("no backup found in firmware/backups. Run `badge_flash.py backup` first (or pass --no-backup-check).")
    enter_download_mode(port)
    port = pick_port(a.port)
    cmd = [tool("pio"), "run", "-d", str(FIRMWARE), "-t", "upload", "--upload-port", port]
    rc = run(cmd)
    if rc != 0:
        print(DOWNLOAD_MODE_HINT)
        return rc
    if boot_app(port):
        print("flashed and running:", console_query(port, "id").strip())
        return 0
    print("flashed, but the application did not answer on the console. Unplug and replug the badge (without START), then run `monitor`.")
    return 2


def cmd_restore(a: argparse.Namespace) -> int:
    port = pick_port(a.port)
    image = Path(a.image)
    if not image.exists() or image.stat().st_size != FLASH_SIZE:
        sys.exit(f"{image} is not a 4 MB flash image")
    print(f"restoring {image} to {port}: this rewrites the whole flash with the stock firmware")
    return run([tool("esptool"), "--chip", "esp32c3", "--port", port, "--baud", "921600", "write-flash", "0", str(image)])


def cmd_monitor(a: argparse.Namespace) -> int:
    import threading

    port = pick_port(a.port)
    print(f"monitor {port} @115200, Ctrl-C to stop. Type a command and Enter to send it (help, status, id, selftest, axes, btn, rot, echo on).", flush=True)
    with open_console(port) as s:

        def pump_stdin() -> None:
            for line in sys.stdin:
                s.write(line.rstrip("\r\n").encode() + b"\r")

        threading.Thread(target=pump_stdin, daemon=True).start()
        deadline = time.time() + a.seconds if a.seconds > 0 else None
        try:
            while deadline is None or time.time() < deadline:
                data = s.readline()
                if data:
                    sys.stdout.write(data.decode("utf-8", "replace"))
                    sys.stdout.flush()
                else:
                    time.sleep(0.01)
        except KeyboardInterrupt:
            pass
    return 0


def cmd_send(a: argparse.Namespace) -> int:
    """Send console commands one after another and print what comes back (non-interactive)."""
    port = pick_port(a.port)
    with open_console(port) as s:
        time.sleep(0.3)
        s.reset_input_buffer()
        for command in a.command:
            print(f"> {command}", flush=True)
            s.write(command.encode() + b"\r")
            deadline = time.time() + a.wait
            while time.time() < deadline:
                data = s.readline()
                if data:
                    sys.stdout.write(data.decode("utf-8", "replace"))
                    sys.stdout.flush()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port (default: the only Espressif device)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    sub.add_parser("backup").set_defaults(fn=cmd_backup)
    f = sub.add_parser("flash")
    f.add_argument("--no-backup-check", action="store_true")
    f.set_defaults(fn=cmd_flash)
    r = sub.add_parser("restore")
    r.add_argument("image")
    r.set_defaults(fn=cmd_restore)
    m = sub.add_parser("monitor")
    m.add_argument("--seconds", type=float, default=0, help="stop after this many seconds (0 = until Ctrl-C)")
    m.set_defaults(fn=cmd_monitor)
    c = sub.add_parser("cmd", help="send console commands, e.g. cmd selftest axes btn")
    c.add_argument("command", nargs="+")
    c.add_argument("--wait", type=float, default=2.0, help="seconds to collect output after each command")
    c.set_defaults(fn=cmd_send)
    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
