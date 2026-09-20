import { describe, expect, it } from "vitest";
import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";
import { AccelerationSpikeRecognizer, type AccelerationSpikeEvidence } from "./spike";
import badgeFixture from "./fixtures/badge-gestures-2026-09-20.json";

function sample(time: number, acceleration: readonly number[] = [0, 0, 1_000], overrides: Partial<CapturedMotion> = {}): CapturedMotion {
  return { version: 1, seq: Math.round(time / 20), captureMs: time, browserMs: time, bootId: 1,
    axMg: acceleration[0], ayMg: acceleration[1], azMg: acceleration[2], ageUpperMs: 20,
    flags: MotionFlag.Valid, breaksGesture: false, ...overrides };
}

function feed(recognizer: AccelerationSpikeRecognizer, start: number, end: number, acceleration?: readonly number[], generation = 4): void {
  for (let time = start; time <= end; time += 20) recognizer.push(sample(time, acceleration), generation);
}

describe("optional directionless acceleration confirmation", () => {
  it.each([[650, 0, 1_000], [-650, 0, 1_000], [0, 650, 1_000], [0, 0, 1_650], [0, 0, 350]])(
    "confirms the same brief movement at %j without spell identity", (...vector) => {
      const evidence: AccelerationSpikeEvidence[] = [];
      const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
      feed(recognizer, 0, 280);
      feed(recognizer, 300, 360, vector);
      feed(recognizer, 380, 900);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ kind: "acceleration-spike", generation: 4, startMs: 300, endMs: 320 });
      expect(evidence[0]).not.toHaveProperty("spell");
    },
  );

  it("ignores quiet noise, slow drift, subthreshold movement and an isolated single-sample blip", () => {
    const evidence: AccelerationSpikeEvidence[] = [];
    const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
    for (let time = 0; time <= 1_000; time += 20)
      recognizer.push(sample(time, [Math.sin(time) * 8 + time / 10, 0, 1_000]), 4);
    feed(recognizer, 1_020, 1_400, [100, 0, 1_000]);
    feed(recognizer, 1_420, 1_460, [270, 0, 1_000]);
    feed(recognizer, 1_480, 2_000, [100, 0, 1_000]);
    recognizer.push(sample(2_020, [750, 0, 1_000]), 4);
    feed(recognizer, 2_040, 2_600, [100, 0, 1_000]);
    expect(evidence).toEqual([]);
  });

  it("emits once for sustained shaking, then rearms after quiet", () => {
    const evidence: AccelerationSpikeEvidence[] = [];
    const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
    feed(recognizer, 0, 280);
    for (let time = 300; time <= 1_300; time += 20)
      recognizer.push(sample(time, [Math.round(time / 20) % 2 ? 700 : -700, 0, 1_000]), 4);
    expect(evidence).toHaveLength(1);
    feed(recognizer, 1_320, 1_900);
    feed(recognizer, 1_920, 1_980, [650, 0, 1_000]);
    expect(evidence).toHaveLength(2);
    expect(evidence[0].id).not.toBe(evidence[1].id);
  });

  it.each([
    { ageUpperMs: 201 }, { ageUpperMs: -1 }, { ageUpperMs: NaN },
    { flags: 0 }, { flags: MotionFlag.Valid | MotionFlag.Saturated },
    { flags: MotionFlag.Valid | MotionFlag.Discontinuity }, { flags: 9 },
    { axMg: NaN }, { ayMg: Infinity }, { azMg: -Infinity }, { browserMs: NaN },
    { captureMs: Infinity }, { seq: 99 }, { bootId: 2 }, { breaksGesture: true },
  ])("requires fresh quiet rearm after an invalid or discontinuous sample %j", overrides => {
    const evidence: AccelerationSpikeEvidence[] = [];
    const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
    feed(recognizer, 0, 280);
    recognizer.push(sample(300, [650, 0, 1_000]), 4);
    recognizer.push(sample(320, [650, 0, 1_000], overrides), 4);
    feed(recognizer, 340, 400, [650, 0, 1_000]);
    expect(evidence).toHaveLength(0);
    feed(recognizer, 420, 1_000);
    feed(recognizer, 1_020, 1_080, [650, 0, 1_000]);
    expect(evidence).toHaveLength(1);
  });

  it("resets across a timestamp gap, generation change and explicit reset without reusing IDs", () => {
    const evidence: AccelerationSpikeEvidence[] = [];
    const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
    feed(recognizer, 0, 280);
    recognizer.push(sample(300, [650, 0, 1_000]), 4);
    recognizer.push(sample(480, [650, 0, 1_000], { seq: 16 }), 4);
    feed(recognizer, 500, 900, [650, 0, 1_000]);
    feed(recognizer, 920, 1_000, [0, 0, 1_000], 5);
    expect(evidence).toEqual([]);
    feed(recognizer, 1_020, 1_600, undefined, 5);
    feed(recognizer, 1_620, 1_680, [650, 0, 1_000], 5);
    expect(evidence).toHaveLength(1);
    recognizer.reset();
    feed(recognizer, 1_700, 1_740, [0, 0, 1_000], 5);
    expect(evidence).toHaveLength(1);
    feed(recognizer, 1_760, 2_200, undefined, 5);
    feed(recognizer, 2_220, 2_280, [650, 0, 1_000], 5);
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map(value => value.id)).size).toBe(2);
  });

  it("preserves the exact 200 ms sample-age and 150 ms continuity boundaries", () => {
    const evidence: AccelerationSpikeEvidence[] = [];
    const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
    feed(recognizer, 0, 280);
    recognizer.push(sample(430, [900, 0, 1_000], { seq: 15, ageUpperMs: 200 }), 4);
    recognizer.push(sample(450, [900, 0, 1_000], { seq: 16, ageUpperMs: 200 }), 4);
    expect(evidence).toHaveLength(1);
  });

  it("detects movement in the existing real badge positive excerpts without class labels", () => {
    for (const trace of badgeFixture.cases.filter(trace => trace.expected !== "none-during-move")) {
      const evidence: AccelerationSpikeEvidence[] = [];
      const recognizer = new AccelerationSpikeRecognizer(value => evidence.push(value));
      for (const row of trace.samples) {
        const [browserMs, captureMs, seq, axMg, ayMg, azMg, ageUpperMs, flags] = row.slice(0, 8).map(Number);
        recognizer.push({ version: 1, bootId: 1, browserMs, captureMs, seq, axMg, ayMg, azMg, ageUpperMs, flags, breaksGesture: !!row[8] }, 4);
      }
      expect(evidence.length, trace.name).toBeGreaterThan(0);
      expect(evidence.every(value => value.kind === "acceleration-spike")).toBe(true);
    }
  });
});
