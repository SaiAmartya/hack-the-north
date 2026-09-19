"""Wire codec for BADGE-FIRMWARE-CONTRACT.md v1 (the badge's GATT records).

Every record is exactly 20 bytes, little-endian, version 1. This module mirrors the badge
firmware (firmware/src/proto.cpp) and the browser decoder (apps/web/src/wand/protocol.ts);
``tests/test_wand_protocol.py`` pins all three to the contract's golden vectors.

The referee never talks to a badge directly (the browser does), so this module exists for
tooling, traces and tests. Decoding never raises for wire-level problems: ``None`` means the
record is malformed and must be ignored.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

VERSION = 1
RECORD_LEN = 20

# opcodes
OP_OPEN, OP_SYNC, OP_SET_STATE, OP_CUE = 1, 2, 3, 4
# result codes
R_OK, R_MALFORMED, R_WRONG_SESSION, R_INVALID_ARG, R_EXPIRED, R_UNSUPPORTED, R_STALE_SEQ = range(7)
# phases
PH_IDLE, PH_PRACTICE, PH_COUNTDOWN, PH_PLAYING, PH_WON, PH_LOST, PH_DRAW, PH_ABORTED = range(8)
# effects / spells
FX_ACCEPTED_CAST, FX_BLOCKED, FX_DAMAGE, FX_RESULT = 1, 2, 3, 4
SP_NONE, SP_STUPEFY, SP_PROTEGO, SP_EXPELLIARMUS = 0, 1, 2, 3
# flags / bits
MF_VALID, MF_SATURATED, MF_DISCONTINUITY = 1, 2, 4
H_SENSOR, H_STREAM, H_PRESENTATION, H_STATE_STALE = 1, 2, 4, 8
CAP_ALL = 0x0F
RANGE_MG = 8000


@dataclass(frozen=True)
class Info:
    caps: int
    sample_hz: int
    range_g: int
    device_id: bytes  # 6 bytes
    boot_id: int
    fw: tuple[int, int, int]
    axis_convention: int


@dataclass(frozen=True)
class Motion:
    flags: int
    seq: int
    capture_ms: int
    boot_id: int
    ax: int
    ay: int
    az: int

    @property
    def valid(self) -> bool:
        return bool(self.flags & MF_VALID)

    @property
    def saturated(self) -> bool:
        return bool(self.flags & MF_SATURATED)

    @property
    def discontinuity(self) -> bool:
        return bool(self.flags & MF_DISCONTINUITY)


@dataclass(frozen=True)
class Control:
    opcode: int
    seq: int
    nonce: int
    arg0: int = 0
    arg1: int = 0
    arg2: int = 0


@dataclass(frozen=True)
class Status:
    kind: int  # 0 health, 1 command result
    seq: int
    nonce: int
    device_ms: int
    detail0: int
    detail1: int


def encode_info(v: Info) -> bytes:
    if len(v.device_id) != 6:
        raise ValueError("device_id must be 6 bytes")
    return struct.pack("<BBBB6sIBBBBH", VERSION, v.caps, v.sample_hz, v.range_g, v.device_id, v.boot_id, *v.fw, v.axis_convention, 0)


def decode_info(data: bytes) -> Info | None:
    if len(data) != RECORD_LEN or data[0] != VERSION or data[18:20] != b"\x00\x00":
        return None
    _, caps, hz, rg, dev, boot, a, b, c, axis, _ = struct.unpack("<BBBB6sIBBBBH", data)
    return Info(caps, hz, rg, dev, boot, (a, b, c), axis)


def encode_motion(v: Motion) -> bytes:
    return struct.pack("<BBHIIhhhH", VERSION, v.flags, v.seq & 0xFFFF, v.capture_ms & 0xFFFFFFFF, v.boot_id & 0xFFFFFFFF, v.ax, v.ay, v.az, 0)


def decode_motion(data: bytes) -> Motion | None:
    if len(data) != RECORD_LEN or data[0] != VERSION:
        return None
    _, flags, seq, capture, boot, ax, ay, az, reserved = struct.unpack("<BBHIIhhhH", data)
    if reserved or flags & ~(MF_VALID | MF_SATURATED | MF_DISCONTINUITY):
        return None
    if any(abs(a) > RANGE_MG for a in (ax, ay, az)):
        return None
    return Motion(flags, seq, capture, boot, ax, ay, az)


def encode_control(v: Control) -> bytes:
    return struct.pack("<BBHIIII", VERSION, v.opcode, v.seq & 0xFFFF, v.nonce & 0xFFFFFFFF, v.arg0 & 0xFFFFFFFF, v.arg1 & 0xFFFFFFFF, v.arg2 & 0xFFFFFFFF)


def decode_control(data: bytes) -> Control | None:
    if len(data) != RECORD_LEN or data[0] != VERSION:
        return None
    _, op, seq, nonce, a0, a1, a2 = struct.unpack("<BBHIIII", data)
    return Control(op, seq, nonce, a0, a1, a2)


def encode_status(v: Status) -> bytes:
    return struct.pack("<BBHIIII", VERSION, v.kind, v.seq & 0xFFFF, v.nonce & 0xFFFFFFFF, v.device_ms & 0xFFFFFFFF, v.detail0 & 0xFFFFFFFF, v.detail1 & 0xFFFFFFFF)


def decode_status(data: bytes) -> Status | None:
    if len(data) != RECORD_LEN or data[0] != VERSION:
        return None
    _, kind, seq, nonce, ms, d0, d1 = struct.unpack("<BBHIIII", data)
    return Status(kind, seq, nonce, ms, d0, d1)


def set_state_args(phase: int, hp: int, status: int = 0, maxhp: int = 100) -> int:
    """Pack SET_STATE arg0 (least significant byte first: phase, hp, maxhp, status)."""
    return phase | (hp << 8) | (maxhp << 16) | (status << 24)


def cue_args(effect: int, spell: int, duration_ms: int) -> int:
    return effect | (spell << 8) | (duration_ms << 16)


def seq_advances(new: int, old: int) -> bool:
    """Contract rule for 16-bit sequences: accept only 0 < (new - old) mod 65536 < 32768."""
    d = (new - old) % 65536
    return 0 < d < 32768
