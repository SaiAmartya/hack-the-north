import { describe, expect, it } from "vitest";
import { PhoneSampler } from "./sensor";
import { recordBytes } from "./relay";
import { MotionFlag } from "../wand/protocol";
describe("phone observations", () => {
  it("converts signed gravity, uses the observation clock, and never duplicates", () => {
    const sampler = new PhoneSampler();
    sampler.observe(0, -9.80665, 0, 100);
    expect(sampler.select(115, 1)).toMatchObject({
      captureMs: 100,
      ayMg: -1000,
      seq: 0,
    });
    expect(sampler.select(135, 1)).toBeUndefined();
  });
  it("separates intentional decimation, marks gaps and rejects stale readings", () => {
    const s = new PhoneSampler();
    s.observe(0, 0, 9.80665, 10);
    s.observe(0, 0, 9.80665, 20);
    expect(s.intentionalDecimation).toBe(1);
    s.select(21, 1);
    s.observe(0, 0, 9.80665, 200);
    expect(s.select(201, 1)!.flags & MotionFlag.Discontinuity).toBeTruthy();
    s.observe(0, 0, 9.80665, 220);
    expect(s.select(421, 1)).toBeUndefined();
  });
  it("validates exact opaque records", () => {
    expect(() => recordBytes([1, 2])).toThrow();
    expect(() => recordBytes(Array(20).fill(-1))).toThrow();
    expect(recordBytes(Array(20).fill(0))).toHaveLength(20);
  });
});
