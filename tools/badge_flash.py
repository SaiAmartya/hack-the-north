#!/usr/bin/env python3
"""Flash, back up and restore the Hacker Badge over USB.

    uv run --with pyserial python tools/badge_flash.py list
    uv run --with pyserial python tools/badge_flash.py backup            # two verified 4 MB reads -> private user data
    uv run --with pyserial python tools/badge_flash.py register-backup --device-mac <mac> <read1> <read2>
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
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware"


def user_backup_dir() -> Path:
    if os.name == "nt":
        base = Path(
            os.environ.get(
                "LOCALAPPDATA",
                Path.home() / "AppData" / "Local",
            )
        )
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "wandduel" / "badge-backups"


BACKUPS = user_backup_dir()
ESPRESSIF_VID = 0x303A
FLASH_SIZE = 0x400000
PARTITION_TABLE_OFFSET = 0x8000
PARTITION_TABLE_SIZE = 0xC00
BACKUP_MANIFEST_VERSION = 2
CHIP = "esp32c3"
MAC_PATTERN = re.compile(r"^[0-9a-f]{12}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


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


def parse_mac(text: str) -> str | None:
    for line in text.splitlines():
        match = re.search(
            r"\bMAC:\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\b",
            line,
        )
        if match:
            return match.group(1).replace(":", "").lower()
    return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_region(path: Path, offset: int, size: int) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        handle.seek(offset)
        remaining = size
        while remaining:
            block = handle.read(min(remaining, 64 * 1024))
            if not block:
                raise BackupVerificationError("backup ended before expected region")
            digest.update(block)
            remaining -= len(block)
    return digest.hexdigest()


def manifest_path(image: Path) -> Path:
    return image.with_suffix(".json")


def backup_manifest(
    image: Path,
    device_mac: str,
    created_utc: str,
    peer_image: str | None = None,
) -> dict[str, Any]:
    image_hash = sha256_file(image)
    verification: dict[str, Any] = {
        "method": "two-independent-full-reads-sha256",
        "read_count": 2,
        "matching_sha256": image_hash,
    }
    if peer_image is not None:
        verification["peer_image"] = peer_image
    return {
        "manifest_version": BACKUP_MANIFEST_VERSION,
        "chip": CHIP,
        "device_mac": device_mac,
        "flash_offset": 0,
        "flash_size": FLASH_SIZE,
        "image": image.name,
        "sha256": image_hash,
        "partition_table_offset": PARTITION_TABLE_OFFSET,
        "partition_table_size": PARTITION_TABLE_SIZE,
        "partition_table_sha256": sha256_region(
            image,
            PARTITION_TABLE_OFFSET,
            PARTITION_TABLE_SIZE,
        ),
        "verification": verification,
        "created_utc": created_utc,
    }


def write_backup_manifest(
    image: Path,
    device_mac: str,
    created_utc: str,
    peer_image: str | None = None,
) -> Path:
    target = manifest_path(image)
    pending = target.with_suffix(".json.pending")
    payload = backup_manifest(image, device_mac, created_utc, peer_image)
    pending.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    os.chmod(pending, 0o600)
    pending.replace(target)
    return target


class BackupVerificationError(ValueError):
    pass


def verify_backup(image: Path, expected_mac: str) -> dict[str, Any]:
    expected_mac = expected_mac.lower()
    if not MAC_PATTERN.fullmatch(expected_mac):
        raise BackupVerificationError("selected device MAC is invalid")
    if not image.is_file() or image.stat().st_size != FLASH_SIZE:
        raise BackupVerificationError("backup image is not exactly 4 MB")

    sidecar = manifest_path(image)
    try:
        payload = json.loads(sidecar.read_text())
    except FileNotFoundError as error:
        raise BackupVerificationError("backup manifest is missing") from error
    except (OSError, json.JSONDecodeError) as error:
        raise BackupVerificationError("backup manifest is unreadable") from error
    if not isinstance(payload, dict):
        raise BackupVerificationError("backup manifest is not an object")

    required = {
        "manifest_version": BACKUP_MANIFEST_VERSION,
        "chip": CHIP,
        "device_mac": expected_mac,
        "flash_offset": 0,
        "flash_size": FLASH_SIZE,
        "image": image.name,
        "partition_table_offset": PARTITION_TABLE_OFFSET,
        "partition_table_size": PARTITION_TABLE_SIZE,
    }
    for key, expected in required.items():
        if payload.get(key) != expected:
            raise BackupVerificationError(f"backup manifest {key} does not match")

    recorded_hash = payload.get("sha256")
    if not isinstance(recorded_hash, str) or not SHA256_PATTERN.fullmatch(
        recorded_hash
    ):
        raise BackupVerificationError("backup manifest SHA-256 is invalid")
    actual_hash = sha256_file(image)
    if not hmac.compare_digest(actual_hash, recorded_hash):
        raise BackupVerificationError("backup image SHA-256 does not match manifest")
    verification = payload.get("verification")
    if not isinstance(verification, dict) or any(
        verification.get(key) != expected
        for key, expected in {
            "method": "two-independent-full-reads-sha256",
            "read_count": 2,
            "matching_sha256": recorded_hash,
        }.items()
    ):
        raise BackupVerificationError("backup manifest lacks two-read verification")
    peer_image = verification.get("peer_image")
    if peer_image is not None and (
        not isinstance(peer_image, str) or Path(peer_image).name != peer_image
    ):
        raise BackupVerificationError("backup manifest peer image is invalid")
    partition_hash = payload.get("partition_table_sha256")
    if not isinstance(partition_hash, str) or not SHA256_PATTERN.fullmatch(
        partition_hash
    ):
        raise BackupVerificationError("partition-table SHA-256 is invalid")
    actual_partition_hash = sha256_region(
        image,
        PARTITION_TABLE_OFFSET,
        PARTITION_TABLE_SIZE,
    )
    if not hmac.compare_digest(actual_partition_hash, partition_hash):
        raise BackupVerificationError("partition-table SHA-256 does not match manifest")
    return payload


def find_verified_backup(device_mac: str) -> tuple[Path, dict[str, Any]]:
    if not BACKUPS.is_dir():
        raise BackupVerificationError("backup directory does not exist")
    backup_root = BACKUPS.resolve()
    for sidecar in sorted(BACKUPS.rglob("*.json"), reverse=True):
        image = sidecar.with_suffix(".bin")
        if not image.resolve().is_relative_to(backup_root):
            continue
        try:
            payload = verify_backup(image, device_mac)
        except BackupVerificationError:
            continue
        return image, payload
    raise BackupVerificationError(
        f"no verified 4 MB backup for selected device {device_mac}"
    )


def matching_read_hash(first: Path, second: Path) -> str:
    if first.resolve() == second.resolve():
        raise BackupVerificationError("two different full-read files are required")
    for image in (first, second):
        if not image.is_file() or image.stat().st_size != FLASH_SIZE:
            raise BackupVerificationError(f"{image} is not exactly 4 MB")
    first_hash = sha256_file(first)
    second_hash = sha256_file(second)
    if not hmac.compare_digest(first_hash, second_hash):
        raise BackupVerificationError("independent full-read SHA-256 values differ")
    return first_hash


def probe_device_mac(port: str) -> str:
    cmd = [
        tool("esptool"),
        "--chip",
        CHIP,
        "--port",
        port,
        "--before",
        "no-reset",
        "--after",
        "no-reset",
        "read-mac",
    ]
    print("$", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    output = proc.stdout + proc.stderr
    if output.strip():
        print(output.strip()[-1500:])
    device_mac = parse_mac(output)
    if proc.returncode != 0 or device_mac is None:
        sys.exit("could not read the selected ESP32-C3 device identity; refusing to write")
    return device_mac


def open_console(port: str):
    """Pin requested modem lines low before opening; this is not a no-reset guarantee.

    Opening this USB console on the tested Mac still causes USB_UART_CHIP_RESET.
    Open it before a BLE measurement and keep the same handle for before/after
    counters. Never reopen it mid-duel or mistake reset counters for a soak result.
    """
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
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(BACKUPS, 0o700)
    now = dt.datetime.now(dt.timezone.utc)
    stamp = now.strftime("%Y%m%d-%H%M%SZ")
    pending = [
        BACKUPS / f"pending-{os.getpid()}-{stamp}-read1.bin",
        BACKUPS / f"pending-{os.getpid()}-{stamp}-read2.bin",
    ]
    for path in pending:
        path.touch(mode=0o600, exist_ok=False)
    print(
        f"backing up 4 MB twice from {port} to verify independent reads ...",
        flush=True,
    )
    # --after no-reset keeps the chip in the bootloader, so a manual download-mode entry (hold START
    # while plugging in) only has to happen once for backup + flash.
    identities: list[str] = []
    for index, target in enumerate(pending, start=1):
        cmd = [
            tool("esptool"),
            "--chip",
            CHIP,
            "--port",
            port,
            "--baud",
            "921600",
            "--before",
            "no-reset",
            "--after",
            "no-reset",
            "read-flash",
            "0",
            hex(FLASH_SIZE),
            str(target),
        ]
        print(f"read {index}/2: $ {' '.join(cmd)}", flush=True)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        output = proc.stdout + proc.stderr
        if output.strip():
            print(output.strip()[-1500:])
        identity = parse_mac(output)
        if (
            proc.returncode != 0
            or identity is None
            or target.stat().st_size != FLASH_SIZE
        ):
            break
        identities.append(identity)

    try:
        matching_read_hash(pending[0], pending[1])
        reads_match = True
    except BackupVerificationError:
        reads_match = False
    verified = len(identities) == 2 and identities[0] == identities[1] and reads_match
    if verified:
        mac = identities[0]
        out = BACKUPS / f"{mac}-{stamp}.bin"
        if out.exists() or manifest_path(out).exists():
            for path in pending:
                path.unlink(missing_ok=True)
            print("backup FAILED - destination already exists")
            return 1
        pending[0].replace(out)
        pending[1].unlink()
        os.chmod(out, 0o600)
        sidecar = write_backup_manifest(out, mac, now.isoformat())
        payload = verify_backup(out, mac)
        print(
            f"OK: two independent 4 MB reads matched for device {mac}; "
            f"sha256={payload['sha256']}; partition-table "
            f"sha256={payload['partition_table_sha256']}. Manifest: {sidecar}. "
            "Keep the image and manifest private."
        )
        return 0
    for path in pending:
        path.unlink(missing_ok=True)
    print("backup FAILED - do not flash until a full 4 MB backup exists")
    print(DOWNLOAD_MODE_HINT)
    return 1


def cmd_register_backup(a: argparse.Namespace) -> int:
    device_mac = a.device_mac.replace(":", "").lower()
    if not MAC_PATTERN.fullmatch(device_mac):
        sys.exit("--device-mac must be exactly 12 hexadecimal digits")
    first = Path(a.read1).resolve()
    second = Path(a.read2).resolve()
    backup_root = BACKUPS.resolve()
    if not first.is_relative_to(backup_root) or not second.is_relative_to(backup_root):
        sys.exit(f"both reads must remain inside the private backup root {BACKUPS}")
    os.chmod(BACKUPS, 0o700)
    for directory in {first.parent, second.parent}:
        os.chmod(directory, 0o700)
    for image in (first, second):
        os.chmod(image, 0o600)
    try:
        digest = matching_read_hash(first, second)
    except BackupVerificationError as error:
        sys.exit(f"cannot register backup: {error}")
    target = manifest_path(first)
    if target.exists():
        sys.exit(f"backup manifest already exists: {target}")
    sidecar = write_backup_manifest(
        first,
        device_mac,
        dt.datetime.now(dt.timezone.utc).isoformat(),
        peer_image=second.name,
    )
    payload = verify_backup(first, device_mac)
    print(
        f"registered two matching 4 MB reads for device {device_mac}: "
        f"sha256={digest}; partition-table sha256={payload['partition_table_sha256']}; "
        f"manifest={sidecar}"
    )
    return 0


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
    enter_download_mode(port)
    port = pick_port(a.port)
    device_mac = probe_device_mac(port)
    try:
        backup, payload = find_verified_backup(device_mac)
    except BackupVerificationError as error:
        sys.exit(f"{error}. Run `badge_flash.py backup` for this badge before flashing.")
    print(
        f"verified recovery backup for selected device {device_mac}: "
        f"{backup.name} sha256={payload['sha256']}"
    )
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
    enter_download_mode(port)
    port = pick_port(a.port)
    device_mac = probe_device_mac(port)
    try:
        payload = verify_backup(image, device_mac)
    except BackupVerificationError as error:
        sys.exit(f"refusing restore: {error}")
    print(
        f"restoring verified backup {image} to selected device {device_mac}: "
        f"sha256={payload['sha256']}"
    )
    return run([tool("esptool"), "--chip", CHIP, "--port", port, "--baud", "921600", "write-flash", "0", str(image)])


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
    register = sub.add_parser(
        "register-backup",
        help="verify two existing private full reads and create their identity/hash manifest",
    )
    register.add_argument("--device-mac", required=True)
    register.add_argument("read1")
    register.add_argument("read2")
    register.set_defaults(fn=cmd_register_backup)
    f = sub.add_parser("flash")
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
