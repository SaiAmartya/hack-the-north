from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "badge_flash.py"
SPEC = importlib.util.spec_from_file_location("badge_flash", MODULE_PATH)
assert SPEC and SPEC.loader
badge_flash = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(badge_flash)


def create_verified_backup(
    directory: Path,
    mac: str = "a1b2c3d4e5f6",
    fill: bytes = b"x",
) -> Path:
    image = directory / f"{mac}-20260919-120000Z.bin"
    image.write_bytes(fill * badge_flash.FLASH_SIZE)
    badge_flash.write_backup_manifest(
        image,
        mac,
        "2026-09-19T12:00:00+00:00",
    )
    return image


def test_parse_mac_requires_a_complete_esptool_identity() -> None:
    assert (
        badge_flash.parse_mac("Connecting...\nMAC: A1:B2:C3:D4:E5:F6\n")
        == "a1b2c3d4e5f6"
    )
    assert badge_flash.parse_mac("MAC: A1:B2:C3") is None
    assert badge_flash.parse_mac("no device identity") is None


def test_verified_backup_is_bound_to_selected_device_size_and_hash(
    tmp_path: Path,
) -> None:
    image = create_verified_backup(tmp_path)

    manifest = badge_flash.verify_backup(image, "a1b2c3d4e5f6")
    assert manifest["image"] == image.name
    assert manifest["flash_size"] == badge_flash.FLASH_SIZE
    assert manifest["sha256"] == badge_flash.sha256_file(image)

    with pytest.raises(badge_flash.BackupVerificationError, match="device_mac"):
        badge_flash.verify_backup(image, "001122334455")

    image.write_bytes(b"y" * badge_flash.FLASH_SIZE)
    with pytest.raises(badge_flash.BackupVerificationError, match="SHA-256"):
        badge_flash.verify_backup(image, "a1b2c3d4e5f6")


def test_unmanifested_or_other_device_backup_cannot_unlock_flash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(badge_flash, "BACKUPS", tmp_path)
    (tmp_path / "unverified.bin").write_bytes(b"x" * badge_flash.FLASH_SIZE)
    create_verified_backup(tmp_path, mac="001122334455")

    with pytest.raises(
        badge_flash.BackupVerificationError,
        match="selected device a1b2c3d4e5f6",
    ):
        badge_flash.find_verified_backup("a1b2c3d4e5f6")


def test_registers_two_existing_private_reads_for_the_named_device(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(badge_flash, "BACKUPS", tmp_path)
    directory = tmp_path / "a1b2c3d4e5f6-20260919"
    directory.mkdir()
    first = directory / "stock-read-1.bin"
    second = directory / "stock-read-2.bin"
    first.write_bytes(b"x" * badge_flash.FLASH_SIZE)
    second.write_bytes(b"x" * badge_flash.FLASH_SIZE)

    assert (
        badge_flash.cmd_register_backup(
            argparse.Namespace(
                device_mac="A1:B2:C3:D4:E5:F6",
                read1=first,
                read2=second,
            )
        )
        == 0
    )
    image, manifest = badge_flash.find_verified_backup("a1b2c3d4e5f6")
    assert image == first
    assert manifest["verification"]["peer_image"] == second.name
    if os.name != "nt":
        assert tmp_path.stat().st_mode & 0o777 == 0o700
        assert directory.stat().st_mode & 0o777 == 0o700
        assert first.stat().st_mode & 0o777 == 0o600
        assert second.stat().st_mode & 0o777 == 0o600

    second.write_bytes(b"y" * badge_flash.FLASH_SIZE)
    first.with_suffix(".json").unlink()
    with pytest.raises(SystemExit, match="SHA-256 values differ"):
        badge_flash.cmd_register_backup(
            argparse.Namespace(
                device_mac="a1b2c3d4e5f6",
                read1=first,
                read2=second,
            )
        )


def test_backup_creates_private_hash_manifest_without_logging_contents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(badge_flash, "BACKUPS", tmp_path)
    monkeypatch.setattr(badge_flash, "pick_port", lambda _: "/dev/test-badge")
    monkeypatch.setattr(badge_flash, "tool", lambda name: name)

    marker = b"PRIVATE-FLASH-CONTENT"

    def fake_run(command: list[str], **_: object) -> SimpleNamespace:
        target = Path(command[-1])
        target.write_bytes(marker + b"\0" * (badge_flash.FLASH_SIZE - len(marker)))
        return SimpleNamespace(
            returncode=0,
            stdout="Chip is ESP32-C3\nMAC: A1:B2:C3:D4:E5:F6\n",
            stderr="",
        )

    monkeypatch.setattr(badge_flash.subprocess, "run", fake_run)
    assert badge_flash.cmd_backup(argparse.Namespace(port=None)) == 0

    image = next(tmp_path.glob("*.bin"))
    manifest_path = image.with_suffix(".json")
    payload = json.loads(manifest_path.read_text())
    assert payload["device_mac"] == "a1b2c3d4e5f6"
    assert payload["sha256"] == badge_flash.sha256_file(image)
    assert marker.decode() not in capsys.readouterr().out


def test_flash_refuses_to_run_platformio_without_matching_backup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(badge_flash, "pick_port", lambda _: "/dev/test-badge")
    monkeypatch.setattr(badge_flash, "enter_download_mode", lambda _: None)
    monkeypatch.setattr(
        badge_flash,
        "probe_device_mac",
        lambda _: "a1b2c3d4e5f6",
    )
    monkeypatch.setattr(
        badge_flash,
        "find_verified_backup",
        lambda _: (_ for _ in ()).throw(
            badge_flash.BackupVerificationError("no matching backup")
        ),
    )
    monkeypatch.setattr(
        badge_flash,
        "run",
        lambda _: pytest.fail("PlatformIO must not run"),
    )

    with pytest.raises(SystemExit, match="no matching backup"):
        badge_flash.cmd_flash(argparse.Namespace(port=None))


def test_restore_verifies_selected_device_and_never_blanket_erases(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image = create_verified_backup(tmp_path)
    commands: list[list[str]] = []
    monkeypatch.setattr(badge_flash, "pick_port", lambda _: "/dev/test-badge")
    monkeypatch.setattr(badge_flash, "enter_download_mode", lambda _: None)
    monkeypatch.setattr(
        badge_flash,
        "probe_device_mac",
        lambda _: "a1b2c3d4e5f6",
    )
    monkeypatch.setattr(badge_flash, "tool", lambda name: name)
    monkeypatch.setattr(
        badge_flash,
        "run",
        lambda command: commands.append(command) or 0,
    )

    assert badge_flash.cmd_restore(argparse.Namespace(port=None, image=image)) == 0
    assert len(commands) == 1
    assert "write-flash" in commands[0]
    assert "erase-flash" not in commands[0]

    monkeypatch.setattr(
        badge_flash,
        "probe_device_mac",
        lambda _: "001122334455",
    )
    with pytest.raises(SystemExit, match="device_mac"):
        badge_flash.cmd_restore(argparse.Namespace(port=None, image=image))
