/** Phone-only envelopes. Badge GATT records remain exactly 20 bytes. */
export const PHONE_VERSION = 2 as const;
export type PhoneRole = "owner" | "phone";
export type PhoneRoute = "direct" | "relay";
export type PhoneOperation = "info" | "status" | "control" | "subscribe-motion" | "subscribe-status";
export type PhoneIssueCode = "network" | "congestion" | "paused" | "orientation" | "sensor" | "protocol" | "expired" | "direct-unavailable";
export type PhoneCalibrationDiagnostics = {
  version: 2; neutralMg?: readonly [number, number, number]; noiseMg: number;
  candidate?: { startMs: number; endMs: number; durationMs: number; peakMg: number; dominantRatio: number; stopEvidence: "opposite" | "release" | "none"; finalAngleDeg: number; reason: string };
};
export type PhoneCoaching = { instruction: string; completed: number; total: number; hint: string; diagnostics?: PhoneCalibrationDiagnostics };
export type AcceptedMotion = { sequence: number; accepted: number; receivedHz: number; ageMs: number };
type Base = { v: 2; type: "data"; generation: number };
export type PhoneData = Base & (
  | { kind: "begin-link"; id: string }
  | { kind: "begun"; id: string }
  | { kind: "op"; id: string; operation: PhoneOperation; data?: number[] }
  | { kind: "reply"; id: string; data?: number[]; error?: "operation-failed" }
  | { kind: "motion"; sequence: number; records: number[][] }
  | { kind: "status"; id: string; data: number[] }
  | { kind: "receipt"; through: number; statusIds: string[]; accepted?: AcceptedMotion }
  | { kind: "coaching"; value: PhoneCoaching }
  | { kind: "issue"; code: PhoneIssueCode; recoverable: boolean }
);
export type PhoneSignal = { type: "offer" | "answer"; sdp: string } | { type: "ice"; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null } };
export type PhoneMessage =
  | { v: 2; type: "owner"; token: string }
  | { v: 2; type: "phone" }
  | { v: 2; type: "resume"; role: PhoneRole; token: string }
  | { v: 2; type: "approve"; claimId: string }
  | { v: 2; type: "claim"; claimId: string; challenge: string }
  | { v: 2; type: "awaiting"; challenge: string }
  | { v: 2; type: "paired"; generation: number; resumeToken?: string; expiresAtMs: number; route: PhoneRoute; resumed: boolean }
  | { v: 2; type: "recovering"; generation: number; code: PhoneIssueCode; route: PhoneRoute; resumeUntilMs: number }
  | { v: 2; type: "reset-link"; generation: number }
  | { v: 2; type: "signal"; generation: number; signal: PhoneSignal }
  | { v: 2; type: "route"; generation: number; route: PhoneRoute }
  | { v: 2; type: "peer-unavailable"; code: PhoneIssueCode; recoverable: boolean }
  | { v: 2; type: "error"; code: string }
  | { v: 2; type: "leave" }
  | PhoneData;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const short = (v: unknown, max = 160): v is string => typeof v === "string" && v.length <= max;
const identifier = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const hex = (v: unknown, n: number) => typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const issues: readonly string[] = ["network", "congestion", "paused", "orientation", "sensor", "protocol", "expired", "direct-unavailable"];
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function isPhoneCalibrationDiagnostics(v: unknown): v is PhoneCalibrationDiagnostics {
  if (!object(v) || !keys(v, ["version", "neutralMg", "noiseMg", "candidate"]) || v.version !== 2 || !finite(v.noiseMg, 0, 16000)) return false;
  if (v.neutralMg !== undefined && (!Array.isArray(v.neutralMg) || v.neutralMg.length !== 3 || !v.neutralMg.every(x => finite(x, -8000, 8000)))) return false;
  const c = v.candidate;
  return c === undefined || (object(c) && keys(c, ["startMs", "endMs", "durationMs", "peakMg", "dominantRatio", "stopEvidence", "finalAngleDeg", "reason"]) &&
    finite(c.startMs, 0, Number.MAX_SAFE_INTEGER) && finite(c.endMs, c.startMs, Number.MAX_SAFE_INTEGER) && finite(c.durationMs, 0, 5000) &&
    Math.abs(c.durationMs - (c.endMs - c.startMs)) < 1 && finite(c.peakMg, 0, 30000) && finite(c.dominantRatio, 0, 1.00001) &&
    ["opposite", "release", "none"].includes(String(c.stopEvidence)) && finite(c.finalAngleDeg, 0, 180) && typeof c.reason === "string" && /^[a-z0-9-]{0,64}$/.test(c.reason));
}
export function isPhoneRecord(v: unknown): v is number[] { return Array.isArray(v) && v.length === 20 && v.every(x => integer(x, 0, 255)); }
export function isPhoneData(v: unknown): v is PhoneData {
  if (!object(v) || v.v !== 2 || v.type !== "data" || !integer(v.generation, 1)) return false;
  const fields: Record<string, string[]> = { "begin-link": ["id"], begun: ["id"], op: ["id", "operation", "data"], reply: ["id", "data", "error"], motion: ["sequence", "records"], status: ["id", "data"], receipt: ["through", "statusIds", "accepted"], coaching: ["value"], issue: ["code", "recoverable"] };
  if (typeof v.kind !== "string" || !Object.hasOwn(fields, v.kind) || !keys(v, ["v", "type", "generation", "kind", ...fields[v.kind]])) return false;
  switch (v.kind) {
    case "begin-link": case "begun": return identifier(v.id);
    case "op": return identifier(v.id) && ["info", "status", "control", "subscribe-motion", "subscribe-status"].includes(String(v.operation)) && (v.operation === "control" ? isPhoneRecord(v.data) : v.data === undefined);
    case "reply": return identifier(v.id) && (v.data === undefined || isPhoneRecord(v.data)) && (v.error === undefined || (v.error === "operation-failed" && v.data === undefined));
    case "motion": return integer(v.sequence, 1) && Array.isArray(v.records) && v.records.length >= 1 && v.records.length <= 2 && v.records.every(isPhoneRecord);
    case "status": return identifier(v.id) && isPhoneRecord(v.data);
    case "receipt": return integer(v.through) && Array.isArray(v.statusIds) && v.statusIds.length <= 4 && v.statusIds.every(identifier) && (v.accepted === undefined || (object(v.accepted) && keys(v.accepted, ["sequence", "accepted", "receivedHz", "ageMs"]) && integer(v.accepted.sequence, 0, 65535) && integer(v.accepted.accepted) && typeof v.accepted.receivedHz === "number" && Number.isFinite(v.accepted.receivedHz) && v.accepted.receivedHz >= 0 && v.accepted.receivedHz <= 1000 && typeof v.accepted.ageMs === "number" && Number.isFinite(v.accepted.ageMs) && v.accepted.ageMs >= 0 && v.accepted.ageMs <= 10000));
    case "coaching": return object(v.value) && keys(v.value, ["instruction", "hint", "completed", "total", "diagnostics"]) && short(v.value.instruction) && short(v.value.hint) && integer(v.value.completed, 0, 20) && integer(v.value.total, 0, 20) && v.value.completed <= v.value.total && (v.value.diagnostics === undefined || isPhoneCalibrationDiagnostics(v.value.diagnostics));
    case "issue": return issues.includes(String(v.code)) && typeof v.recoverable === "boolean";
    default: return false;
  }
}
export function isPhoneMessage(v: unknown): v is PhoneMessage {
  if (!object(v) || v.v !== 2) return false;
  if (v.type === "data") return isPhoneData(v);
  const fields: Record<string, string[]> = { owner: ["token"], phone: [], leave: [], resume: ["role", "token"], approve: ["claimId"], claim: ["claimId", "challenge"], awaiting: ["challenge"], paired: ["generation", "resumeToken", "expiresAtMs", "route", "resumed"], recovering: ["generation", "code", "route", "resumeUntilMs"], "reset-link": ["generation"], route: ["generation", "route"], signal: ["generation", "signal"], "peer-unavailable": ["code", "recoverable"], error: ["code"] };
  if (typeof v.type !== "string" || !Object.hasOwn(fields, v.type) || !keys(v, ["v", "type", ...fields[v.type]])) return false;
  switch (v.type) {
    case "owner": return hex(v.token, 64);
    case "phone": case "leave": return true;
    case "resume": return (v.role === "owner" || v.role === "phone") && hex(v.token, 64);
    case "approve": return hex(v.claimId, 32);
    case "claim": return hex(v.claimId, 32) && typeof v.challenge === "string" && /^\d{6}$/.test(v.challenge);
    case "awaiting": return typeof v.challenge === "string" && /^\d{6}$/.test(v.challenge);
    case "paired": return integer(v.generation, 1) && (v.resumeToken === undefined || hex(v.resumeToken, 64)) && integer(v.expiresAtMs, 1) && (v.route === "direct" || v.route === "relay") && typeof v.resumed === "boolean";
    case "recovering": return integer(v.generation, 1) && issues.includes(String(v.code)) && (v.route === "direct" || v.route === "relay") && integer(v.resumeUntilMs, 1);
    case "reset-link": return integer(v.generation, 1);
    case "route": return integer(v.generation, 1) && (v.route === "direct" || v.route === "relay");
    case "signal": {
      if (!integer(v.generation, 1) || !object(v.signal)) return false;
      const s = v.signal;
      if (s.type === "offer" || s.type === "answer") return keys(s, ["type", "sdp"]) && short(s.sdp, 16384) && /^m=application /m.test(s.sdp) && !/^m=(audio|video) /m.test(s.sdp);
      return s.type === "ice" && keys(s, ["type", "candidate"]) && object(s.candidate) && keys(s.candidate, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]) && short(s.candidate.candidate, 4096) && (s.candidate.sdpMid === null || short(s.candidate.sdpMid, 64)) && (s.candidate.sdpMLineIndex === null || integer(s.candidate.sdpMLineIndex, 0, 16)) && (s.candidate.usernameFragment === undefined || s.candidate.usernameFragment === null || short(s.candidate.usernameFragment, 256));
    }
    case "peer-unavailable": return issues.includes(String(v.code)) && typeof v.recoverable === "boolean";
    case "error": return typeof v.code === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v.code);
    default: return false;
  }
}
export function parsePhoneMessage(text: string): PhoneMessage {
  if (text.length > 24576) throw new Error("Oversized phone message");
  const value: unknown = JSON.parse(text);
  if (!isPhoneMessage(value)) throw new Error("Invalid phone message");
  return value;
}
