import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  isAllowedAssetPath,
  isClaimId,
  isOwnerToken,
  isRoomId,
  parseOwnerApproval,
  parseOwnerAuth,
  parseOwnerOperation,
  parseOwnerOrigins,
  parseOwnerReceived,
  parsePhoneAuth,
  parsePhoneNotification,
  parsePhoneReply,
  parseTextFrame,
  randomChallenge,
  randomHex,
  secretsEqual,
} from "./protocol";

const bytes20 = Array.from({ length: 20 }, (_, index) => index);

describe("hosted pairing wire identifiers", () => {
  it("uses fixed lowercase hexadecimal room and owner credentials", () => {
    expect(isRoomId("a".repeat(32))).toBe(true);
    expect(isRoomId("A".repeat(32))).toBe(false);
    expect(isOwnerToken("b".repeat(64))).toBe(true);
    expect(isOwnerToken("b".repeat(63))).toBe(false);
    expect(isClaimId("c".repeat(32))).toBe(true);
  });

  it("generates the fixed public and secret formats", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
    for (let index = 0; index < 32; index += 1) {
      expect(randomChallenge()).toMatch(/^\d{6}$/);
    }
  });

  it("compares secrets without accepting prefixes", async () => {
    await expect(secretsEqual("correct", "correct")).resolves.toBe(true);
    await expect(secretsEqual("correct", "correct-extra")).resolves.toBe(false);
  });
});

describe("pre-pair messages", () => {
  it("accepts only the exact owner authentication shape", () => {
    const valid = { v: 1, type: "owner", token: "a".repeat(64) };
    expect(parseOwnerAuth(valid)).toEqual(valid);
    expect(parseOwnerAuth({ ...valid, token: "short" })).toBeNull();
    expect(parseOwnerAuth({ ...valid, roomId: "a".repeat(32) })).toBeNull();
  });

  it("accepts a credential-free phone claim initiation only", () => {
    expect(parsePhoneAuth({ v: 1, type: "phone" })).toEqual({
      v: 1,
      type: "phone",
    });
    expect(parsePhoneAuth({ v: 1, type: "phone", token: "leak" })).toBeNull();
  });

  it("requires the exact server-issued claim identifier for approval", () => {
    const valid = { v: 1, type: "approve", claimId: "d".repeat(32) };
    expect(parseOwnerApproval(valid)).toEqual(valid);
    expect(parseOwnerApproval({ ...valid, claimId: "d" })).toBeNull();
    expect(parseOwnerApproval({ ...valid, challenge: "123456" })).toBeNull();
  });

  it("accepts only a fixed delivery acknowledgement", () => {
    const valid = { v: 1, type: "received", id: "e".repeat(32) };
    expect(parseOwnerReceived(valid)).toEqual(valid);
    expect(parseOwnerReceived({ ...valid, id: "short" })).toBeNull();
    expect(parseOwnerReceived({ ...valid, deliveredAt: 10 })).toBeNull();
  });
});

describe("opaque wand operations", () => {
  it.each(["info", "status", "subscribe-motion", "subscribe-status"])(
    "accepts %s without data",
    (operation) => {
      expect(
        parseOwnerOperation({ v: 1, type: "op", id: "request-1", operation }),
      ).not.toBeNull();
    },
  );

  it("requires exactly 20 bytes for control", () => {
    const valid = {
      v: 1,
      type: "op",
      id: "request-2",
      operation: "control",
      data: bytes20,
    };
    expect(parseOwnerOperation(valid)).toEqual(valid);
    expect(parseOwnerOperation({ ...valid, data: bytes20.slice(1) })).toBeNull();
    expect(
      parseOwnerOperation({ ...valid, data: [...bytes20.slice(0, 19), 256] }),
    ).toBeNull();
  });

  it("rejects data on reads and unknown or extra operation fields", () => {
    expect(
      parseOwnerOperation({
        v: 1,
        type: "op",
        id: "read",
        operation: "info",
        data: bytes20,
      }),
    ).toBeNull();
    expect(
      parseOwnerOperation({
        v: 1,
        type: "op",
        id: "read",
        operation: "erase",
      }),
    ).toBeNull();
    expect(
      parseOwnerOperation({
        v: 1,
        type: "op",
        id: "read",
        operation: "info",
        timestamp: 10,
      }),
    ).toBeNull();
  });

  it("accepts reply data, errors, and empty acknowledgements but never both", () => {
    expect(
      parsePhoneReply({ v: 1, type: "reply", id: "read", data: bytes20 }),
    ).not.toBeNull();
    expect(
      parsePhoneReply({ v: 1, type: "reply", id: "write" }),
    ).not.toBeNull();
    expect(
      parsePhoneReply({ v: 1, type: "reply", id: "read", error: "failed" }),
    ).not.toBeNull();
    expect(
      parsePhoneReply({
        v: 1,
        type: "reply",
        id: "read",
        data: bytes20,
        error: "failed",
      }),
    ).toBeNull();
  });

  it("accepts only motion or status notifications with exact records", () => {
    expect(
      parsePhoneNotification({
        v: 1,
        type: "notify",
        kind: "motion",
        data: bytes20,
      }),
    ).not.toBeNull();
    expect(
      parsePhoneNotification({
        v: 1,
        type: "notify",
        kind: "video",
        data: bytes20,
      }),
    ).toBeNull();
  });
});

describe("edge request boundaries", () => {
  it("accepts text JSON below the cap and rejects binary or oversized frames", () => {
    expect(parseTextFrame('{"v":1}')).toEqual({ v: 1 });
    expect(() => parseTextFrame(new ArrayBuffer(1))).toThrow("binary_frame");
    expect(() => parseTextFrame("x".repeat(MAX_FRAME_BYTES + 1))).toThrow(
      "frame_too_large",
    );
  });

  it("allows only canonical HTTPS owner origins plus fixed loopback", () => {
    expect(parseOwnerOrigins(undefined)).toEqual(
      new Set(["http://127.0.0.1:5173"]),
    );
    expect(parseOwnerOrigins("https://duel.example"))?.toEqual(
      new Set(["http://127.0.0.1:5173", "https://duel.example"]),
    );
    expect(parseOwnerOrigins("http://duel.example")).toBeNull();
    expect(parseOwnerOrigins("https://duel.example/path")).toBeNull();
    expect(parseOwnerOrigins("https://*.example")).toBeNull();
  });

  it("keeps the static surface to the phone shell and hashed assets", () => {
    expect(isAllowedAssetPath("/")).toBe(true);
    expect(isAllowedAssetPath("/phone")).toBe(true);
    expect(isAllowedAssetPath("/assets/phone-a1.js")).toBe(true);
    expect(isAllowedAssetPath("/assets/../secret")).toBe(false);
    expect(isAllowedAssetPath("/src/main.tsx")).toBe(false);
    expect(isAllowedAssetPath("/@vite/client")).toBe(false);
    expect(isAllowedAssetPath("/__qa/game")).toBe(false);
    expect(isAllowedAssetPath("/api/speech/transcribe")).toBe(false);
  });
});
