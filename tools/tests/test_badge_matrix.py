"""The diagnostic runner must observe firmware state, never guess from a delay."""
from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("badge_matrix", Path(__file__).resolve().parents[1] / "badge_matrix.py")
assert spec and spec.loader
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)

IDLE = "HPOK|connected=0 motion_sub=0 status_sub=0"
ROW = "HPOK|profile=rate ble=off caps=0\nHPOK|sensor=1"
ACCEPT = "HPOK|next_boot profile=rate ble=off caps=0; software rebooting; no NVS write"


def replies(monkeypatch, responses):
    seen = []
    values = iter(responses)

    async def query(_console, command, _duration=.7):
        seen.append(command)
        return next(values)

    monkeypatch.setattr(matrix, "query", query)
    return seen


def test_waits_for_device_disconnect_then_boot_readback(monkeypatch):
    seen = replies(monkeypatch, ["connected=1", IDLE, ACCEPT, "booting", ROW])
    assert asyncio.run(matrix.select_profile(None, "rate", "off")) == ROW
    assert seen == ["status", "status", "profile rate off", "status", "status"]


def test_retries_explicit_disconnect_guard_not_arbitrary_errors(monkeypatch):
    seen = replies(monkeypatch, [IDLE, "disconnect BLE before selecting a boot profile", IDLE, ACCEPT, ROW])
    assert asyncio.run(matrix.select_profile(None, "rate", "off")) == ROW
    assert seen.count("profile rate off") == 2


@pytest.mark.parametrize("response", ["", "HPERR|unknown command", "HPOK|usage: profile", "next_boot profile=creator ble=on caps=0"])
def test_never_measures_unacknowledged_profile(monkeypatch, response):
    replies(monkeypatch, [IDLE, response])
    with pytest.raises(RuntimeError, match="not acknowledged"):
        asyncio.run(matrix.select_profile(None, "rate", "off"))


def test_rejects_wrong_row_after_accepted_command(monkeypatch):
    replies(monkeypatch, [IDLE, ACCEPT] + ["profile=creator ble=on caps=0 sensor=1"] * 8)
    with pytest.raises(RuntimeError, match="did not boot honestly"):
        asyncio.run(matrix.select_profile(None, "rate", "off"))


def test_does_not_reboot_a_connected_badge(monkeypatch):
    seen = replies(monkeypatch, ["connected=1"] * 8)
    with pytest.raises(RuntimeError, match="acknowledge BLE disconnect"):
        asyncio.run(matrix.select_profile(None, "rate", "off"))
    assert seen == ["status"] * 8


def test_ble_loaded_requires_current_019_info(monkeypatch):
    class FakeScanner:
        @staticmethod
        async def find_device_by_filter(_predicate, timeout):
            return object()

    class FakeClient:
        def __init__(self, _device, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def read_gatt_char(self, _uuid):
            return b"info"

    fake_bleak = types.SimpleNamespace(BleakScanner=FakeScanner, BleakClient=FakeClient)
    monkeypatch.setitem(sys.modules, "bleak", fake_bleak)
    monkeypatch.setattr(
        matrix.wp,
        "decode_info",
        lambda _payload: types.SimpleNamespace(caps=0, fw=(0, 1, 8), sample_hz=50, range_g=8),
    )
    with pytest.raises(RuntimeError, match="Diagnostic INFO"):
        asyncio.run(matrix.loaded(None, "WAND-B602", 50, 8, 3))
