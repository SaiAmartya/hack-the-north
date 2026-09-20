import { describe, expect, it } from "vitest";
import { dtwDistance, prepareImpulseTrace } from "./dtw";

describe("impulse trace preparation", () => {
  it("normalizes one trace by a scalar peak while preserving axis ratios", () => {
    const trace = prepareImpulseTrace([
      [0, 0, 0],
      [800, 200, 0],
      [-400, -100, 0],
    ]);

    expect(trace.points[0]).toEqual([0, 0, 0]);
    expect(trace.points[1][0]).toBeCloseTo(0.9701425);
    expect(trace.points[1][1]).toBeCloseTo(0.2425356);
    expect(trace.points[1][2]).toBe(0);
    expect(trace.points[2][0]).toBeCloseTo(-0.4850713);
    expect(trace.points[2][1]).toBeCloseTo(-0.1212678);
    expect(trace.points[2][2]).toBe(0);
    expect(trace.peakMg).toBeCloseTo(Math.hypot(800, 200));
  });

  it("rejects non-finite, empty, and zero-energy traces", () => {
    expect(() => prepareImpulseTrace([])).toThrow();
    expect(() =>
      prepareImpulseTrace([
        [0, 0, 0],
        [0, 0, 0],
      ]),
    ).toThrow();
    expect(() => prepareImpulseTrace([[Number.NaN, 0, 0]])).toThrow();
  });
});

describe("multivariate DTW distance", () => {
  it("gives identical shapes a low distance across different speeds", () => {
    const short = prepareImpulseTrace([
      [0, 0, 0],
      [800, 0, 0],
      [-400, 0, 0],
      [0, 0, 0],
    ]);
    const long = prepareImpulseTrace([
      [0, 0, 0],
      [400, 0, 0],
      [800, 0, 0],
      [200, 0, 0],
      [-400, 0, 0],
      [-200, 0, 0],
      [0, 0, 0],
    ]);

    expect(dtwDistance(short, long)).toBeLessThan(0.25);
  });

  it("keeps reversed and orthogonal impulses far from a forward template", () => {
    const forward = prepareImpulseTrace([
      [0, 0, 0],
      [800, 0, 0],
      [-400, 0, 0],
      [0, 0, 0],
    ]);
    const reverse = prepareImpulseTrace([
      [0, 0, 0],
      [-800, 0, 0],
      [400, 0, 0],
      [0, 0, 0],
    ]);
    const lateral = prepareImpulseTrace([
      [0, 0, 0],
      [0, 800, 0],
      [0, -400, 0],
      [0, 0, 0],
    ]);

    const reversedDistance = dtwDistance(forward, reverse);
    const lateralDistance = dtwDistance(forward, lateral);
    expect(reversedDistance).toBeGreaterThan(0.35);
    expect(lateralDistance).toBeGreaterThan(0.5);
  });
});
