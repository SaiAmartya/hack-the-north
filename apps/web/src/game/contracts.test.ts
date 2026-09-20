import { describe, expect, it } from "vitest";
import fixture from "../../../host/tests/fixtures/game-welcome-v1.json";
import { parseRules, parseSnapshot } from "./contracts";

describe("Python/TypeScript wire fixture", () => {
  it("accepts the exact Pydantic welcome, including not-yet-ready null fields", () => {
    expect(
      parseRules(fixture.rules)
        .spells.filter((s) => s.enabled)
        .map((s) => s.spell),
    ).toEqual(["stupefy", "protego", "expelliarmus", "incendio", "episkey"]);
    expect(parseRules(fixture.rules).spells.find((s) => s.spell === "episkey")?.heal).toBe(18);
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
  it("requires all five distinct moves and their cooldown state", () => {
    expect(() => parseRules({ ...fixture.rules, spells: fixture.rules.spells.slice(0, 3) })).toThrow();
    expect(() => parseRules({ ...fixture.rules, spells: Array(5).fill(fixture.rules.spells[0]) })).toThrow();
    expect(() => parseSnapshot({
      ...fixture.snapshot,
      players: {
        ...fixture.snapshot.players,
        P1: { ...fixture.snapshot.players.P1, cooldownUntilMs: { stupefy: 0, protego: 0 } },
      },
    })).toThrow();
  });
  it("accepts a bot only in the opponent slot of a solo room", () => {
    const solo = { ...fixture.snapshot, mode: "solo", players: {
      ...fixture.snapshot.players,
      P2: { ...fixture.snapshot.players.P1, slot: "P2", source: "bot" },
    } };
    expect(parseSnapshot(solo).players.P2?.source).toBe("bot");
    expect(() => parseSnapshot({ ...solo, mode: "duel" })).toThrow();
    expect(() => parseSnapshot({ ...solo, players: { ...solo.players, P1: { ...solo.players.P1, source: "bot" } } })).toThrow();
    expect(() => parseSnapshot({ ...solo, mode: "unknown" })).toThrow();
  });
  it("requires bounded tutorial state and keeps it out of ordinary duels", () => {
    const tutorial = { ...fixture.snapshot, mode: "tutorial", tutorial: {
      step: 0, spell: "stupefy", stage: "instruction", paused: true,
    } };
    expect(parseSnapshot(tutorial).tutorial?.paused).toBe(true);
    expect(() => parseSnapshot({ ...tutorial, tutorial: null })).toThrow();
    expect(() => parseSnapshot({ ...tutorial, tutorial: { ...tutorial.tutorial, step: 6 } })).toThrow();
    expect(() => parseSnapshot({ ...tutorial, tutorial: { ...tutorial.tutorial, paused: "yes" } })).toThrow();
    expect(() => parseSnapshot({ ...tutorial, mode: "duel" })).toThrow();
  });
});
