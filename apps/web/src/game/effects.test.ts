import { describe, expect, it } from "vitest";
import { flightPosition } from "./effects";
describe("authoritative effect timing", () => {
  it("seeks late flights and clamps bounds without inventing an outcome", () => {
    expect(flightPosition(100, 2100, 100, true)).toEqual({
      x: 0.18,
      y: 0.76,
      progress: 0,
    });
    expect(flightPosition(100, 2100, 1100, true).progress).toBe(0.5);
    expect(flightPosition(100, 2100, 2400, false).progress).toBe(1);
    expect(flightPosition(100, 2100, 0, true).progress).toBe(0);
  });
});
