import { describe, expect, it } from "vitest";
import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";
import { MotionRecognizer, type GestureEvidence, type SpellName } from "./motion";
import { RawMotionTraceBuilder, createCoreMotionFixtures, type CoreMotionFixtures } from "./traceFixtures";
import phoneJabs from "./fixtures/phone-jabs-2026-09-19.json";
import phoneTurn from "./fixtures/phone-turn-2026-09-20.json";
import badgeGestures from "./fixtures/badge-gestures-2026-09-20.json";

type Pose = readonly [number, number, number];
type Rotation = readonly [Pose, Pose, Pose];

class MotionHarness {
  readonly builder = new RawMotionTraceBuilder();
  generation = 7;
  readonly evidence: GestureEvidence[] = [];
  readonly recognizer = new MotionRecognizer((item) => this.evidence.push(item));

  feed(samples: readonly CapturedMotion[]): void {
    for (const sample of samples) this.recognizer.push(sample, this.generation);
  }

  still(): void {
    this.recognizer.beginCalibration();
    this.feed(this.builder.stillness());
    expect(this.recognizer.getState().phase).toBe("gesture-calibration");
  }

  calibrate(spell: SpellName): void {
    this.recognizer.beginGestureCalibration(spell);
    if (spell === "protego") {
      for (const degrees of [33, 36, 39]) {
        this.feed(this.builder.guard(degrees));
        this.feed(this.builder.lower(degrees));
      }
    } else {
      const axis = spell === "stupefy" ? 0 : 1;
      this.feed(this.builder.jab(820, axis));
      this.feed(this.builder.jab(900, axis));
      this.feed(this.builder.jab(980, axis));
    }
    expect(this.recognizer.getState().examplesBySpell[spell]).toBe(3);
  }

  ready(): void {
    this.still();
    this.calibrate("stupefy");
    this.calibrate("protego");
    expect(this.recognizer.getState().phase).toBe("ready");
  }

  spells(): SpellName[] {
    return this.evidence.map((item) => item.spell);
  }
}

function rotatePose(pose: Pose, rotation: Rotation): Pose {
  return [
    rotation[0][0] * pose[0] + rotation[0][1] * pose[1] + rotation[0][2] * pose[2],
    rotation[1][0] * pose[0] + rotation[1][1] * pose[1] + rotation[1][2] * pose[2],
    rotation[2][0] * pose[0] + rotation[2][1] * pose[1] + rotation[2][2] * pose[2],
  ];
}

/** Rotation matrix taking unit(from) onto unit(to) (Rodrigues). */
function rotationTaking(from: Pose, to: Pose): Rotation {
  const norm = (v: Pose): Pose => { const m = Math.hypot(...v); return [v[0] / m, v[1] / m, v[2] / m]; };
  const a = norm(from), b = norm(to);
  const v: Pose = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k = 1 / (1 + c);
  return [
    [1 + k * (-v[2] * v[2] - v[1] * v[1]), -v[2] + k * v[0] * v[1], v[1] + k * v[0] * v[2]],
    [v[2] + k * v[0] * v[1], 1 + k * (-v[2] * v[2] - v[0] * v[0]), -v[0] + k * v[1] * v[2]],
    [-v[1] + k * v[0] * v[2], v[0] + k * v[1] * v[2], 1 + k * (-v[1] * v[1] - v[0] * v[0])],
  ];
}

function rotateTrace(trace: readonly CapturedMotion[], rotation: Rotation): readonly CapturedMotion[] {
  return trace.map((sample) => {
    const pose = rotatePose([sample.axMg, sample.ayMg, sample.azMg], rotation);
    return { ...sample, axMg: Math.round(pose[0]), ayMg: Math.round(pose[1]), azMg: Math.round(pose[2]) };
  });
}

function rotateFixtures(fixtures: CoreMotionFixtures, rotation: Rotation): CoreMotionFixtures {
  const rotateAll = (traces: readonly (readonly CapturedMotion[])[]) => traces.map((trace) => rotateTrace(trace, rotation));
  return {
    stillness: rotateTrace(fixtures.stillness, rotation),
    calibration: {
      stupefy: rotateAll(fixtures.calibration.stupefy),
      protego: rotateAll(fixtures.calibration.protego),
      expelliarmus: rotateAll(fixtures.calibration.expelliarmus),
    },
    heldOut: {
      stupefy: rotateTrace(fixtures.heldOut.stupefy, rotation),
      protego: rotateTrace(fixtures.heldOut.protego, rotation),
      expelliarmus: rotateTrace(fixtures.heldOut.expelliarmus, rotation),
    },
  };
}

function runCoreFixtures(fixtures: CoreMotionFixtures): GestureEvidence[] {
  const evidence: GestureEvidence[] = [];
  const recognizer = new MotionRecognizer((item) => evidence.push(item));
  const feed = (samples: readonly CapturedMotion[]) => samples.forEach((sample) => recognizer.push(sample, 3));
  recognizer.beginCalibration();
  feed(fixtures.stillness);
  recognizer.beginGestureCalibration("stupefy");
  fixtures.calibration.stupefy.forEach(feed);
  recognizer.beginGestureCalibration("protego");
  fixtures.calibration.protego.forEach(feed);
  expect(recognizer.getState()).toMatchObject({ phase: "ready", examplesBySpell: { stupefy: 3, protego: 3, expelliarmus: 0 } });
  feed(fixtures.heldOut.stupefy);
  feed(fixtures.heldOut.protego);
  return evidence;
}

/** Real iPhone records (mg, 50 Hz) captured while Sai tried three jabs that v2 rejected. */
function realTrace(rows: number[][], firstSeq: number, breakFirst: boolean): CapturedMotion[] {
  return rows.map(([captureMs, x, y, z, flags], index) => ({
    version: 1 as const,
    flags,
    seq: (firstSeq + index) & 0xffff,
    captureMs,
    bootId: 5,
    axMg: x,
    ayMg: y,
    azMg: z,
    browserMs: captureMs,
    ageUpperMs: 40,
    breaksGesture: breakFirst && index === 0,
  }));
}

describe("accelerometer-only motion recognition (v3 segmenter)", () => {
  it("learns a grip in 1.5 seconds of stillness and accepts three jabs that drift between attempts", () => {
    const h = new MotionHarness();
    h.recognizer.beginCalibration();
    h.feed(h.builder.stillness(800));
    expect(h.recognizer.getState()).toMatchObject({ phase: "stillness", progress: "hold-still" });
    h.feed(h.builder.stillness(900));
    expect(h.recognizer.getState().phase).toBe("gesture-calibration");
    h.recognizer.beginGestureCalibration("stupefy");
    h.feed(h.builder.jab(820, 0, undefined, 1, 9));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { stupefy: 1 }, lastIssue: "1 of 3. Again." });
    h.feed(h.builder.jab(900, 0, undefined, 1, 12));
    h.feed(h.builder.jab(980, 0, undefined, 1, 8));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { stupefy: 3 }, calibratedSpells: ["stupefy"], calibratingSpell: undefined });
    expect(h.builder.currentPose()).not.toEqual([0, 0, 1000]);
  });

  it("recognizes held-out jabs and guards without any return to the calibrated pose", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.jab(760));
    expect(h.spells()).toEqual(["stupefy"]);
    h.feed(h.builder.drift([180, 120, 960]));
    h.feed(h.builder.stillness(400));
    h.feed(h.builder.jab(850));
    expect(h.spells()).toEqual(["stupefy", "stupefy"]);
    h.feed(h.builder.guard(31));
    expect(h.spells()).toEqual(["stupefy", "stupefy", "protego"]);
    expect(h.evidence.every((item) => item.quality > 0 && item.quality <= 1)).toBe(true);
  });

  it("emits a jab within a quarter second of the stroke, before the hand settles", () => {
    const h = new MotionHarness();
    h.ready();
    const trace = h.builder.jab(900);
    const peak = trace.reduce((best, sample) => (sample.axMg > best.axMg ? sample : best), trace[0]);
    h.feed(trace);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].endMs - peak.browserMs).toBeLessThanOrEqual(260);
    expect(h.evidence[0].startMs).toBeLessThan(peak.browserMs);
  });

  it("treats a rapid succession of strokes as one spell", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.rapidJabs(900, 3));
    expect(h.spells()).toEqual(["stupefy"]);
    h.feed(h.builder.stillness(300));
    h.feed(h.builder.rapidJabs(900, 2));
    expect(h.spells()).toEqual(["stupefy", "stupefy"]);
  });

  it("does not cast from slow drift, tremor, holding a guard, or lowering it", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.drift([0, 500, 866], 1_600));
    h.feed(h.builder.drift([0, -300, 950], 2_000));
    h.feed(h.builder.stillness(600));
    expect(h.evidence).toHaveLength(0);
    h.feed(h.builder.guard(34, 1_200));
    expect(h.spells()).toEqual(["protego"]);
    h.feed(h.builder.stillness(1_500));
    h.feed(h.builder.lower(34));
    h.feed(h.builder.stillness(300));
    expect(h.spells()).toEqual(["protego"]);
  });

  it("classifies by the strongest stroke and refuses wrong-axis impulses", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.jab(900, 1));
    expect(h.evidence).toHaveLength(0);
    expect(h.recognizer.getState().reason).toBe("no-match");
    h.feed(h.builder.jab(900, 0, [-1, 0, 0]));
    expect(h.evidence).toHaveLength(0);
    h.feed(h.builder.jab(900, 0, [0.9, 0.35, 0]));
    expect(h.spells()).toEqual(["stupefy"]);
  });

  it("recognizes a calibrated forward jab when braking is stronger than launch", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.jab(900, 0, undefined, 2.5));
    expect(h.spells()).toEqual(["stupefy"]);
  });

  it("rejects a true reverse jab after forward calibration", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.jab(900, 0, [-1, 0, 0], 0.8));
    expect(h.evidence).toHaveLength(0);
    expect(h.recognizer.getState().reason).toBe("no-match");
  });

  it("needs a distinct sweep direction for Expelliarmus and reports ambiguity", () => {
    const h = new MotionHarness();
    h.ready();
    h.recognizer.beginGestureCalibration("expelliarmus");
    h.feed(h.builder.jab(900, 0, [0.95, 0.3, 0]));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { expelliarmus: 0 }, reason: "inconsistent-direction" });
    // A sweep only 60 degrees from the jab is accepted, but leaves room for ambiguous strokes.
    const sweep: Pose = [0.5, 0.866, 0];
    for (const amplitude of [820, 900, 980]) h.feed(h.builder.jab(amplitude, 0, sweep));
    h.recognizer.setEnabledSpells(["stupefy", "protego", "expelliarmus"]);
    expect(h.recognizer.getState().phase).toBe("ready");
    h.feed(h.builder.jab(850, 1));
    expect(h.spells()).toEqual(["expelliarmus"]);
    h.feed(h.builder.jab(850, 0, [0.866, 0.5, 0]));
    expect(h.spells()).toEqual(["expelliarmus"]);
    expect(h.recognizer.getState().reason).toBe("ambiguous");
  });

  it("coaches calibration with actionable reasons", () => {
    const h = new MotionHarness();
    h.still();
    h.recognizer.beginGestureCalibration("stupefy");
    h.feed(h.builder.jab(450));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { stupefy: 0 }, reason: "too-small" });
    h.feed(h.builder.jab(900));
    h.feed(h.builder.jab(900, 1));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { stupefy: 1 }, reason: "inconsistent-direction" });
    h.feed(h.builder.jab(900));
    h.feed(h.builder.jab(900));
    expect(h.recognizer.getState().calibratedSpells).toEqual(["stupefy"]);
    h.recognizer.beginGestureCalibration("protego");
    h.feed(h.builder.guard(19));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { protego: 0 }, reason: "guard-tilt" });
    h.feed(h.builder.lower(19));
    h.feed(h.builder.jab(900));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { protego: 0 }, reason: "unclear-direction" });
    h.feed(h.builder.guard(35));
    expect(h.recognizer.getState().examplesBySpell.protego).toBe(1);
    h.feed(h.builder.lower(35));
    expect(h.recognizer.getState().examplesBySpell.protego).toBe(1);
  });

  it("breaks a movement on gaps or saturation without losing calibration", () => {
    const h = new MotionHarness();
    h.ready();
    h.feed(h.builder.brokenJab("gap"));
    h.feed(h.builder.brokenJab("saturated"));
    expect(h.evidence).toHaveLength(0);
    expect(h.recognizer.getState().phase).toBe("ready");
    h.feed(h.builder.jab(900));
    expect(h.spells()).toEqual(["stupefy"]);
  });

  it("invalidates calibration when the input generation changes and resumes after one still second", () => {
    const h = new MotionHarness();
    h.ready();
    h.generation = 8;
    h.feed(h.builder.jab(900));
    expect(h.recognizer.getState().phase).toBe("uncalibrated");
    expect(h.evidence).toHaveLength(0);
    const again = new MotionHarness();
    again.ready();
    expect(again.recognizer.resumeCalibration(9)).toBe(true);
    again.generation = 9;
    expect(again.recognizer.getState().phase).toBe("resuming");
    again.feed(again.builder.drift([200, 100, 950], 600));
    again.feed(again.builder.stillness(1_100));
    expect(again.recognizer.getState().phase).toBe("ready");
    again.feed(again.builder.jab(900));
    expect(again.spells()).toEqual(["stupefy"]);
  });

  it("clears an in-flight movement without discarding calibration", () => {
    const h = new MotionHarness();
    h.ready();
    const trace = h.builder.jab(900);
    h.feed(trace.slice(0, 20));
    h.recognizer.clearPending("round ended");
    h.feed(trace.slice(20));
    expect(h.evidence).toHaveLength(0);
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", lastIssue: "round ended" });
  });

  it("never lets a lowering seed the guard template, even when the first raise was rejected", () => {
    const h = new MotionHarness();
    h.still();
    h.calibrate("stupefy");
    h.recognizer.beginGestureCalibration("protego");
    // Raise too little: rejected with coaching. Lowering it must not become example 1.
    h.feed(h.builder.guard(19));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { protego: 0 }, reason: "guard-tilt" });
    h.feed(h.builder.lower(19));
    expect(h.recognizer.getState().examplesBySpell.protego).toBe(0);
    for (const degrees of [34, 36, 38]) {
      h.feed(h.builder.guard(degrees));
      h.feed(h.builder.lower(degrees));
    }
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", examplesBySpell: { protego: 3 } });
    h.feed(h.builder.guard(35));
    expect(h.spells()).toEqual(["protego"]);
  });

  it("restarts guard examples when the wand was already raised at the start", () => {
    const h = new MotionHarness();
    h.still();
    h.calibrate("stupefy");
    // The player is already holding the wand up (and still) when protego calibration begins, so the
    // first movements the recognizer sees are lowerings: they must not become the template.
    h.builder.guard(35, 1_000);
    h.recognizer.beginGestureCalibration("protego");
    h.feed(h.builder.stillness(500));
    for (let index = 0; index < 2; index++) {
      h.feed(h.builder.lower(35));
      h.feed(h.builder.guard(35));
    }
    expect(h.recognizer.getState().examplesBySpell.protego).toBe(2);
    h.feed(h.builder.lower(35));
    // Three "raises" that all ended nearer the resting grip were lowerings: start over with a hint.
    expect(h.recognizer.getState()).toMatchObject({ phase: "gesture-calibration", reason: "return-neutral" });
    expect(h.recognizer.getState().examplesBySpell.protego).toBe(0);
    for (const degrees of [34, 36, 38]) {
      h.feed(h.builder.guard(degrees));
      h.feed(h.builder.lower(degrees));
    }
    expect(h.recognizer.getState().phase).toBe("ready");
  });

  it("recognizes a brisk guard raise whose arm push exceeds the fast jab threshold", () => {
    const h = new MotionHarness();
    h.ready();
    for (const [degrees, push] of [[35, 500], [45, 400], [30, 700]] as const) {
      h.feed(h.builder.guard(degrees, 320, 320, push));
      h.feed(h.builder.lower(degrees));
    }
    expect(h.spells()).toEqual(["protego", "protego", "protego"]);
  });

  it("never casts a jab from lowering a guard, even when the tilt is anti-parallel to the jab", () => {
    const h = new MotionHarness();
    h.still();
    h.recognizer.beginGestureCalibration("stupefy");
    // A jab direction opposite to the guard's tilt delta (the natural geometry for a horizontal wand).
    const antiParallel: Pose = [0, -0.82, 0.57];
    for (const amplitude of [820, 900, 980]) h.feed(h.builder.jab(amplitude, 0, antiParallel));
    expect(h.recognizer.getState().examplesBySpell.stupefy).toBe(3);
    h.calibrate("protego");
    expect(h.recognizer.getState().phase).toBe("ready");
    // Lowering right after the third calibration guard, then normal play.
    h.feed(h.builder.guard(39));
    h.feed(h.builder.lower(39));
    h.feed(h.builder.guard(33));
    h.feed(h.builder.lower(33));
    expect(h.spells()).toEqual(["protego", "protego"]);
    h.feed(h.builder.jab(900, 0, antiParallel));
    expect(h.spells()).toEqual(["protego", "protego", "stupefy"]);
  });

  it("prefers the guard when a raise's stroke lies near the jab direction", () => {
    const h = new MotionHarness();
    h.still();
    h.recognizer.beginGestureCalibration("stupefy");
    const nearGuard: Pose = [0, 0.94, 0.34];
    for (const amplitude of [820, 900, 980]) h.feed(h.builder.jab(amplitude, 0, nearGuard));
    expect(h.recognizer.getState().examplesBySpell.stupefy).toBe(3);
    h.recognizer.beginGestureCalibration("protego");
    for (const degrees of [33, 36, 39]) {
      h.feed(h.builder.guard(degrees));
      h.feed(h.builder.lower(degrees));
    }
    if (h.recognizer.getState().phase !== "ready") return;  // the raise itself read as a jab: coached, acceptable
    h.feed(h.builder.guard(36));
    expect(h.spells()).toEqual(["protego"]);
  });

  it("recognizes the core fixtures in any grip orientation", () => {
    const base = createCoreMotionFixtures();
    const rotations: Rotation[] = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0.7071, 0, 0.7071], [0, 1, 0], [-0.7071, 0, 0.7071]],
    ];
    for (const rotation of rotations) {
      const evidence = runCoreFixtures(rotateFixtures(base, rotation));
      expect(evidence.map((item) => item.spell)).toEqual(["stupefy", "protego"]);
    }
  });

  it("calibrates and recognizes Sai's recorded iPhone jabs, which the previous recognizer rejected", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const feed = (samples: readonly CapturedMotion[]) => samples.forEach((sample) => recognizer.push(sample, 1));
    recognizer.beginCalibration();
    feed(realTrace(phoneJabs.quiet, 0, true));
    expect(recognizer.getState().phase).toBe("gesture-calibration");
    recognizer.beginGestureCalibration("stupefy");
    const jabs = realTrace(phoneJabs.jabs, 1000, true);
    const onsets = phoneJabs.expectedJabOnsetsMs;
    const split = (from: number, to: number) => jabs.filter((sample) => sample.captureMs >= from && sample.captureMs < to);
    // The first three recorded jabs are the calibration attempt.
    feed(split(0, onsets[3] - 400));
    expect(recognizer.getState()).toMatchObject({ examplesBySpell: { stupefy: 3 }, calibratedSpells: ["stupefy"] });
    // A synthetic guard completes calibration so the recognizer can enter play; the remaining
    // recorded jabs are then held-out real data.
    const guardBuilder = new RawMotionTraceBuilder();
    // Synthetic guards are generated around a flat pose; rotate them into the recorded grip.
    const neutral = recognizer.getDiagnostics().neutralMg!;
    const toGrip = rotationTaking([0, 0, 1], [neutral[0], neutral[1], neutral[2]]);
    const rebase = (trace: readonly CapturedMotion[], startMs: number, firstSeq: number): CapturedMotion[] =>
      rotateTrace(trace, toGrip).map((sample, index) => ({ ...sample, captureMs: startMs + index * 20, browserMs: startMs + index * 20, seq: (firstSeq + index) & 0xffff, breaksGesture: index === 0 }));
    recognizer.beginGestureCalibration("protego");
    let cursor = 2_000_000;
    for (const degrees of [33, 36, 39]) {
      const raise = rebase(guardBuilder.guard(degrees), cursor, 2000);
      feed(raise);
      cursor = raise[raise.length - 1].browserMs + 20;
      const lower = rebase(guardBuilder.lower(degrees), cursor, 3000);
      feed(lower);
      cursor = lower[lower.length - 1].browserMs + 20;
    }
    expect(recognizer.getState().phase).toBe("ready");
    const heldOut = split(onsets[3] - 400, Infinity).map((sample, index) => ({ ...sample, breaksGesture: index === 0 }));
    feed(heldOut);
    expect(evidence.map((item) => item.spell)).toEqual(["stupefy", "stupefy"]);
    for (const [index, item] of evidence.entries()) {
      const onset = onsets[3 + index];
      expect(Math.abs(item.startMs - onset)).toBeLessThan(200);
      expect(item.endMs - item.startMs).toBeLessThan(900);
    }
  });

  it("quick play is ready at once: any firm jab is Stupefy, a held raise is Protego, lowering is not", () => {
    const harness = new MotionHarness();
    harness.recognizer.useDefaultProfile(harness.generation);
    const state = harness.recognizer.getState();
    expect(state.phase).toBe("ready");
    expect(state.calibratedSpells).toEqual(["stupefy", "protego"]);
    harness.feed(harness.builder.stillness(600));
    harness.feed(harness.builder.jab(900, 0));
    harness.feed(harness.builder.jab(950, 1));
    expect(harness.evidence.map((item) => item.spell)).toEqual(["stupefy", "stupefy"]);
    harness.feed(harness.builder.guard(33));
    expect(harness.evidence.map((item) => item.spell)).toEqual(["stupefy", "stupefy", "protego"]);
    harness.feed(harness.builder.lower(33));
    expect(harness.evidence).toHaveLength(3);
    harness.feed(harness.builder.guard(36));
    expect(harness.evidence.map((item) => item.spell).at(-1)).toBe("protego");
    expect(harness.evidence.every((item) => item.generation === harness.generation)).toBe(true);
    // A weak wobble stays silent even without a personal profile.
    harness.feed(harness.builder.jab(300, 0));
    expect(harness.evidence).toHaveLength(4);
    // Personal calibration replaces the generic profile the usual way.
    harness.still();
    expect(harness.recognizer.getState().calibratedSpells).toEqual([]);
    expect(() => harness.recognizer.useDefaultProfile(-1)).toThrow();
  });

  it("stays silent on the recorded resting hold", () => {
    const h = new MotionHarness();
    h.ready();
    const quiet = realTrace(phoneJabs.quiet, 0, true);
    const generation = h.generation;
    quiet.forEach((sample) => h.recognizer.push({ ...sample, bootId: 11 }, generation));
    expect(h.evidence).toHaveLength(0);
    expect(h.recognizer.getState().phase).toBe("ready");
  });

  it("quick play waits for brisk raises instead of consuming them as direction-free jabs", () => {
    for (const degrees of [20, 35, 45, 60]) {
      for (const pushMg of [500, 900, 1_400]) {
        const h = new MotionHarness();
        h.recognizer.useDefaultProfile(h.generation);
        h.feed(h.builder.stillness(600));
        h.feed(h.builder.guard(degrees, 320, 320, pushMg));
        expect(h.spells(), `${degrees} degrees, ${pushMg} mg arm push`).toEqual(["protego"]);
        expect(h.recognizer.getDiagnostics().candidate?.stopEvidence).toBe("release");
        h.feed(h.builder.stillness(600));
        h.feed(h.builder.lower(degrees));
        expect(h.spells(), "holding and lowering must not cast again").toEqual(["protego"]);
        h.feed(h.builder.guard(degrees, 320, 320, pushMg));
        expect(h.spells()).toEqual(["protego", "protego"]);
      }
    }
  });

  it("keeps quick-play brisk raises independent of the badge or phone grip axes", () => {
    for (const rotation of [
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0.7071, 0, 0.7071], [0, 1, 0], [-0.7071, 0, 0.7071]],
    ] as Rotation[]) {
      const h = new MotionHarness();
      h.recognizer.useDefaultProfile(h.generation);
      h.feed(rotateTrace(h.builder.stillness(600), rotation));
      h.feed(rotateTrace(h.builder.guard(35, 320, 320, 900), rotation));
      h.feed(rotateTrace(h.builder.lower(35), rotation));
      expect(h.spells()).toEqual(["protego"]);
    }
  });

  it("accepts smaller deliberate quick-play moves without accepting a weak fidget", () => {
    const h = new MotionHarness();
    h.recognizer.useDefaultProfile(h.generation);
    h.feed(h.builder.stillness(600));
    h.feed(h.builder.jab(450));
    expect(h.spells()).toEqual(["stupefy"]);
    h.feed(h.builder.guard(18, 320, 320, 500));
    expect(h.spells()).toEqual(["stupefy", "protego"]);
    h.feed(h.builder.lower(18));
    h.feed(h.builder.jab(300));
    h.feed(h.builder.drift([0, 500, 866], 1_600));
    expect(h.spells()).toEqual(["stupefy", "protego"]);
  });

  it("defers the unlabeled recorded phone turn until its apparent raised pose has settled", () => {
    const h = new MotionHarness();
    h.recognizer.useDefaultProfile(h.generation);
    const samples: CapturedMotion[] = phoneTurn.samples.map((row, seq) => {
      const [browserMs, captureMs, axMg, ayMg, azMg, ageUpperMs, flags] = row as number[];
      return { version: 1, bootId: 5, seq, browserMs, captureMs, axMg, ayMg, azMg, ageUpperMs, flags, breaksGesture: row[7] === true };
    });
    h.feed(samples.filter((sample) => sample.browserMs <= phoneTurn.oldEarlyEndMs));
    // The previous generic fast path emitted Stupefy here despite a 144-degree apparent tilt.
    // This recording has no intended-gesture label: assert decision timing, not a claimed raise.
    expect(h.evidence).toHaveLength(0);
    h.feed(samples.filter((sample) => sample.browserMs > phoneTurn.oldEarlyEndMs));
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].endMs).toBeGreaterThan(phoneTurn.oldEarlyEndMs);
  });

  it("still refuses stale or broken quick-play raises", () => {
    for (const fault of ["stale", "gap", "saturated"] as const) {
      const h = new MotionHarness();
      h.recognizer.useDefaultProfile(h.generation);
      h.feed(h.builder.stillness(600));
      h.feed(h.builder.guard(35, 320, 320, 900).map((sample) => ({
        ...sample,
        ageUpperMs: fault === "stale" ? 201 : sample.ageUpperMs,
        breaksGesture: fault === "gap" || sample.breaksGesture,
        flags: fault === "saturated" ? MotionFlag.Valid | MotionFlag.Saturated : sample.flags,
      })));
      expect(h.evidence, fault).toHaveLength(0);
    }
  });

  it.each(badgeGestures.cases.filter((recording) => recording.expected !== "none-during-move"))(
    "recognizes labelled real badge regression $name with original sample timing and validity",
    (recording) => {
      const h = new MotionHarness();
      h.recognizer.useDefaultProfile(h.generation);
      h.feed(recording.samples.map((row) => {
        const [browserMs, captureMs, seq, axMg, ayMg, azMg, ageUpperMs, flags] = row as number[];
        return { version: 1, bootId: 5, seq, browserMs, captureMs, axMg, ayMg, azMg, ageUpperMs, flags, breaksGesture: row[8] === true };
      }));
      expect(h.spells()).toEqual([recording.expected]);
      expect(h.evidence[0].quality).toBeGreaterThan(0);
    },
  );

  it("does not classify movement during the five recorded badge still windows", () => {
    const recording = badgeGestures.cases.find((recording) => recording.expected === "none-during-move")!;
    const decode = (rows: (number | boolean)[][]): CapturedMotion[] => rows.map((row) => {
      const [browserMs, captureMs, seq, axMg, ayMg, azMg, ageUpperMs, flags] = row as number[];
      return { version: 1, bootId: 5, seq, browserMs, captureMs, axMg, ayMg, azMg, ageUpperMs, flags, breaksGesture: row[8] === true };
    });
    // The recording contains movement outside Move. It is not a claim that all fifty
    // seconds were motionless, nor that accelerometer-only recognition can infer player intent.
    // Retain a preceding accepted raise too: its lowering direction exposed the short reorientation
    // in Still trial5 as a false guard, whereas a fresh profile happened to suppress it.
    for (const keepPriorRaise of [false, true]) {
      const h = new MotionHarness();
      h.recognizer.useDefaultProfile(h.generation);
      if (keepPriorRaise)
        h.feed(decode(badgeGestures.cases.find((candidate) => candidate.name === "protego-preparation-validation-1")!.samples));
      h.feed(decode(recording.samples));
      const stillEvents = h.evidence.filter((event) => event.startMs >= Number(recording.samples[0][0]));
      // Preserve the full-session negative evidence: the two larger rest/settle movements
      // remain unresolved, but neither brief 41ms candidate should survive outside Move either.
      expect(stillEvents).toHaveLength(2);
      expect(stillEvents.every((event) => event.endMs - event.startMs >= 60)).toBe(true);
      for (const [start, end] of recording.moveWindows!)
        expect(h.evidence.filter((event) => event.endMs > start && event.startMs < end)).toEqual([]);
    }
  });

  it("ignores a tiny quick-play wrist reorientation whose detected movement spans less than 60 ms", () => {
    const h = new MotionHarness();
    h.recognizer.useDefaultProfile(h.generation);
    h.feed(h.builder.stillness(600));
    h.feed(h.builder.guard(18, 320, 320, 220));
    expect(h.evidence).toHaveLength(0);
    expect(h.recognizer.getDiagnostics().candidate!.durationMs).toBeLessThan(60);
  });

  it("recognizes a lift without rotating and ignores its straight lowering in rotated grips", () => {
    for (const rotation of [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
      [[0.7071, 0, 0.7071], [0, 1, 0], [-0.7071, 0, 0.7071]],
    ] as Rotation[]) {
      const h = new MotionHarness();
      h.recognizer.useDefaultProfile(h.generation);
      h.feed(rotateTrace(h.builder.stillness(600), rotation));
      h.feed(rotateTrace(h.builder.jab(1_200, 0, [0, 0, 1], 1, 0), rotation));
      expect(h.spells()).toEqual(["protego"]);
      h.feed(rotateTrace(h.builder.jab(1_200, 0, [0, 0, -1], 1, 0), rotation));
      expect(h.spells()).toEqual(["protego"]);
    }
  });

  it("retains a sub-onset lift launch before its stronger brake, without confusing the reverse lowering", () => {
    // A 430 mg launch is strong enough for lift features (400 mg), but below the
    // 450 mg onset. The opposite brake triggers onset; its preceding 20 ms alone
    // cannot describe the launch. Acquisition times remain at the actual 50 Hz.
    for (const rotation of [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    ] as Rotation[]) {
      for (const direction of [1, -1]) {
        const h = new MotionHarness();
        h.recognizer.useDefaultProfile(h.generation);
        const trace: CapturedMotion[] = Array.from({ length: 71 }, (_, seq) => {
          const time = seq * 20;
          const acceleration = time >= 600 && time <= 720 ? 430 : time >= 740 && time <= 840 ? -700 : 0;
          return { version: 1, bootId: 1, seq, captureMs: time, browserMs: time, ageUpperMs: 40,
            flags: MotionFlag.Valid, breaksGesture: false, axMg: 0, ayMg: 0, azMg: 1_000 + direction * acceleration };
        });
        h.feed(rotateTrace(trace, rotation));
        expect(h.spells(), direction === 1 ? "lift" : "lowering").toEqual(direction === 1 ? ["protego"] : []);
        if (direction === 1) expect(h.evidence[0].startMs).toBe(720);
        for (const fault of ["break", "stale"] as const) {
          const interrupted = new MotionHarness();
          interrupted.recognizer.useDefaultProfile(interrupted.generation);
          interrupted.feed(rotateTrace(trace.map((sample) => sample.captureMs === 700
            ? { ...sample, breaksGesture: fault === "break", ageUpperMs: fault === "stale" ? 201 : sample.ageUpperMs }
            : sample), rotation));
          expect(interrupted.evidence, `pre-onset context must not survive ${fault}`).toEqual([]);
        }
      }
    }
  });

  it("preserves a deliberate 60 ms jab across measured browser-clock resync steps", () => {
    const run = (offsetStep: number) => {
      const h = new MotionHarness();
      h.recognizer.useDefaultProfile(h.generation);
      const trace: CapturedMotion[] = Array.from({ length: 56 }, (_, seq) => {
        const captureMs = seq * 20;
        const axMg = captureMs === 600 ? 400 : captureMs === 620 ? 700 : captureMs === 640 ? 500 : 0;
        return { version: 1, bootId: 1, seq, captureMs,
          browserMs: captureMs + (captureMs >= 640 ? offsetStep : 0), ageUpperMs: 50,
          flags: MotionFlag.Valid, breaksGesture: false, axMg, ayMg: 0, azMg: 1_000 };
      });
      h.feed(trace);
      return { spells: h.spells(), evidence: h.evidence, candidate: h.recognizer.getDiagnostics().candidate };
    };
    const baseline = run(0);
    expect(baseline.spells).toEqual(["stupefy"]);
    expect(baseline.candidate?.durationMs).toBe(60);
    // First two steps were measured; -30 also crosses mapped-time monotonicity.
    // Raw acquisition remains ordered, fresh and 20 ms apart in every case.
    for (const offset of [-10.25, 23.75, -30]) expect(run(offset)).toEqual(baseline);
  });

  it("handles capture-clock wrap and adopts the new browser anchor for the next movement", () => {
    const h = new MotionHarness();
    h.recognizer.useDefaultProfile(h.generation);
    const offset = 23.75;
    const trace: CapturedMotion[] = Array.from({ length: 81 }, (_, seq) => {
      const time = seq * 20;
      const relative = time >= 1_200 ? time - 600 : time;
      const axMg = relative === 600 ? 400 : relative === 620 ? 700 : relative === 640 ? 500 : 0;
      return { version: 1, bootId: 1, seq, captureMs: (time + 2 ** 32 - 620) >>> 0,
        browserMs: time + (time >= 640 ? offset : 0), ageUpperMs: 50,
        flags: MotionFlag.Valid, breaksGesture: false, axMg, ayMg: 0, azMg: 1_000 };
    });
    h.feed(trace);
    expect(h.evidence.map(({ spell, startMs, endMs }) => ({ spell, startMs, endMs }))).toEqual([
      { spell: "stupefy", startMs: 600, endMs: 660 },
      { spell: "stupefy", startMs: 1_200 + offset, endMs: 1_260 + offset },
    ]);
  });

  it("re-anchors rest after an abrupt mapped-clock discontinuity between movements", () => {
    const h = new MotionHarness();
    h.recognizer.useDefaultProfile(h.generation);
    const point = (time: number, axMg = 0): CapturedMotion => ({
      version: 1, bootId: 1, seq: time / 20, captureMs: time,
      browserMs: time - (time >= 400 ? 30 : 0), ageUpperMs: 80,
      flags: MotionFlag.Valid, breaksGesture: false, axMg, ayMg: 0, azMg: 1_000,
    });
    for (let time = 0; time < 400; time += 20) h.feed([point(time)]);
    expect(h.recognizer.getState().progressMs).toBe(250);
    h.feed([point(400)]);
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", progress: "armed", progressMs: 0 });
    // The legacy rest baseline is relearned, without resetting the selected profile.
    for (let time = 420; time <= 1_400; time += 20)
      h.feed([point(time, time === 1_000 ? 400 : time === 1_020 ? 700 : time === 1_040 ? 500 : 0)]);
    expect(h.evidence).toMatchObject([{ spell: "stupefy", startMs: 970, endMs: 1_030 }]);
    expect(h.evidence).toHaveLength(1);
  });

  it.each([600, 590, 780, NaN])("clears an in-flight burst on invalid acquisition time %s even with smooth browser time", invalidTime => {
    const h = new MotionHarness();
    h.recognizer.useDefaultProfile(h.generation);
    const trace: CapturedMotion[] = Array.from({ length: 56 }, (_, seq) => {
      const time = seq * 20;
      const axMg = time === 600 ? 400 : time === 620 ? 700 : time === 640 ? 500 : 0;
      return { version: 1, bootId: 1, seq, captureMs: time === 620 ? invalidTime : time,
        browserMs: time, ageUpperMs: 50, flags: MotionFlag.Valid, breaksGesture: false,
        axMg, ayMg: 0, azMg: 1_000 };
    });
    h.feed(trace);
    expect(h.evidence).toEqual([]);
  });

  it("ignores a downward stroke ending in a held wrist tilt without needing a previous guard", () => {
    for (const rotation of [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
      [[0.7071, 0, 0.7071], [0, 1, 0], [-0.7071, 0, 0.7071]],
    ] as Rotation[]) {
      for (const [amplitude, residualTilt] of [[1_200, 60], [4_000, 45]]) {
        const h = new MotionHarness();
        h.recognizer.useDefaultProfile(h.generation);
        h.feed(rotateTrace(h.builder.stillness(600), rotation));
        h.feed(rotateTrace(h.builder.jab(amplitude, 0, [0, 0, -1], 1, residualTilt), rotation));
        expect(h.evidence).toHaveLength(0);
        expect(h.recognizer.getDiagnostics().candidate!.finalAngleDeg).toBeGreaterThan(18);
      }
    }
  });
});

describe("fixture builder", () => {
  it("produces valid, contiguous 50 Hz records", () => {
    const fixtures = createCoreMotionFixtures();
    const all = [fixtures.stillness, ...fixtures.calibration.stupefy, ...fixtures.calibration.protego, ...fixtures.calibration.expelliarmus, fixtures.heldOut.stupefy, fixtures.heldOut.protego, fixtures.heldOut.expelliarmus].flat();
    for (let index = 1; index < all.length; index++) {
      expect(all[index].browserMs - all[index - 1].browserMs).toBe(20);
      expect(all[index].flags & MotionFlag.Valid).toBe(MotionFlag.Valid);
    }
  });
});
