import { describe, expect, it } from "vitest";
import { isPhoneMessage, parsePhoneMessage } from "../../../shared/phone-v2";
import { isAllowedAssetPath, isRoomId, parseOwnerOrigins, randomChallenge, randomHex, secretsEqual } from "./protocol";

const bytes = Array.from({ length: 20 }, (_, index) => index);
const data = (rest: Record<string, unknown>) => ({ v: 2, type: "data", generation: 1, ...rest });
describe("hosted pairing boundary", () => {
  it("generates fixed public and secret formats", () => {
    expect(isRoomId("a".repeat(32))).toBe(true);
    expect(isRoomId("A".repeat(32))).toBe(false);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 32; i++) expect(randomChallenge()).toMatch(/^\d{6}$/);
  });
  it("compares secrets without accepting prefixes", async () => {
    await expect(secretsEqual("correct", "correct")).resolves.toBe(true);
    await expect(secretsEqual("correct", "correct-extra")).resolves.toBe(false);
  });
  it("accepts exact v2 auth shapes and rejects legacy/extra fields", () => {
    expect(isPhoneMessage({ v: 2, type: "owner", token: "a".repeat(64) })).toBe(true);
    expect(isPhoneMessage({ v: 2, type: "phone" })).toBe(true);
    expect(isPhoneMessage({ v: 2, type: "phone", token: "leak" })).toBe(false);
    expect(isPhoneMessage({ v: 1, type: "phone" })).toBe(false);
    expect(isPhoneMessage({ v: 2, type: "resume", role: "admin", token: "a".repeat(64) })).toBe(false);
  });
  it.each(["info", "status", "subscribe-motion", "subscribe-status"])("accepts %s without payload", operation => {
    expect(isPhoneMessage(data({ kind: "op", id: "read", operation }))).toBe(true);
    expect(isPhoneMessage(data({ kind: "op", id: "read", operation, data: bytes }))).toBe(false);
  });
  it("permits only exact 20-byte controls and known operations", () => {
    expect(isPhoneMessage(data({ kind: "op", id: "write", operation: "control", data: bytes }))).toBe(true);
    expect(isPhoneMessage(data({ kind: "op", id: "write", operation: "control", data: bytes.slice(1) }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "op", id: "write", operation: "control", data: [...bytes.slice(1), 256] }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "op", id: "write", operation: "erase" }))).toBe(false);
  });
  it("caps motion batches at two exact records and rejects contradictory replies", () => {
    expect(isPhoneMessage(data({ kind: "motion", sequence: 1, records: [bytes, bytes] }))).toBe(true);
    expect(isPhoneMessage(data({ kind: "motion", sequence: 1, records: [bytes, bytes, bytes] }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "motion", sequence: 0, records: [bytes] }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "reply", id: "read", data: bytes, error: "operation-failed" }))).toBe(false);
  });
  it("caps receipts and excludes non-finite accepted-motion health", () => {
    expect(isPhoneMessage(data({ kind: "receipt", through: 4, statusIds: ["a", "b", "c", "d"] }))).toBe(true);
    expect(isPhoneMessage(data({ kind: "receipt", through: 4, statusIds: ["a", "b", "c", "d", "e"] }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "receipt", through: 4, statusIds: [], accepted: { sequence: 1, accepted: 1, receivedHz: Infinity, ageMs: 10 } }))).toBe(false);
  });
  it("accepts data-channel SDP but rejects microphone/video negotiation and overlong frames", () => {
    const signal = { v: 2, type: "signal", generation: 1, signal: { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" } };
    expect(isPhoneMessage(signal)).toBe(true);
    expect(isPhoneMessage({ ...signal, signal: { ...signal.signal, sdp: signal.signal.sdp + "m=audio 9 RTP/AVP 0\r\n" } })).toBe(false);
    expect(() => parsePhoneMessage("x".repeat(24_577))).toThrow("Oversized");
  });
  it("rejects extra nested fields and impossible coaching progress", () => {
    const accepted = { sequence: 1, accepted: 1, receivedHz: 50, ageMs: 20 };
    expect(isPhoneMessage(data({ kind: "receipt", through: 1, statusIds: [], accepted: { ...accepted, transcript: "not allowed" } }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "coaching", value: { instruction: "Hold still", hint: "", completed: 4, total: 3 } }))).toBe(false);
    expect(isPhoneMessage({ v: 2, type: "signal", generation: 1, signal: { type: "ice", candidate: { candidate: "", sdpMid: null, sdpMLineIndex: null, token: "not allowed" } } })).toBe(false);
  });
  it("allows only bounded numeric calibration diagnostics, never arbitrary support data", () => {
    const diagnostics = { version: 2, neutralMg: [0, -1000, 0], noiseMg: 12, candidate: { startMs: 100, endMs: 400, durationMs: 300, peakMg: 800, dominantRatio: .8, stopEvidence: "release", finalAngleDeg: 8, reason: "" } };
    const coaching = (value: unknown) => data({ kind: "coaching", value: { instruction: "Push forward", hint: "", completed: 0, total: 3, diagnostics: value } });
    expect(isPhoneMessage(coaching(diagnostics))).toBe(true);
    for (const bad of [{ ...diagnostics, transcript: "no" }, { ...diagnostics, noiseMg: NaN }, { ...diagnostics, neutralMg: [0, 1] }, { ...diagnostics, candidate: { ...diagnostics.candidate, durationMs: 800 } }]) expect(isPhoneMessage(coaching(bad))).toBe(false);
  });
  it("allows canonical HTTPS owner origins plus fixed loopback only", () => {
    expect(parseOwnerOrigins(undefined)).toEqual(new Set(["http://127.0.0.1:5173"]));
    expect(parseOwnerOrigins("https://duel.example")).toEqual(new Set(["http://127.0.0.1:5173", "https://duel.example"]));
    for (const origin of ["http://duel.example", "https://duel.example/path", "https://*.example"]) expect(parseOwnerOrigins(origin)).toBeNull();
  });
  it("keeps static surface limited to phone shell and assets", () => {
    for (const path of ["/", "/phone", "/assets/phone-a1.js"]) expect(isAllowedAssetPath(path)).toBe(true);
    for (const path of ["/assets/../secret", "/src/main.tsx", "/@vite/client", "/__qa/game", "/api/speech/transcribe"]) expect(isAllowedAssetPath(path)).toBe(false);
  });
});
