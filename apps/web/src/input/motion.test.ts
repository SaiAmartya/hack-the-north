import { describe, expect, it } from "vitest";
import type { CapturedMotion } from "../wand/client";
import {
  MotionRecognizer,
  type GestureEvidence,
  type SpellName,
} from "./motion";
import {
  RawMotionTraceBuilder,
  type CoreMotionFixtures,
  createCoreMotionFixtures,
} from "./traceFixtures";

type Pose = readonly [number, number, number];
type Rotation = readonly [Pose, Pose, Pose];

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

function poseTrace(
  harness: MotionHarness,
  poses: readonly Pose[],
): readonly CapturedMotion[] {
  return harness.builder.neutralSample(poses.length * 20).map((sample, index) => ({
    ...sample,
    axMg: Math.round(poses[index][0]),
    ayMg: Math.round(poses[index][1]),
    azMg: Math.round(poses[index][2]),
  }));
}

function rotatePose(pose: Pose, rotation: Rotation): Pose {
  return [
    rotation[0][0] * pose[0] + rotation[0][1] * pose[1] + rotation[0][2] * pose[2],
    rotation[1][0] * pose[0] + rotation[1][1] * pose[1] + rotation[1][2] * pose[2],
    rotation[2][0] * pose[0] + rotation[2][1] * pose[1] + rotation[2][2] * pose[2],
  ];
}

function rotateTrace(trace: readonly CapturedMotion[], rotation: Rotation): readonly CapturedMotion[] {
  return trace.map((sample) => {
    const pose = rotatePose([sample.axMg, sample.ayMg, sample.azMg], rotation);
    return {
      ...sample,
      axMg: Math.round(pose[0]),
      ayMg: Math.round(pose[1]),
      azMg: Math.round(pose[2]),
    };
  });
}

function rotateFixtures(fixtures: CoreMotionFixtures, rotation: Rotation): CoreMotionFixtures {
  return {
    stillness: rotateTrace(fixtures.stillness, rotation),
    calibration: {
      stupefy: fixtures.calibration.stupefy.map((trace) => rotateTrace(trace, rotation)),
      protego: fixtures.calibration.protego.map((trace) => rotateTrace(trace, rotation)),
      expelliarmus: fixtures.calibration.expelliarmus.map((trace) => rotateTrace(trace, rotation)),
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
  const harness = new MotionHarness(recognizer);
  recognizer.beginCalibration();
  harness.feed(fixtures.stillness);
  recognizer.beginGestureCalibration("stupefy");
  fixtures.calibration.stupefy.forEach((trace) => harness.feed(trace));
  recognizer.beginGestureCalibration("protego");
  fixtures.calibration.protego.forEach((trace) => harness.feed(trace));
  expect(recognizer.getState()).toMatchObject({
    phase: "ready",
    examplesBySpell: { stupefy: 3, protego: 3, expelliarmus: 0 },
  });
  harness.feed(fixtures.heldOut.stupefy);
  harness.feed(fixtures.heldOut.protego);
  return evidence;
}

describe("accelerometer-only motion recognition", () => {
  it("learns diagonal directions from the first lobe even when stopping is stronger", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const harness = new MotionHarness(recognizer);
    const direction = (degrees: number): readonly [number, number, number] => [
      Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180), 0,
    ];
    recognizer.beginCalibration();
    harness.feed(harness.builder.stillness());
    recognizer.beginGestureCalibration("stupefy");
    for (const [degrees, peak] of [[40, 600], [45, 800], [50, 1000]])
      harness.feed(harness.builder.jab(peak, 0, direction(degrees), 3));
    expect(recognizer.getState().examplesBySpell.stupefy).toBe(3);
    harness.calibrate("protego");
    harness.feed(harness.builder.jab(600, 0, direction(45), 3));
    harness.feed(harness.builder.jab(800, 0, direction(225), 3));
    harness.feed(harness.builder.jab(800, 0, direction(85), 3));
    expect(evidence.map((item) => item.spell)).toEqual(["stupefy"]);
  });

  it.each([600, 800].flatMap((duration) => [30, 50, 60].map((degrees) => [duration, degrees])))
    ("accepts a %ims guard to %i degrees without premature settling", (duration, degrees) => {
      const evidence: GestureEvidence[] = [];
      const harness = calibrateCore((item) => evidence.push(item));
      const trace = harness.builder.guard(degrees, 260, duration);
      const guardThresholdMs = trace[0].browserMs + 260 + Math.ceil((25 / degrees * duration) / 20) * 20;
      harness.feed(trace);
      expect(evidence.map((item) => item.spell)).toEqual(["protego"]);
      expect(evidence[0].endMs).toBeGreaterThanOrEqual(guardThresholdMs);
    });

  it("calibrates slow varied guards and handles irregular observation timing", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const harness = new MotionHarness(recognizer);
    const irregular = (trace: readonly CapturedMotion[]) => trace.filter((_, index) => index % 5 !== 1 && index % 5 !== 3);
    recognizer.beginCalibration();
    harness.feed(irregular(harness.builder.stillness()));
    harness.calibrate("stupefy");
    recognizer.beginGestureCalibration("protego");
    for (const [degrees, duration] of [[30, 600], [50, 800], [60, 800]])
      harness.feed(irregular(harness.builder.guard(degrees, 300, duration)));
    expect(recognizer.getState().phase).toBe("ready");
    harness.feed(irregular(harness.builder.guard(50, 300, 800)));
    harness.feed(irregular(harness.builder.jab(700)));
    expect(evidence.map((item) => item.spell)).toEqual(["protego", "stupefy"]);
  });

  it("requires consistent trained impulse directions", () => {
    const recognizer = new MotionRecognizer(() => {});
    const harness = new MotionHarness(recognizer);
    recognizer.beginCalibration();
    harness.feed(harness.builder.stillness());
    recognizer.beginGestureCalibration("stupefy");
    harness.feed(harness.builder.jab(800));
    harness.feed(harness.builder.jab(800, 1));
    expect(recognizer.getState()).toMatchObject({ reason: "inconsistent-direction", examplesBySpell: { stupefy: 1 } });
  });

  it("retries a moved stillness window without entering a fault", () => {
    const recognizer = new MotionRecognizer(() => {});
    const harness = new MotionHarness(recognizer);
    recognizer.beginCalibration();
    harness.feed(harness.builder.neutralSample(1000));
    const beforeMovement = recognizer.getState().progressMs;
    harness.feed(harness.builder.jab(900));
    expect(recognizer.getState().phase).toBe("stillness");
    expect(recognizer.getState().progressMs).toBeLessThan(beforeMovement);
    harness.feed(harness.builder.stillness());
    expect(recognizer.getState().phase).toBe("gesture-calibration");
  });

  it("asks for the calibrated grip after a flat baseline is picked up and permits explicit reset", () => {
    const recognizer = new MotionRecognizer(() => {});
    const harness = new MotionHarness(recognizer);
    recognizer.beginCalibration();
    harness.feed(harness.builder.stillness());
    recognizer.beginGestureCalibration("stupefy");
    const upright = (samples: readonly CapturedMotion[]) => samples.map((sample) => ({ ...sample, axMg: 0, ayMg: 1000, azMg: 0 }));
    harness.feed(upright(harness.builder.neutralSample(600)));
    expect(recognizer.getState()).toMatchObject({ reason: "return-neutral", progress: "return-neutral", examplesBySpell: { stupefy: 0 } });
    expect(recognizer.getState().lastIssue).toContain("restart calibration");
    recognizer.beginCalibration();
    harness.feed(upright(harness.builder.stillness()));
    expect(recognizer.getState().phase).toBe("gesture-calibration");
    recognizer.beginGestureCalibration("stupefy");
    harness.feed(upright(harness.builder.neutralSample(260)));
    expect(recognizer.getState().progress).toBe("armed");
  });

  it("recognizes held-out diagonal and guard traces at about 30 observations per second", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const harness = new MotionHarness(recognizer);
    const diagonal: readonly [number, number, number] = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const thirtyHz = (samples: readonly CapturedMotion[]) => {
      let next = samples[0].browserMs;
      return samples.filter((sample) => {
        if (sample.browserMs < next) return false;
        next += 1000 / 30;
        return true;
      });
    };
    recognizer.beginCalibration();
    harness.feed(thirtyHz([...harness.builder.stillness(), ...harness.builder.neutralSample(100)]));
    recognizer.beginGestureCalibration("stupefy");
    for (const amplitude of [600, 700, 800])
      harness.feed(thirtyHz(harness.builder.jab(amplitude, 0, diagonal, 3)));
    recognizer.beginGestureCalibration("protego");
    for (const degrees of [30, 50, 60])
      harness.feed(thirtyHz(harness.builder.guard(degrees, 300, 800)));
    expect(recognizer.getState().phase).toBe("ready");
    harness.feed(thirtyHz(harness.builder.jab(650, 0, diagonal, 3)));
    harness.feed(thirtyHz(harness.builder.guard(50, 300, 600)));
    expect(evidence.map((item) => item.spell)).toEqual(["stupefy", "protego"]);
  });

  it("requires one fresh neutral second before resuming completed calibration", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));
    harness.generation++;
    expect(harness.recognizer.resumeCalibration(harness.generation)).toBe(true);
    harness.feed(harness.builder.neutralSample(980));
    expect(harness.recognizer.getState().phase).toBe("resuming");
    harness.feed(harness.builder.neutralSample(60));
    expect(harness.recognizer.getState()).toMatchObject({ phase: "ready", calibratedSpells: ["stupefy", "protego"] });
    expect(evidence).toEqual([]);
    harness.feed(harness.builder.jab(760));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].generation).toBe(harness.generation);
    expect(new MotionRecognizer(() => {}).resumeCalibration(1)).toBe(false);
  });

  it("will not arm from three sparse observations or stale motion", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));
    harness.recognizer.clearPending();
    harness.feed(harness.builder.neutralSample(220).filter((_, index) => index % 5 === 0));
    expect(harness.recognizer.getState().progress).not.toBe("armed");
    harness.feed(harness.builder.jab(800).map((sample) => ({ ...sample, ageUpperMs: 201 })));
    expect(evidence).toEqual([]);
  });

  it("does not start a candidate from unstable noise or a stable wrong grip", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.recognizer.clearPending();
    harness.feed(harness.builder.neutralSample(260));
    harness.feed(poseTrace(harness, [
      [35, -25, 1_000], [-30, 25, 1_000], [40, -30, 1_000],
      [-35, 30, 1_000], [30, -20, 1_000], [-25, 20, 1_000],
    ]));
    harness.feed(poseTrace(harness, Array.from({ length: 14 }, () => [0, 1_000, 0] as const)));

    expect(evidence).toEqual([]);
    expect(["return-neutral", "too-short"]).toContain(harness.recognizer.getState().reason);
  });

  it("anchors an impulse at sustained onset after a slow pickup", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.recognizer.clearPending();
    harness.feed(harness.builder.neutralSample(260));
    const pickup = poseTrace(harness, [0, 20, 40, 60, 80, 95, 105, 115].map((x) => [x, 0, 1_000] as const));
    harness.feed(pickup);
    const burst = poseTrace(harness, [
      [130, 0, 1_000], [210, 0, 1_000], [430, 0, 1_000], [760, 0, 1_000],
      [900, 0, 1_000], [720, 0, 1_000], [440, 0, 1_000], [300, 0, 1_000],
      [240, 0, 1_000], [190, 0, 1_000], [150, 0, 1_000], [110, 0, 1_000],
      [60, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000],
    ]);
    harness.feed(burst);

    expect(evidence.map((item) => item.spell)).toEqual(["stupefy"]);
    expect(evidence[0].startMs).toBeGreaterThanOrEqual(burst[0].browserMs);
    expect(evidence[0].endMs - evidence[0].startMs).toBeLessThan(500);
  });

  it("ignores a one-sample acceleration spike", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.recognizer.clearPending();
    harness.feed(harness.builder.neutralSample(260));
    harness.feed(poseTrace(harness, [
      [0, 0, 1_000], [900, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
    ]));

    expect(evidence).toEqual([]);
    expect(harness.recognizer.getState().progress).not.toBe("moving");
  });

  it("accepts a 300-450 ms impulse with an imperfect brake and release stop", () => {
    const evidence: GestureEvidence[] = [];
    const harness = calibrateCore((item) => evidence.push(item));

    harness.recognizer.clearPending();
    harness.feed(harness.builder.neutralSample(260));
    harness.feed(poseTrace(harness, [
      [0, 0, 1_000], [140, 0, 1_000], [310, 0, 1_000], [560, 0, 1_000],
      [830, 0, 1_000], [980, 0, 1_000], [820, 0, 1_000], [610, 0, 1_000],
      [450, 0, 1_000], [360, 0, 1_000], [300, 0, 1_000], [260, 0, 1_000],
      [230, 0, 1_000], [205, 0, 1_000], [185, 0, 1_000], [165, 0, 1_000],
      [145, 0, 1_000], [125, 0, 1_000], [105, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000], [0, 0, 1_000],
      [0, 0, 1_000], [0, 0, 1_000],
    ]));

    expect(evidence.map((item) => item.spell)).toEqual(["stupefy"]);
    const diagnostics = harness.recognizer.getDiagnostics();
    expect(diagnostics.version).toBe(2);
    expect(diagnostics.neutralMg).toHaveLength(3);
    expect(Number.isFinite(diagnostics.noiseMg)).toBe(true);
    expect(diagnostics.candidate).toMatchObject({
      reason: "accepted",
      stopEvidence: "release",
    });
    expect(diagnostics.candidate?.durationMs).toBeGreaterThanOrEqual(300);
    expect(diagnostics.candidate?.durationMs).toBeLessThanOrEqual(450);
  });

  it("does not treat a slow quasi-static grip tilt as a jab", () => {
    const evidence: GestureEvidence[] = [];
    const recognizer = new MotionRecognizer((item) => evidence.push(item));
    const harness = new MotionHarness(recognizer);
    const tiltX = (degrees: number): readonly [number, number, number] => {
      const radians = degrees * Math.PI / 180;
      return [Math.sin(radians) * 1_000, 0, Math.cos(radians) * 1_000];
    };

    recognizer.beginCalibration();
    harness.feed(harness.builder.stillness());
    recognizer.beginGestureCalibration("stupefy");
    harness.feed(harness.builder.jab(400));
    harness.feed(harness.builder.jab(420));
    harness.feed(harness.builder.jab(440));
    harness.calibrate("protego");
    expect(recognizer.getState()).toMatchObject({
      phase: "ready",
      examplesBySpell: { stupefy: 3, protego: 3 },
    });
    harness.recognizer.clearPending();
    harness.feed(harness.builder.neutralSample(260));

    const out = Array.from({ length: 20 }, (_, index) => tiltX(((index + 1) / 20) * 15));
    const back = Array.from({ length: 20 }, (_, index) => tiltX(((19 - index) / 20) * 15));
    harness.feed(poseTrace(harness, [...out, ...back, ...Array.from({ length: 12 }, () => [0, 0, 1_000] as const)]));

    expect(evidence).toEqual([]);
  });

  it("calibrates three coached core examples and recognizes held-out raw traces", () => {
    const fixtures = createCoreMotionFixtures();
    const evidence = runCoreFixtures(fixtures);

    expect(evidence.map((item) => item.spell)).toEqual([
      "stupefy",
      "protego",
    ]);
    expect(evidence.every((item) => item.endMs > item.startMs)).toBe(true);
    expect(evidence.every((item) => item.quality >= 0 && item.quality <= 1)).toBe(
      true,
    );
  });

  it.each([
    {
      name: "sideways 90 degrees",
      rotation: [
        [0, 0, 1],
        [0, 1, 0],
        [-1, 0, 0],
      ] satisfies Rotation,
      toleranceMs: 0,
    },
    {
      name: "diagonal yaw-roll grip",
      rotation: [
        [0.5, -0.14644660940672627, 0.8535533905932737],
        [0.5, 0.8535533905932737, -0.14644660940672627],
        [-0.7071067811865475, 0.5, 0.5],
      ] satisfies Rotation,
      toleranceMs: 20,
    },
  ])("calibrates and classifies the same raw traces after a $name rotation", ({ rotation, toleranceMs }) => {
    const fixtures = createCoreMotionFixtures();
    const baseline = runCoreFixtures(fixtures);
    const rotated = runCoreFixtures(rotateFixtures(fixtures, rotation));

    expect(rotated.map((item) => item.spell)).toEqual(baseline.map((item) => item.spell));
    for (let index = 0; index < baseline.length; index++) {
      expect(Math.abs(rotated[index].startMs - baseline[index].startMs)).toBeLessThanOrEqual(toleranceMs);
      expect(Math.abs(rotated[index].endMs - baseline[index].endMs)).toBeLessThanOrEqual(toleranceMs);
    }
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
