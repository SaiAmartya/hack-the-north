"""Golden vectors from BADGE-FIRMWARE-CONTRACT.md section 7, shared with the firmware self-test
(firmware/src/proto.cpp) and the browser decoder (apps/web/src/wand/protocol.test.ts)."""

from phantom_host.wand_protocol import (
    CAP_ALL,
    FX_ACCEPTED_CAST,
    MF_VALID,
    OP_OPEN,
    OP_SET_STATE,
    OP_SYNC,
    PH_PLAYING,
    R_OK,
    SP_EPISKEY,
    SP_INCENDIO,
    SP_STUPEFY,
    Control,
    Info,
    Motion,
    Status,
    cue_args,
    decode_control,
    decode_info,
    decode_motion,
    decode_status,
    encode_control,
    encode_info,
    encode_motion,
    encode_status,
    seq_advances,
    set_state_args,
)


def h(text: str) -> bytes:
    return bytes.fromhex(text.replace(" ", ""))


def test_info_golden_vector():
    info = Info(CAP_ALL, 50, 8, bytes.fromhex("a1b2c3d4e5f6"), 0x11223344, (0, 1, 0), 1)
    raw = encode_info(info)
    assert raw == h("01 0f 32 08 a1 b2 c3 d4 e5 f6 44 33 22 11 00 01 00 01 00 00")
    assert decode_info(raw) == info


def test_motion_golden_vector_and_signed_endpoints():
    m = Motion(MF_VALID, 42, 1000, 0x11223344, -100, 200, 1000)
    raw = encode_motion(m)
    assert raw == h("01 01 2a 00 e8 03 00 00 44 33 22 11 9c ff c8 00 e8 03 00 00")
    assert decode_motion(raw) == m
    ends = encode_motion(Motion(MF_VALID, 0, 0, 1, -8000, 8000, 0))
    assert ends[12:16] == h("c0 e0 40 1f")
    assert decode_motion(ends) is not None
    assert decode_motion(ends[:12] + h("41 1f") + ends[14:]) is None  # +8001
    assert decode_motion(ends[:12] + h("00 80") + ends[14:]) is None  # -32768
    assert decode_motion(raw[:19] + b"\x01") is None  # reserved byte
    assert decode_motion(raw[:19]) is None  # length


def test_control_and_status_golden_vectors():
    open_cmd = Control(OP_OPEN, 0, 0xAABBCCDD)
    assert encode_control(open_cmd) == h("01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00")
    assert decode_control(encode_control(open_cmd)) == open_cmd
    ok = Status(1, 0, 0xAABBCCDD, 1010, OP_OPEN, R_OK)
    assert encode_status(ok) == h("01 01 00 00 dd cc bb aa f2 03 00 00 01 00 00 00 00 00 00 00")
    assert decode_status(encode_status(ok)) == ok

    state = Control(OP_SET_STATE, 1, 0xAABBCCDD, set_state_args(PH_PLAYING, 100, 0), 0x01020304, 2200)
    assert encode_control(state) == h("01 03 01 00 dd cc bb aa 03 64 64 00 04 03 02 01 98 08 00 00")
    cue = Control(4, 2, 0xAABBCCDD, cue_args(FX_ACCEPTED_CAST, SP_STUPEFY, 300), 0x01020304, 1400)
    assert encode_control(cue) == h("01 04 02 00 dd cc bb aa 01 01 2c 01 04 03 02 01 78 05 00 00")
    for spell, vector in (
        (SP_INCENDIO, "01 04 03 00 dd cc bb aa 01 04 2c 01 04 03 02 01 78 05 00 00"),
        (SP_EPISKEY, "01 04 04 00 dd cc bb aa 01 05 2c 01 04 03 02 01 78 05 00 00"),
    ):
        cue = Control(4, spell - 1, 0xAABBCCDD, cue_args(FX_ACCEPTED_CAST, spell, 300), 0x01020304, 1400)
        assert encode_control(cue) == h(vector)
        assert decode_control(h(vector)) == cue

    wrap_sync = Control(OP_SYNC, 0, 0xAABBCCDD)
    assert encode_control(wrap_sync) == h("01 02 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00")
    assert encode_status(Status(1, 0, 0xAABBCCDD, 2000, OP_SYNC, R_OK)) == h("01 01 00 00 dd cc bb aa d0 07 00 00 02 00 00 00 00 00 00 00")
    assert encode_status(Status(1, 4, 0xAABBCCDD, 2100, OP_SYNC, R_OK)) == h("01 01 04 00 dd cc bb aa 34 08 00 00 02 00 00 00 00 00 00 00")


def test_sequence_rule():
    assert seq_advances(0, 65535)  # wrap
    assert seq_advances(4, 2)  # forward gap allowed
    assert not seq_advances(3, 4)  # late
    assert not seq_advances(2, 2)  # duplicate
    assert not seq_advances(32768, 0)  # ambiguous half-range
    assert seq_advances(32767, 0)
