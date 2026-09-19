import { describe, expect, it } from "vitest";
import type { CapturedMotion } from "../wand/client";
import {
  MotionRecognizer,
  type GestureEvidence,
  type SpellName,
} from "./motion";
import {
  RawMotionTraceBuilder,
  createCoreMotionFixtures,
} from "./traceFixtures";

class MotionHarness {
  readonly builder = new RawMotionTraceBuilder();
  generation = 7;

  constructor(readonly recognizer: MotionRecognizer) {}

  feed(samples: readonly CapturedMotion[]): void {
    for (const sample of samples) this.recognizer.push(sample, this.generation);
  }

  calibrate(spell: SpellName): void {
    this.recognizer.beginGestureCalibration(spell);
    if (spell === "protego") {
      this.feed(this.builder.guard(33));
      this.feed(this.builder.guard(36));
      this.feed(this.builder.guard(39));
    } else {
      const axis = spell === "stupefy" ? 0 : 1;
      this.feed(this.builder.jab(820, axis));
      this.feed(this.builder.jab(900, axis));
      this.feed(this.builder.jab(980, axis));
    }
  }
}

function calibrateCore(onGesture: (evidence: GestureEvidence) => void) {
  const recognizer = new MotionRecognizer(onGesture);
  const harness = new MotionHarness(recognizer);
  recognizer.beginCalibration();
  harness.feed(harness.builder.stillness());
  harness.calibrate("stupefy");
  harness.calibrate("protego");
  return harness;
}

describe("accelerometer-only motion recognition", () => {
  it("calibrates three coached core examples and recognizes held-out raw traces", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const harness = new MotionHarness(recognizer);
    const fixtures = createCoreMotionFixtures();
    recognizer.beginCalibration();
    harness.feed(fixtures.stillness);
    recognizer.beginGestureCalibration("stupefy");
    fixtures.calibration.stupefy.forEach((trace) => harness.feed(trace));
    recognizer.beginGestureCalibration("protego");
    fixtures.calibration.protego.forEach((trace) => harness.feed(trace));

    expect(recognizer.getState()).toMatchObject({
      phase: "ready",
      examplesBySpell: { stupefy: 3, protego: 3, expelliarmus: 0 },
      calibratedSpells: ["stupefy", "protego"],
      enabledSpells: ["stupefy", "protego"],
    });

    harness.feed(fixtures.heldOut.stupefy);
    harness.feed(fixtures.heldOut.protego);

    expect(evidence.map((item) => item.spell)).toEqual([
      "stupefy",
      "protego",
    ]);
    expect(evidence.every((item) => item.endMs > item.startMs)).toBe(true);
    expect(evidence.every((item) => item.quality >= 0 && item.quality <= 1)).toBe(
      true,
    );
  });

  it("does not recast a held guard or classify a wrong-axis impulse", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.feed(harness.builder.guard(34, 2_000));
    harness.feed(harness.builder.jab(900, 1));

    expect(evidence).toHaveLength(1);
    expect(evidence[0].spell).toBe("protego");
  });

  it("fails candidates that cross a gap or saturated sample", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.feed(harness.builder.brokenJab("gap"));
    expect(evidence).toHaveLength(0);
    expect(harness.recognizer.getState().lastIssue).toContain("gap exceeded");

    harness.feed(harness.builder.brokenJab("saturated"));
    expect(evidence).toHaveLength(0);
    expect(harness.recognizer.getState().lastIssue).toContain("saturated");
  });

  it("invalidates calibration when the input generation changes", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.generation++;
    harness.feed(harness.builder.neutralSample());

    expect(harness.recognizer.getState()).toMatchObject({
      phase: "uncalibrated",
      lastIssue: "Motion generation changed; recalibrate for the new stream",
    });
    expect(evidence).toHaveLength(0);
  });

  it("keeps the calibrated sweep classifier disabled until explicitly enabled", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));
    harness.calibrate("expelliarmus");

    harness.feed(harness.builder.jab(800, 1));
    expect(evidence).toHaveLength(0);

    harness.recognizer.setEnabledSpells([
      "stupefy",
      "protego",
      "expelliarmus",
    ]);
    harness.feed(harness.builder.jab(800, 1));
    expect(evidence.map((item) => item.spell)).toEqual(["expelliarmus"]);
  });

  it("clears an in-flight segment without discarding calibration", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.recognizer.clearPending("round changed");
    expect(harness.recognizer.getState()).toMatchObject({
      phase: "ready",
      calibratedSpells: ["stupefy", "protego"],
      lastIssue: "round changed",
    });
    harness.feed(harness.builder.jab(760));
    expect(evidence.map((item) => item.spell)).toEqual(["stupefy"]);
  });
});
