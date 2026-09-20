import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  CommandResultCode,
  ControlOpcode,
  CueEffect,
  MotionFlag,
  PresentationPhase,
  ProtocolError,
  SpellCode,
  StatusKind,
  WAND_PROTOCOL_VERSION,
  classifySequence16,
  decodeControl,
  decodeInfo,
  decodeMotion,
  decodeStatus,
  encodeControl,
  encodeInfo,
  encodeMotion,
  encodeStatus,
  isFutureWithin32,
  isSupportedDuelProfile,
  unsignedDelta32,
  type ControlCommand,
  type InfoRecord,
  type MotionRecord,
  type StatusRecord,
} from "./protocol";

const GOLDEN_INFO = hex(
  "01 0f 32 08 a1 b2 c3 d4 e5 f6 44 33 22 11 00 01 00 01 00 00",
);
const GOLDEN_MOTION = hex(
  "01 01 2a 00 e8 03 00 00 44 33 22 11 9c ff c8 00 e8 03 00 00",
);
const GOLDEN_OPEN = hex(
  "01 01 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00",
);
const GOLDEN_OPEN_RESULT = hex(
  "01 01 00 00 dd cc bb aa f2 03 00 00 01 00 00 00 00 00 00 00",
);
const GOLDEN_STATE = hex(
  "01 03 01 00 dd cc bb aa 03 64 64 00 04 03 02 01 98 08 00 00",
);
const GOLDEN_CUE = hex(
  "01 04 02 00 dd cc bb aa 01 01 2c 01 04 03 02 01 78 05 00 00",
);
const GOLDEN_WRAP_SYNC = hex(
  "01 02 00 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00",
);
const GOLDEN_WRAP_RESULT = hex(
  "01 01 00 00 dd cc bb aa d0 07 00 00 02 00 00 00 00 00 00 00",
);
const GOLDEN_GAP_SYNC = hex(
  "01 02 04 00 dd cc bb aa 00 00 00 00 00 00 00 00 00 00 00 00",
);
const GOLDEN_GAP_RESULT = hex(
  "01 01 04 00 dd cc bb aa 34 08 00 00 02 00 00 00 00 00 00 00",
);
// Firmware 0.2.3 button cast: kind 2, seq 0, device 5000 ms, spell 7 (Expecto Patronum), press 3
const GOLDEN_BUTTON = hex(
  "01 02 00 00 dd cc bb aa 88 13 00 00 07 00 00 00 03 00 00 00",
);

describe("wand protocol golden vectors", () => {
  it("pins the INFO bytes independently in both directions", () => {
    const expected: InfoRecord = {
      version: WAND_PROTOCOL_VERSION,
      capabilities: ALL_CAPABILITIES,
      sampleHz: 50,
      rangeG: 8,
      deviceId: [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6],
      bootId: 0x1122_3344,
      firmware: { major: 0, minor: 1, patch: 0 },
      axisConvention: 1,
    };
    expect(decodeInfo(GOLDEN_INFO)).toEqual(expected);
    expect(encodeInfo(expected)).toEqual(GOLDEN_INFO);
  });

  it("pins signed MOTION axes independently in both directions", () => {
    const expected: MotionRecord = {
      version: WAND_PROTOCOL_VERSION,
      flags: MotionFlag.Valid,
      seq: 42,
      captureMs: 1_000,
      bootId: 0x1122_3344,
      axMg: -100,
      ayMg: 200,
      azMg: 1_000,
    };
    expect(decodeMotion(GOLDEN_MOTION)).toEqual(expected);
    expect(encodeMotion(expected)).toEqual(GOLDEN_MOTION);
  });

  it.each<[string, Uint8Array, ControlCommand]>([
    [
      "OPEN",
      GOLDEN_OPEN,
      {
        version: WAND_PROTOCOL_VERSION,
        opcode: ControlOpcode.Open,
        commandSeq: 0,
        linkNonce: 0xaabb_ccdd,
      },
    ],
    [
      "SET_STATE",
      GOLDEN_STATE,
      {
        version: WAND_PROTOCOL_VERSION,
        opcode: ControlOpcode.SetState,
        commandSeq: 1,
        linkNonce: 0xaabb_ccdd,
        phase: PresentationPhase.Playing,
        hp: 100,
        maxHp: 100,
        statusFlags: 0,
        presentationEpoch: 0x0102_0304,
        validUntilMs: 2_200,
      },
    ],
    [
      "CUE",
      GOLDEN_CUE,
      {
        version: WAND_PROTOCOL_VERSION,
        opcode: ControlOpcode.Cue,
        commandSeq: 2,
        linkNonce: 0xaabb_ccdd,
        effect: CueEffect.AcceptedCast,
        spell: SpellCode.Stupefy,
        durationMs: 300,
        presentationEpoch: 0x0102_0304,
        startBeforeMs: 1_400,
      },
    ],
    [
      "wrap SYNC",
      GOLDEN_WRAP_SYNC,
      {
        version: WAND_PROTOCOL_VERSION,
        opcode: ControlOpcode.Sync,
        commandSeq: 0,
        linkNonce: 0xaabb_ccdd,
      },
    ],
    [
      "gap SYNC",
      GOLDEN_GAP_SYNC,
      {
        version: WAND_PROTOCOL_VERSION,
        opcode: ControlOpcode.Sync,
        commandSeq: 4,
        linkNonce: 0xaabb_ccdd,
      },
    ],
  ])("pins the %s CONTROL bytes", (_name, bytes, expected) => {
    expect(decodeControl(bytes)).toEqual(expected);
    expect(encodeControl(expected)).toEqual(bytes);
  });

  it.each<[string, Uint8Array, StatusRecord]>([
    [
      "OPEN result",
      GOLDEN_OPEN_RESULT,
      {
        version: WAND_PROTOCOL_VERSION,
        kind: StatusKind.CommandResult,
        commandSeq: 0,
        linkNonce: 0xaabb_ccdd,
        deviceMs: 1_010,
        opcode: ControlOpcode.Open,
        resultCode: CommandResultCode.Ok,
      },
    ],
    [
      "wrap result",
      GOLDEN_WRAP_RESULT,
      {
        version: WAND_PROTOCOL_VERSION,
        kind: StatusKind.CommandResult,
        commandSeq: 0,
        linkNonce: 0xaabb_ccdd,
        deviceMs: 2_000,
        opcode: ControlOpcode.Sync,
        resultCode: CommandResultCode.Ok,
      },
    ],
    [
      "gap result",
      GOLDEN_GAP_RESULT,
      {
        version: WAND_PROTOCOL_VERSION,
        kind: StatusKind.CommandResult,
        commandSeq: 4,
        linkNonce: 0xaabb_ccdd,
        deviceMs: 2_100,
        opcode: ControlOpcode.Sync,
        resultCode: CommandResultCode.Ok,
      },
    ],
    [
      "button cast",
      GOLDEN_BUTTON,
      {
        version: WAND_PROTOCOL_VERSION,
        kind: StatusKind.ButtonCast,
        commandSeq: 0,
        linkNonce: 0xaabb_ccdd,
        deviceMs: 5_000,
        spell: SpellCode.ExpectoPatronum,
        pressCount: 3,
      },
    ],
  ])("pins the %s STATUS bytes", (_name, bytes, expected) => {
    expect(decodeStatus(bytes)).toEqual(expected);
    expect(encodeStatus(expected)).toEqual(bytes);
  });
});

describe("wand protocol validation", () => {
  it("rejects wrong lengths, versions, and reserved bytes", () => {
    expect(() => decodeInfo(GOLDEN_INFO.slice(0, 19))).toThrow(ProtocolError);

    const wrongVersion = GOLDEN_INFO.slice();
    wrongVersion[0] = 2;
    expect(() => decodeInfo(wrongVersion)).toThrow(/version/);

    const reservedInfo = GOLDEN_INFO.slice();
    reservedInfo[18] = 1;
    expect(() => decodeInfo(reservedInfo)).toThrow(/reserved/);

    const reservedMotionFlag = GOLDEN_MOTION.slice();
    reservedMotionFlag[1] |= 0x80;
    expect(() => decodeMotion(reservedMotionFlag)).toThrow(/reserved/);
  });

  it("rejects signed MOTION values outside the profile domain", () => {
    const positive = GOLDEN_MOTION.slice();
    new DataView(positive.buffer).setInt16(12, 8_001, true);
    expect(() => decodeMotion(positive)).toThrow(/axMg/);

    const negative = GOLDEN_MOTION.slice();
    new DataView(negative.buffer).setInt16(12, -32_768, true);
    expect(() => decodeMotion(negative)).toThrow(/axMg/);

    const endpointValues: MotionRecord = {
      ...decodeMotion(GOLDEN_MOTION),
      flags: MotionFlag.Valid | MotionFlag.Saturated,
      axMg: -8_000,
      ayMg: 8_000,
    };
    expect(decodeMotion(encodeMotion(endpointValues))).toEqual(endpointValues);
  });

  it("rejects button casts with an unknown spell or a command sequence", () => {
    const spellNone = Uint8Array.from(GOLDEN_BUTTON);
    spellNone[12] = 0;
    expect(() => decodeStatus(spellNone)).toThrow(ProtocolError);
    const spellEight = Uint8Array.from(GOLDEN_BUTTON);
    spellEight[12] = 8;
    expect(() => decodeStatus(spellEight)).toThrow(ProtocolError);
    const withSeq = Uint8Array.from(GOLDEN_BUTTON);
    withSeq[2] = 1;
    expect(() => decodeStatus(withSeq)).toThrow(ProtocolError);
  });
  it("rejects reserved packed bits and invalid semantic command fields", () => {
    const state = GOLDEN_STATE.slice();
    state[11] = 0x80;
    expect(() => decodeControl(state)).toThrow(/reserved/);

    const invalidAcceptedCast = GOLDEN_CUE.slice();
    invalidAcceptedCast[9] = SpellCode.None;
    expect(() => decodeControl(invalidAcceptedCast)).toThrow(/requires a spell/);

    const health = encodeStatus({
      version: WAND_PROTOCOL_VERSION,
      kind: StatusKind.Health,
      commandSeq: 0,
      linkNonce: 0,
      deviceMs: 10,
      droppedCount: 0,
      healthFlags: 0,
    });
    new DataView(health.buffer).setUint32(16, 0x10, true);
    expect(() => decodeStatus(health)).toThrow(/reserved/);
  });

  it("decodes a nonconforming diagnostic INFO without marking it duel-ready", () => {
    const diagnostic = GOLDEN_INFO.slice();
    diagnostic[2] = 100;
    diagnostic[3] = 2;
    const info = decodeInfo(diagnostic);
    expect(info).toMatchObject({ sampleHz: 100, rangeG: 2 });
    expect(isSupportedDuelProfile(info)).toBe(false);
  });
  it("supports an honestly advertised 50 Hz ±2 g profile but not diagnostic capability bits", () => {
    const bytes = GOLDEN_INFO.slice();
    bytes[3] = 2;
    expect(isSupportedDuelProfile(decodeInfo(bytes))).toBe(true);
    bytes[1] = 0;
    expect(isSupportedDuelProfile(decodeInfo(bytes))).toBe(false);
  });
});

describe("modular ordering helpers", () => {
  it("distinguishes progress, duplicates, stale values, and the half range", () => {
    expect(classifySequence16(0, 0xffff)).toBe("newer");
    expect(classifySequence16(4, 2)).toBe("newer");
    expect(classifySequence16(3, 4)).toBe("stale");
    expect(classifySequence16(4, 4)).toBe("duplicate");
    expect(classifySequence16(0x8000, 0)).toBe("ambiguous");
  });

  it("computes wrap-safe uint32 differences and bounded deadlines", () => {
    expect(unsignedDelta32(5, 0xffff_fffe)).toBe(7);
    expect(isFutureWithin32(5, 0xffff_fffe, 7)).toBe(true);
    expect(isFutureWithin32(5, 0xffff_fffe, 6)).toBe(false);
    expect(isFutureWithin32(100, 100, 1_500)).toBe(false);
    expect(isFutureWithin32(99, 100, 1_500)).toBe(false);
  });
});

function hex(value: string): Uint8Array {
  return Uint8Array.from(
    value.trim().split(/\s+/u),
    (byte) => Number.parseInt(byte, 16),
  );
}
