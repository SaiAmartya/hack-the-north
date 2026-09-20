import { describe, expect, it } from "vitest";
import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";
import { MotionRecognizer, type GestureEvidence, type SpellName } from "./motion";
import { RawMotionTraceBuilder, STROKE_DIRECTIONS, createCoreMotionFixtures, createSevenSpellFixtures, type CoreMotionFixtures } from "./traceFixtures";
import { SPELL_NAMES } from "../game/spells";
import phoneJabs from "./fixtures/phone-jabs-2026-09-19.json";

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
    } else if (spell === "expecto-patronum") {
      this.feed(this.builder.circle(600, 900));
      this.feed(this.builder.circle(700, 800));
      this.feed(this.builder.circle(650, 1_000));
    } else {
      const direction = STROKE_DIRECTIONS[spell];
      this.feed(this.builder.jab(820, 0, direction, 1, 6));
      this.feed(this.builder.jab(900, 0, direction, 1, -12));
      this.feed(this.builder.jab(980, 0, direction, 1, 6));
    }
    expect(this.recognizer.getState().examplesBySpell[spell]).toBe(3);
  }

  learnAll(): void {
    this.ready();
    for (const spell of SPELL_NAMES) if (!["stupefy", "protego"].includes(spell)) this.calibrate(spell);
    expect(this.recognizer.getState()).toMatchObject({ phase: "ready", enabledSpells: [...SPELL_NAMES], calibratedSpells: [...SPELL_NAMES] });
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

  it("needs a distinct direction for a second stroke spell and reports ambiguity", () => {
    const h = new MotionHarness();
    h.ready();
    h.recognizer.beginGestureCalibration("expelliarmus");
    h.feed(h.builder.jab(900, 0, [0.95, 0.3, 0]));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { expelliarmus: 0 }, reason: "too-similar" });
    expect(h.recognizer.getState().lastIssue).toContain("Stupefy");
    // A stroke only 60 degrees from the jab is accepted, but leaves room for ambiguous strokes.
    const sweep: Pose = [0.5, 0.866, 0];
    for (const amplitude of [820, 900, 980]) h.feed(h.builder.jab(amplitude, 0, sweep));
    // A learned spell is enabled on its own; the explicit call stays harmless.
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", enabledSpells: ["stupefy", "protego", "expelliarmus"] });
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

  it("stays silent on the recorded resting hold", () => {
    const evidence: GestureEvidence[] = [];
    const h = new MotionHarness();
    h.ready();
    const quiet = realTrace(phoneJabs.quiet, 0, true);
    const generation = h.generation;
    quiet.forEach((sample) => h.recognizer.push({ ...sample, bootId: 11 }, generation));
    expect(evidence).toHaveLength(0);
    expect(h.recognizer.getState().phase).toBe("ready");
  });
});

describe("real wand physics", () => {
  it("learns Protego from a raise that pitches the wand, without reading the gravity swing as a jab", () => {
    // A real raise tips the wand about its y axis: gravity swings onto the x axis, which is the
    // jab's axis. Only the arm's small upward push is a stroke; the swing is not.
    const h = new MotionHarness();
    h.still();
    h.calibrate("stupefy");
    h.recognizer.beginGestureCalibration("protego");
    for (const degrees of [33, 36, 39]) {
      h.feed(h.builder.guard(degrees, 320, 320, 220, "y"));
      expect(h.recognizer.getState().reason, h.recognizer.getState().lastIssue).not.toBe("unclear-direction");
      h.feed(h.builder.lower(degrees, 360, "y"));
    }
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", examplesBySpell: { protego: 3 } });
    h.feed(h.builder.guard(31, 320, 320, 220, "y"));
    h.feed(h.builder.lower(31, 360, "y"));
    h.feed(h.builder.jab(900));
    expect(h.spells()).toEqual(["protego", "stupefy"]);
  });

  it("separates a wrist slash from the jab despite the centripetal pull toward the wrist", () => {
    // Swinging the wand from the wrist drags the sensor toward the wrist harder than the slash
    // itself accelerates it sideways; that pull is along the jab axis and must not count.
    const h = new MotionHarness();
    h.ready();
    h.recognizer.beginGestureCalibration("sectumsempra");
    for (const [amplitude, drift] of [[820, 6], [900, -12], [980, 6]] as const) {
      h.feed(h.builder.wristStroke(amplitude, [0, -1, 0], [-1, 0, 0], 1.5, drift));
      expect(h.recognizer.getState().reason, h.recognizer.getState().lastIssue).toBeUndefined();
    }
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", examplesBySpell: { sectumsempra: 3 } });
    h.feed(h.builder.wristStroke(880, [0, -1, 0]));
    h.feed(h.builder.jab(900));
    h.feed(h.builder.wristStroke(900, [0, 1, 0]));  // the unlearned way round: nothing
    expect(h.spells()).toEqual(["sectumsempra", "stupefy"]);
  });

  it("reads a pull back that tips the wand up as Expelliarmus, not as the jab's brake nor as Protego", () => {
    // Pulling toward the shoulder launches backward, brakes forward, and tips the wand so gravity
    // swings forward too: the old strongest-lobe rule read that as a jab. The hold at the end
    // looks like a guard, but the stroke is far too strong to be a raise.
    const h = new MotionHarness();
    h.still();
    h.calibrate("stupefy");
    h.recognizer.beginGestureCalibration("protego");
    for (const degrees of [33, 36, 39]) {
      h.feed(h.builder.guard(degrees, 320, 320, 220, "y"));
      h.feed(h.builder.lower(degrees, 360, "y"));
    }
    expect(h.recognizer.getState().phase).toBe("ready");
    h.recognizer.beginGestureCalibration("expelliarmus");
    for (const amplitude of [820, 900, 980]) {
      h.feed(h.builder.pitchedStroke(amplitude, [-1, 0, 0], 30));
      expect(h.recognizer.getState().reason, h.recognizer.getState().lastIssue).toBeUndefined();
      h.feed(h.builder.lower(30, 360, "y"));
    }
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", examplesBySpell: { expelliarmus: 3 } });
    h.feed(h.builder.pitchedStroke(850, [-1, 0, 0], 30));
    h.feed(h.builder.lower(30, 360, "y"));
    h.feed(h.builder.guard(35, 320, 320, 220, "y"));
    h.feed(h.builder.lower(35, 360, "y"));
    h.feed(h.builder.jab(900));
    expect(h.spells()).toEqual(["expelliarmus", "protego", "stupefy"]);
  });

  it("keeps the launch as the sign of a stroke even when the brake is the sharper part", () => {
    const h = new MotionHarness();
    h.still();
    h.recognizer.beginGestureCalibration("stupefy");
    for (const amplitude of [820, 900, 980]) h.feed(h.builder.jab(amplitude, 0, [1, 0, 0], 2.2));  // brake 2.2x harder
    h.calibrate("protego");
    h.recognizer.beginGestureCalibration("expelliarmus");
    for (const amplitude of [820, 900, 980]) h.feed(h.builder.jab(amplitude, 0, [-1, 0, 0], 2.2));
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", examplesBySpell: { expelliarmus: 3 } });
    h.feed(h.builder.jab(900, 0, [1, 0, 0], 1));    // a gentle-brake jab is still a jab
    h.feed(h.builder.jab(900, 0, [-1, 0, 0], 1));
    expect(h.spells()).toEqual(["stupefy", "expelliarmus"]);
  });
});

describe("seven spells", () => {
  it("learns all seven and recognizes each held-out movement exactly once", () => {
    const fixtures = createSevenSpellFixtures();
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const feed = (samples: readonly CapturedMotion[]) => samples.forEach((sample) => recognizer.push(sample, 3));
    recognizer.beginCalibration();
    feed(fixtures.stillness);
    for (const spell of SPELL_NAMES) {
      recognizer.beginGestureCalibration(spell);
      fixtures.calibration[spell].forEach(feed);
      expect(recognizer.getState().examplesBySpell[spell], `${spell}: ${recognizer.getState().lastIssue}`).toBe(3);
    }
    expect(recognizer.getState()).toMatchObject({ phase: "ready", enabledSpells: [...SPELL_NAMES] });
    for (const spell of SPELL_NAMES) {
      const before = evidence.length;
      feed(fixtures.heldOut[spell]);
      expect(evidence.slice(before).map((item) => item.spell), `${spell}: ${recognizer.getState().lastIssue} ${recognizer.getState().reason ?? ""}`).toEqual([spell]);
    }
    expect(evidence.every((item) => item.quality > 0 && item.quality <= 1)).toBe(true);
  });

  it("keeps every pair of stroke spells apart: the six signed directions never cross-fire", () => {
    const h = new MotionHarness();
    h.learnAll();
    const results: Record<string, SpellName[]> = {};
    const strokes: Record<string, Pose> = { ...STROKE_DIRECTIONS, "+y (unlearned)": [0, 1, 0] };
    for (const [label, direction] of Object.entries(strokes)) {
      const before = h.evidence.length;
      h.feed(h.builder.jab(900, 0, direction));
      results[label] = h.evidence.slice(before).map((item) => item.spell);
    }
    expect(results).toEqual({
      stupefy: ["stupefy"],
      expelliarmus: ["expelliarmus"],
      sectumsempra: ["sectumsempra"],
      incendio: ["incendio"],
      "petrificus-totalus": ["petrificus-totalus"],
      "+y (unlearned)": [],
    });
    // Learned directions are at right angles, so a stroke halfway between two of them is inside
    // neither 40-degree cone: nothing fires and nothing is guessed.
    h.feed(h.builder.jab(900, 0, [0.7071, 0, 0.7071]));
    expect(h.spells().slice(-1)).toEqual(["petrificus-totalus"]);  // the last accepted spell is unchanged
    expect(h.recognizer.getState().reason).toBe("no-match");
  });

  it("never reads a circle as a stroke, and never reads strokes or raises as a circle", () => {
    const h = new MotionHarness();
    h.learnAll();
    for (const [magnitude, period] of [[500, 1_100], [900, 700], [1_200, 600]] as const) {
      const before = h.evidence.length;
      h.feed(h.builder.circle(magnitude, period));
      expect(h.evidence.slice(before).map((item) => item.spell), `${magnitude} mg / ${period} ms: ${h.recognizer.getState().lastIssue}`).toEqual(["expecto-patronum"]);
    }
    // The other way round is a different plane sense: not the learned Patronus.
    const before = h.evidence.length;
    h.feed(h.builder.circle(650, 900, -1));
    expect(h.evidence.slice(before)).toEqual([]);
    // A rapid succession of strokes turns nowhere.
    h.feed(h.builder.rapidJabs(900, 3));
    expect(h.spells().slice(-1)).toEqual(["stupefy"]);
    h.feed(h.builder.guard(35));
    expect(h.spells().slice(-1)).toEqual(["protego"]);
    h.feed(h.builder.lower(35));
    expect(h.spells().slice(-1)).toEqual(["protego"]);
  });

  it("coaches an incomplete or wobbly circle instead of learning it", () => {
    const h = new MotionHarness();
    h.ready();
    h.recognizer.beginGestureCalibration("expecto-patronum");
    h.feed(h.builder.circle(650, 900, 1, "xz", 0.5));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { "expecto-patronum": 0 }, reason: "incomplete-circle" });
    h.feed(h.builder.jab(900));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { "expecto-patronum": 0 }, reason: "incomplete-circle" });
    h.feed(h.builder.circle(650, 900));
    expect(h.recognizer.getState().examplesBySpell["expecto-patronum"]).toBe(1);
    h.feed(h.builder.circle(650, 900, -1));
    expect(h.recognizer.getState()).toMatchObject({ examplesBySpell: { "expecto-patronum": 1 }, reason: "inconsistent-direction" });
    h.feed(h.builder.circle(650, 900));
    h.feed(h.builder.circle(650, 900));
    expect(h.recognizer.getState()).toMatchObject({ phase: "ready", calibratedSpells: ["stupefy", "protego", "expecto-patronum"] });
  });

  it("treats a chop from the grip as a stroke, and a lowered guard as nothing", () => {
    const h = new MotionHarness();
    h.learnAll();
    // Chop down and end 30 degrees lower: still the chop (resolved on the fast path); the slow
    // drop that follows is not a "lowering" of any guard and casts nothing.
    const before = h.evidence.length;
    h.feed(h.builder.jab(950, 0, STROKE_DIRECTIONS["petrificus-totalus"], 1, -30));
    expect(h.evidence.slice(before).map((item) => item.spell)).toEqual(["petrificus-totalus"]);
    h.feed(h.builder.stillness(400));
    // Lowering a raised guard is still silent.
    h.feed(h.builder.guard(36));
    expect(h.spells().slice(-1)).toEqual(["protego"]);
    h.feed(h.builder.lower(36));
    expect(h.spells().slice(-1)).toEqual(["protego"]);
    expect(h.recognizer.getState().reason).toBeUndefined();
  });

  it("reads an upward flick that stays up as the guard, not Incendio", () => {
    const h = new MotionHarness();
    h.learnAll();
    const before = h.evidence.length;
    h.feed(h.builder.guard(35, 320, 320, 700));
    expect(h.evidence.slice(before).map((item) => item.spell)).toEqual(["protego"]);
    h.feed(h.builder.lower(35));
    h.feed(h.builder.jab(840, 0, STROKE_DIRECTIONS.incendio));
    expect(h.spells().slice(-1)).toEqual(["incendio"]);
  });

  it("only offers learned spells and drops an optional spell when its grip is reset", () => {
    const h = new MotionHarness();
    h.ready();
    expect(() => h.recognizer.setEnabledSpells(["stupefy", "protego", "incendio"])).toThrow(/Calibrate Incendio/);
    h.calibrate("incendio");
    expect(h.recognizer.getState().enabledSpells).toEqual(["stupefy", "protego", "incendio"]);
    expect(h.recognizer.resumeCalibration(11)).toBe(true);
    h.recognizer.reset();
    expect(h.recognizer.getState().enabledSpells).toEqual(["stupefy", "protego"]);
  });
});

describe("fixture builder", () => {
  it("produces valid, contiguous 50 Hz records", () => {
    const fixtures = createCoreMotionFixtures();
    const seven = createSevenSpellFixtures();
    const sets = [
      [fixtures.stillness, ...fixtures.calibration.stupefy, ...fixtures.calibration.protego, ...fixtures.calibration.expelliarmus, fixtures.heldOut.stupefy, fixtures.heldOut.protego, fixtures.heldOut.expelliarmus].flat(),
      [seven.stillness, ...Object.values(seven.calibration).flat(), ...Object.values(seven.heldOut)].flat(),
    ];
    for (const all of sets)
      for (let index = 1; index < all.length; index++) {
        expect(all[index].browserMs - all[index - 1].browserMs).toBe(20);
        expect(all[index].flags & MotionFlag.Valid).toBe(MotionFlag.Valid);
      }
  });
});
