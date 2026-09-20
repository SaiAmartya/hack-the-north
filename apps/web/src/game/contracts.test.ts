import { describe, expect, it } from "vitest";
import fixture from "../../../host/tests/fixtures/game-welcome-v1.json";
import { parseIceServers, parseRules, parseSnapshot } from "./contracts";

describe("Python/TypeScript wire fixture", () => {
  it("accepts the exact Pydantic welcome, including not-yet-ready null fields", () => {
    const rules = parseRules(fixture.rules);
    expect(rules.version).toBe(2);
    expect(rules.castRecoveryMs).toBe(500);
    expect(rules.spells.filter((s) => s.enabled).map((s) => s.spell)).toEqual([
      "stupefy",
      "protego",
      "expelliarmus",
      "incendio",
      "sectumsempra",
      "petrificus-totalus",
      "expecto-patronum",
    ]);
    expect(() => parseRules({ ...fixture.rules, version: 1 })).toThrow();
    expect(parseSnapshot(fixture.snapshot).players.P1?.boundUntilMs).toBe(0);
    expect(parseSnapshot(fixture.snapshot).players.P1?.bootId).toBeNull();
    expect(
      parseSnapshot(fixture.snapshot).recentEvents[0].stateVersion,
    ).toBeGreaterThan(0);
    expect(parseIceServers(fixture.iceServers)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ]);
  });
  it("keeps TURN credentials, tolerates an older referee and rejects junk ICE servers", () => {
    expect(parseIceServers(undefined)).toEqual([]);
    expect(
      parseIceServers([
        { urls: "turns:turn.example:443?transport=tcp", username: "u", credential: "c" },
      ]),
    ).toEqual([
      { urls: ["turns:turn.example:443?transport=tcp"], username: "u", credential: "c" },
    ]);
    for (const junk of [{}, [1], [{ urls: [] }], [{ urls: ["http://x"] }]])
      expect(() => parseIceServers(junk)).toThrow();
  });
  it("rejects malformed clocks, players, projectiles and missing event versions", () => {
    expect(() =>
      parseSnapshot({ ...fixture.snapshot, serverNowMs: "100" }),
    ).toThrow();
    expect(() =>
      parseSnapshot({ ...fixture.snapshot, projectiles: [{ id: "x" }] }),
    ).toThrow();
    expect(() =>
      parseSnapshot({
        ...fixture.snapshot,
        recentEvents: [
          { ...fixture.snapshot.recentEvents[0], stateVersion: undefined },
        ],
      }),
    ).toThrow();
  });
});
