export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1_024;
export const MAX_PENDING_OPERATIONS = 8;
export const OPERATION_TIMEOUT_MS = 1_500;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,64}$/;
const ROOM_ID = /^[0-9a-f]{32}$/;
const OWNER_TOKEN = /^[0-9a-f]{64}$/;
const CLAIM_ID = /^[0-9a-f]{32}$/;

export type OwnerOperation = {
  v: 1;
  type: "op";
  id: string;
  operation:
    | "info"
    | "status"
    | "subscribe-motion"
    | "subscribe-status"
    | "control";
  data?: number[];
};

export type PhoneReply = {
  v: 1;
  type: "reply";
  id: string;
  data?: number[];
  error?: string;
};

export type PhoneNotification = {
  v: 1;
  type: "notify";
  kind: "motion" | "status";
  data: number[];
};

export type OwnerAuth = { v: 1; type: "owner"; token: string };
export type PhoneAuth = { v: 1; type: "phone" };
export type OwnerApproval = { v: 1; type: "approve"; claimId: string };
export type OwnerReceived = { v: 1; type: "received"; id: string };

export type OwnerInbound =
  | OwnerAuth
  | OwnerApproval
  | OwnerReceived
  | OwnerOperation;
export type PhoneInbound = PhoneAuth | PhoneReply | PhoneNotification;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isVersionOne(value: JsonRecord): boolean {
  return value.v === PROTOCOL_VERSION;
}

function isBytes20(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 20 &&
    value.every(
      (item) => Number.isInteger(item) && item >= 0 && item <= 255,
    )
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function isRoomId(value: string): boolean {
  return ROOM_ID.test(value);
}

export function isOwnerToken(value: unknown): value is string {
  return typeof value === "string" && OWNER_TOKEN.test(value);
}

export function isClaimId(value: unknown): value is string {
  return typeof value === "string" && CLAIM_ID.test(value);
}

export function parseTextFrame(message: string | ArrayBuffer): unknown {
  if (typeof message !== "string") {
    throw new Error("binary_frame");
  }
  if (new TextEncoder().encode(message).byteLength > MAX_FRAME_BYTES) {
    throw new Error("frame_too_large");
  }
  try {
    return JSON.parse(message) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

export function parseOwnerAuth(value: unknown): OwnerAuth | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type", "token"]) ||
    !isVersionOne(value) ||
    value.type !== "owner" ||
    !isOwnerToken(value.token)
  ) {
    return null;
  }
  return value as OwnerAuth;
}

export function parsePhoneAuth(value: unknown): PhoneAuth | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type"]) ||
    !isVersionOne(value) ||
    value.type !== "phone"
  ) {
    return null;
  }
  return value as PhoneAuth;
}

export function parseOwnerApproval(value: unknown): OwnerApproval | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type", "claimId"]) ||
    !isVersionOne(value) ||
    value.type !== "approve" ||
    !isClaimId(value.claimId)
  ) {
    return null;
  }
  return value as OwnerApproval;
}

export function parseOwnerReceived(value: unknown): OwnerReceived | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type", "id"]) ||
    !isVersionOne(value) ||
    value.type !== "received" ||
    !isClaimId(value.id)
  ) {
    return null;
  }
  return value as OwnerReceived;
}

export function parseOwnerOperation(value: unknown): OwnerOperation | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type", "id", "operation"], ["data"]) ||
    !isVersionOne(value) ||
    value.type !== "op" ||
    !isIdentifier(value.id)
  ) {
    return null;
  }

  const operation = value.operation;
  if (
    operation !== "info" &&
    operation !== "status" &&
    operation !== "subscribe-motion" &&
    operation !== "subscribe-status" &&
    operation !== "control"
  ) {
    return null;
  }
  if (operation === "control") {
    if (!isBytes20(value.data)) return null;
  } else if (Object.hasOwn(value, "data")) {
    return null;
  }
  return value as OwnerOperation;
}

export function parsePhoneReply(value: unknown): PhoneReply | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type", "id"], ["data", "error"]) ||
    !isVersionOne(value) ||
    value.type !== "reply" ||
    !isIdentifier(value.id)
  ) {
    return null;
  }
  const hasData = Object.hasOwn(value, "data");
  const hasError = Object.hasOwn(value, "error");
  if (hasData && hasError) return null;
  if (hasData && !isBytes20(value.data)) return null;
  if (
    hasError &&
    (typeof value.error !== "string" ||
      value.error.length < 1 ||
      value.error.length > 160)
  ) {
    return null;
  }
  return value as PhoneReply;
}

export function parsePhoneNotification(
  value: unknown,
): PhoneNotification | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "type", "kind", "data"]) ||
    !isVersionOne(value) ||
    value.type !== "notify" ||
    (value.kind !== "motion" && value.kind !== "status") ||
    !isBytes20(value.data)
  ) {
    return null;
  }
  return value as PhoneNotification;
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function randomChallenge(): string {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % 1_000_000);
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return (buffer[0] % 1_000_000).toString().padStart(6, "0");
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

export async function secretsEqual(
  candidate: string,
  expected: string,
): Promise<boolean> {
  if (candidate.length > 512 || expected.length > 512) return false;
  const [candidateHash, expectedHash] = await Promise.all([
    sha256Hex(candidate),
    sha256Hex(expected),
  ]);
  let mismatch = candidateHash.length ^ expectedHash.length;
  for (let index = 0; index < expectedHash.length; index += 1) {
    mismatch |=
      (candidateHash.charCodeAt(index) || 0) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}

export function parseOwnerOrigins(value: string | undefined): Set<string> | null {
  const origins = new Set<string>(["http://127.0.0.1:5173"]);
  if (!value?.trim()) return origins;

  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    if (!candidate || candidate.includes("*")) return null;
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.origin !== candidate
      ) {
        return null;
      }
      origins.add(candidate);
    } catch {
      return null;
    }
  }
  return origins;
}

export function isAllowedAssetPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/phone") return true;
  if (!/^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pathname)) {
    return false;
  }
  return !pathname.split("/").includes("..");
}
