import { describe, expect, it } from "vitest";
import fixture from "../../../host/tests/fixtures/game-welcome-v1.json";
import { parseRules, parseSnapshot } from "./contracts";

describe("Python/TypeScript wire fixture", () => {
  it("accepts the exact Pydantic welcome, including not-yet-ready null fields", () => {
    expect(
      parseRules(fixture.rules)
        .spells.filter((s) => s.enabled)
        .map((s) => s.spell),
    ).toEqual(["stupefy", "protego"]);
    expect(parseSnapshot(fixture.snapshot).players.P1?.bootId).toBeNull();
    expect(
      parseSnapshot(fixture.snapshot).recentEvents[0].stateVersion,
    ).toBeGreaterThan(0);
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
