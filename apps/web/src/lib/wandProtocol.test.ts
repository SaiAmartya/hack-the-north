import { describe, expect, it } from "vitest";
import {
  CAP_ALL,
  cueArgs,
  decodeControl,
  decodeInfo,
  decodeMotion,
  decodeStatus,
  EFFECT,
  encodeControl,
  encodeInfo,
  encodeMotion,
  encodeStatus,
  fromHex,
  hex,
  MOTION_FLAG,
  OP,
  PHASE,
  RC,
  seqAdvances,
  setStateArgs,
  SPELL,
} from "./wandProtocol";

// Golden vectors from BADGE-FIRMWARE-CONTRACT.md section 7.
describe("golden vectors", () => {
  it("INFO", () => {
    const raw = encodeInfo({ caps: CAP_ALL, sampleHz: 50, rangeG: 8, deviceId: fromHex("a1b2c3d4e5f6"), bootId: 0x11223344, fw: [0, 1, 0], axisConvention: 1 });
    expect(hex(raw)).toBe("01 0f 32 08 a1 b2 c3 d4 e5 f6 44 33 22 11 00 01 00 01 00 00");
    const info = decodeInfo(raw)!;
    expect(info.bootId).toBe(0x11223344);
    expect(info.sampleHz).toBe(50);
    expect(hex(info.deviceId)).toBe("a1 b2 c3 d4 e5 f6");
  });

  it("MOTION and signed endpoints", () => {
    const m = { flags: MOTION_FLAG.VALID, seq: 42, captureMs: 1000, bootId: 0x11223344, ax: -100, ay: 200, az: 1000 };
    const raw = encodeMotion(m);
    expect(hex(raw)).toBe("01 01 2a 00 e8 03 00 00 44 33 22 11 9c ff c8 00 e8 03 00 00");
    expect(decodeMotion(raw)).toEqual(m);
    const ends = encodeMotion({ ...m, ax: -8000, ay: 8000 });
    expect(hex(ends.subarray(12, 16))).toBe("c0 e0 40 1f");
    expect(decodeMotion(ends)).not.toBeNull();
    const over = new Uint8Array(ends);
    over[12] = 0x41;
    over[13] = 0x1f;
    expect(decodeMotion(over)).toBeNull(); // +8001
    over[12] = 0x00;
    over[13] = 0x80;
    expect(decodeMotion(over)).toBeNull(); // -32768
    const reserved = new Uint8Array(raw);
    reserved[19] = 1;
    expect(decodeMotion(reserved)).toBeNull();
    expect(decodeMotion(raw.subarray(0, 19))).toBeNull();
    const badFlags = new Uint8Array(raw);
    badFlags[1] = 0x10;
    expect(decodeMotion(badFlags)).toBeNull();
  });

  it("CONTROL and STATUS", () => {
    const open = { opcode: OP.OPEN, seq: 0, nonce: 0xaabbccdd, arg0: 0, arg1: 0, arg2: 0 };
    expect(hex(encodeControl(open))).toBe("01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00");
    expect(decodeControl(encodeControl(open))).toEqual(open);
    const ok = { kind: 1, seq: 0, nonce: 0xaabbccdd, deviceMs: 1010, detail0: OP.OPEN, detail1: RC.OK };
    expect(hex(encodeStatus(ok))).toBe("01 01 00 00 dd cc bb aa f2 03 00 00 01 00 00 00 00 00 00 00");
    expect(decodeStatus(encodeStatus(ok))).toEqual(ok);
    const state = { opcode: OP.SET_STATE, seq: 1, nonce: 0xaabbccdd, arg0: setStateArgs(PHASE.PLAYING, 100, 0), arg1: 0x01020304, arg2: 2200 };
    expect(hex(encodeControl(state))).toBe("01 03 01 00 dd cc bb aa 03 64 64 00 04 03 02 01 98 08 00 00");
    const cue = { opcode: OP.CUE, seq: 2, nonce: 0xaabbccdd, arg0: cueArgs(EFFECT.ACCEPTED_CAST, SPELL.STUPEFY, 300), arg1: 0x01020304, arg2: 1400 };
    expect(hex(encodeControl(cue))).toBe("01 04 02 00 dd cc bb aa 01 01 2c 01 04 03 02 01 78 05 00 00");
    expect(hex(encodeStatus({ kind: 1, seq: 0, nonce: 0xaabbccdd, deviceMs: 2000, detail0: OP.SYNC, detail1: RC.OK }))).toBe(
      "01 01 00 00 dd cc bb aa d0 07 00 00 02 00 00 00 00 00 00 00",
    );
    expect(hex(encodeStatus({ kind: 1, seq: 4, nonce: 0xaabbccdd, deviceMs: 2100, detail0: OP.SYNC, detail1: RC.OK }))).toBe(
      "01 01 04 00 dd cc bb aa 34 08 00 00 02 00 00 00 00 00 00 00",
    );
  });

  it("sequence rule", () => {
    expect(seqAdvances(0, 65535)).toBe(true);
    expect(seqAdvances(4, 2)).toBe(true);
    expect(seqAdvances(3, 4)).toBe(false);
    expect(seqAdvances(2, 2)).toBe(false);
    expect(seqAdvances(32768, 0)).toBe(false);
    expect(seqAdvances(32767, 0)).toBe(true);
  });
});
