// Wire codec for BADGE-FIRMWARE-CONTRACT.md v1: the badge's GATT records.
// Every record is exactly 20 bytes, little-endian, version 1. Mirrors firmware/src/proto.cpp and
// apps/host/phantom_host/wand_protocol.py; wandProtocol.test.ts pins all three to the golden vectors.
// Decoders return null for anything malformed: a bad record is ignored, never guessed at.

export const VERSION = 1;
export const RECORD_LEN = 20;
export const RANGE_MG = 8000;

export const SERVICE_UUID = "7f510000-1b15-4f0d-8f3c-8db47a812000";
export const INFO_UUID = "7f510001-1b15-4f0d-8f3c-8db47a812000";
export const MOTION_UUID = "7f510002-1b15-4f0d-8f3c-8db47a812000";
export const CONTROL_UUID = "7f510003-1b15-4f0d-8f3c-8db47a812000";
export const STATUS_UUID = "7f510004-1b15-4f0d-8f3c-8db47a812000";

export const OP = { OPEN: 1, SYNC: 2, SET_STATE: 3, CUE: 4 } as const;
export const RC = { OK: 0, MALFORMED: 1, WRONG_SESSION: 2, INVALID_ARG: 3, EXPIRED: 4, UNSUPPORTED: 5, STALE_SEQ: 6 } as const;
export const RC_NAMES = ["ok", "malformed", "wrong session", "invalid argument", "expired", "unsupported", "stale sequence"];
export const PHASE = { IDLE: 0, PRACTICE: 1, COUNTDOWN: 2, PLAYING: 3, WON: 4, LOST: 5, DRAW: 6, ABORTED: 7 } as const;
export const EFFECT = { ACCEPTED_CAST: 1, BLOCKED: 2, DAMAGE: 3, RESULT: 4 } as const;
export const SPELL = { NONE: 0, STUPEFY: 1, PROTEGO: 2, EXPELLIARMUS: 3 } as const;
export const STATUS_BIT = { SHIELD: 1, LOCKED: 2 } as const;
export const MOTION_FLAG = { VALID: 1, SATURATED: 2, DISCONTINUITY: 4 } as const;
export const HEALTH = { SENSOR: 1, STREAM: 2, PRESENTATION: 4, STATE_STALE: 8 } as const;
export const CAP_ALL = 0x0f;

export type Info = {
  caps: number;
  sampleHz: number;
  rangeG: number;
  deviceId: Uint8Array; // 6 bytes
  bootId: number;
  fw: [number, number, number];
  axisConvention: number;
};

export type Motion = {
  flags: number;
  seq: number;
  captureMs: number;
  bootId: number;
  ax: number;
  ay: number;
  az: number;
};

export type Control = { opcode: number; seq: number; nonce: number; arg0: number; arg1: number; arg2: number };
export type Status = { kind: number; seq: number; nonce: number; deviceMs: number; detail0: number; detail1: number };

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function encodeInfo(v: Info): Uint8Array {
  const out = new Uint8Array(RECORD_LEN);
  const d = view(out);
  out[0] = VERSION;
  out[1] = v.caps;
  out[2] = v.sampleHz;
  out[3] = v.rangeG;
  out.set(v.deviceId.subarray(0, 6), 4);
  d.setUint32(10, v.bootId >>> 0, true);
  out[14] = v.fw[0];
  out[15] = v.fw[1];
  out[16] = v.fw[2];
  out[17] = v.axisConvention;
  return out;
}

export function decodeInfo(buf: Uint8Array): Info | null {
  if (buf.length !== RECORD_LEN || buf[0] !== VERSION || buf[18] !== 0 || buf[19] !== 0) return null;
  const d = view(buf);
  return {
    caps: buf[1],
    sampleHz: buf[2],
    rangeG: buf[3],
    deviceId: buf.slice(4, 10),
    bootId: d.getUint32(10, true),
    fw: [buf[14], buf[15], buf[16]],
    axisConvention: buf[17],
  };
}

export function encodeMotion(v: Motion): Uint8Array {
  const out = new Uint8Array(RECORD_LEN);
  const d = view(out);
  out[0] = VERSION;
  out[1] = v.flags;
  d.setUint16(2, v.seq & 0xffff, true);
  d.setUint32(4, v.captureMs >>> 0, true);
  d.setUint32(8, v.bootId >>> 0, true);
  d.setInt16(12, v.ax, true);
  d.setInt16(14, v.ay, true);
  d.setInt16(16, v.az, true);
  return out;
}

export function decodeMotion(buf: Uint8Array): Motion | null {
  if (buf.length !== RECORD_LEN || buf[0] !== VERSION || buf[18] !== 0 || buf[19] !== 0) return null;
  if (buf[1] & ~(MOTION_FLAG.VALID | MOTION_FLAG.SATURATED | MOTION_FLAG.DISCONTINUITY)) return null;
  const d = view(buf);
  const m: Motion = {
    flags: buf[1],
    seq: d.getUint16(2, true),
    captureMs: d.getUint32(4, true),
    bootId: d.getUint32(8, true),
    ax: d.getInt16(12, true),
    ay: d.getInt16(14, true),
    az: d.getInt16(16, true),
  };
  if (Math.abs(m.ax) > RANGE_MG || Math.abs(m.ay) > RANGE_MG || Math.abs(m.az) > RANGE_MG) return null;
  return m;
}

export function encodeControl(v: Control): Uint8Array {
  const out = new Uint8Array(RECORD_LEN);
  const d = view(out);
  out[0] = VERSION;
  out[1] = v.opcode;
  d.setUint16(2, v.seq & 0xffff, true);
  d.setUint32(4, v.nonce >>> 0, true);
  d.setUint32(8, v.arg0 >>> 0, true);
  d.setUint32(12, v.arg1 >>> 0, true);
  d.setUint32(16, v.arg2 >>> 0, true);
  return out;
}

export function decodeControl(buf: Uint8Array): Control | null {
  if (buf.length !== RECORD_LEN || buf[0] !== VERSION) return null;
  const d = view(buf);
  return { opcode: buf[1], seq: d.getUint16(2, true), nonce: d.getUint32(4, true), arg0: d.getUint32(8, true), arg1: d.getUint32(12, true), arg2: d.getUint32(16, true) };
}

export function encodeStatus(v: Status): Uint8Array {
  const out = new Uint8Array(RECORD_LEN);
  const d = view(out);
  out[0] = VERSION;
  out[1] = v.kind;
  d.setUint16(2, v.seq & 0xffff, true);
  d.setUint32(4, v.nonce >>> 0, true);
  d.setUint32(8, v.deviceMs >>> 0, true);
  d.setUint32(12, v.detail0 >>> 0, true);
  d.setUint32(16, v.detail1 >>> 0, true);
  return out;
}

export function decodeStatus(buf: Uint8Array): Status | null {
  if (buf.length !== RECORD_LEN || buf[0] !== VERSION) return null;
  const d = view(buf);
  return { kind: buf[1], seq: d.getUint16(2, true), nonce: d.getUint32(4, true), deviceMs: d.getUint32(8, true), detail0: d.getUint32(12, true), detail1: d.getUint32(16, true) };
}

/** SET_STATE arg0: phase, HP, maxHP, status, least significant byte first. */
export function setStateArgs(phase: number, hp: number, status = 0, maxhp = 100): number {
  return (phase | (hp << 8) | (maxhp << 16) | (status << 24)) >>> 0;
}

/** CUE arg0: effect, spell, duration in ms. */
export function cueArgs(effect: number, spell: number, durationMs: number): number {
  return (effect | (spell << 8) | (durationMs << 16)) >>> 0;
}

/** Contract rule for 16-bit sequences: accept only 0 < (new - old) mod 65536 < 32768. */
export function seqAdvances(next: number, prev: number): boolean {
  const d = (next - prev + 65536) % 65536;
  return d > 0 && d < 32768;
}

/** Wrap-safe difference of two 32-bit millisecond clocks (a - b). */
export function diff32(a: number, b: number): number {
  return ((a - b) | 0);
}

export function hex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function deviceIdHex(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}
