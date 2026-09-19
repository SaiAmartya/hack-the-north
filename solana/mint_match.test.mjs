import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetadata } from "./mint_match.mjs";

test("metadata names the winner and keeps the on-chain name under 32 chars", () => {
  const m = buildMetadata({ winner: "Ada", mode: "Raid", kills: 2, loot: 1, badges: 5, when: new Date("2026-09-20T10:00:00Z") });
  assert.equal(m.name, "Phantom Arena: Ada wins");
  assert.ok(m.name.length <= 32);
  assert.deepEqual(m.attributes.map((a) => a.trait_type), ["mode", "kills", "loot", "badges", "date"]);
  assert.equal(m.attributes[4].value, "2026-09-20");
  assert.throws(() => buildMetadata({}), /winner is required/);
});
