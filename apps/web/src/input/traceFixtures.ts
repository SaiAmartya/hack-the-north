import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";
import type { SpellName } from "../game/spells";

type Pose = readonly [number, number, number];

/**
 * Synthetic device-frame stroke directions for the flat starting pose [0, 0, 1000]: the five
 * impulse spells sit on three axes, so every pair is at least 90 degrees apart.
 */
export const STROKE_DIRECTIONS: Readonly<Record<
  "stupefy" | "expelliarmus" | "incendio" | "sectumsempra" | "petrificus-totalus", Pose
>> = {
  stupefy: [1, 0, 0],                // jab forward
  expelliarmus: [-1, 0, 0],          // pull back
  sectumsempra: [0, -1, 0],          // slash sideways
  incendio: [0, 0, 1],               // flick up (against gravity)
  "petrificus-totalus": [0, 0, -1],  // chop down
};
/** Synthetic line of the Protego shake: across the wand, shared with nothing that reverses five times. */
export const SHAKE_AXIS: Pose = [0, 1, 0];

export type SevenSpellFixtures = {
  stillness: readonly CapturedMotion[];
  calibration: Readonly<Record<SpellName, readonly (readonly CapturedMotion[])[]>>;
  heldOut: Readonly<Record<SpellName, readonly CapturedMotion[]>>;
};

export type CoreMotionFixtures = {
  stillness: readonly CapturedMotion[];
  calibration: Readonly<{
    stupefy: readonly (readonly CapturedMotion[])[];
    protego: readonly (readonly CapturedMotion[])[];
    expelliarmus: readonly (readonly CapturedMotion[])[];
  }>;
  heldOut: Readonly<{
    stupefy: readonly CapturedMotion[];
    protego: readonly CapturedMotion[];
    expelliarmus: readonly CapturedMotion[];
  }>;
};

/**
 * Deterministic raw-motion traces shaped like the recorded iPhone jabs: a short wind-up, a sharp
 * thrust, a brake, then a slow return that leaves the hand a few degrees from where it started.
 * Nothing here is physical evidence; real captures replace these fixtures as they arrive.
 */
export class RawMotionTraceBuilder {
  private timeMs = 0;
  private sequence = 0;
  private first = true;
  private pose: Pose = [0, 0, 1_000];

  stillness(durationMs = 1_800): readonly CapturedMotion[] {
    return this.capture(() => {
      for (let elapsed = 0; elapsed <= durationMs; elapsed += 20) {
        const wobble = (this.sequence % 5) - 2;
        this.point([this.pose[0] + wobble, this.pose[1] - wobble, this.pose[2] + (wobble % 2)]);
      }
    });
  }

  /** Move the resting pose (slowly, like a drifting hand) without producing a gesture. */
  drift(to: Pose, durationMs = 1_200): readonly CapturedMotion[] {
    return this.capture(() => {
      const from = this.pose;
      const steps = Math.max(1, Math.round(durationMs / 20));
      for (let step = 1; step <= steps; step++) {
        const k = step / steps;
        this.point([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k]);
      }
      this.pose = to;
    });
  }

  jab(amplitude = 900, axis: 0 | 1 = 0, direction?: Pose, stopScale = 1, returnDriftDeg = 6): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const unit = direction ?? (axis === 0 ? [1, 0, 0] : [0, 1, 0]);
      const shape = [-0.08, -0.15, -0.12, 0.25, 0.7, 1, 0.85, 0.5, 0.15, -0.35, -0.5, -0.4, -0.2, -0.05, 0.05, 0.08, 0.06, 0.03, 0];
      for (const amount of shape) {
        const value = amount * amplitude * (amount < 0 ? stopScale : 1);
        this.point([this.pose[0] + unit[0] * value, this.pose[1] + unit[1] * value, this.pose[2] + unit[2] * value]);
      }
      // slow return that settles a few degrees away from the start, like a real wrist
      const settled = this.rotated(this.pose, returnDriftDeg);
      this.driftPoints(this.pose, settled, 400);
      this.pose = settled;
      this.rest(320);
    });
  }

  /** Three quick jabs without a pause between them: one movement, one spell. */
  rapidJabs(amplitude = 900, count = 3): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const shape = [0.2, 0.7, 1, 0.8, 0.4, 0, -0.35, -0.45, -0.25, 0.05, 0.15];
      for (let repeat = 0; repeat < count; repeat++)
        for (const amount of shape) this.point([this.pose[0] + amount * amplitude, this.pose[1], this.pose[2]]);
      this.driftPoints(this.pose, this.pose, 200);
      this.rest(320);
    });
  }

  /**
   * Raise into a guard and hold. `about: "x"` tips gravity from z toward y (the original synthetic
   * geometry); `about: "y"` tips it toward x, the way a real wand pitches when its tip comes up,
   * which lands the gravity swing on the jab axis. The arm's push is along the tilt for "x" and
   * straight up (+z) for "y".
   */
  guard(degrees = 35, holdMs = 320, movementMs = 320, pushMg = 220, about: "x" | "y" = "x"): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const start = this.pose;
      const raised = about === "x" ? this.rotated(start, degrees) : this.pitched(start, degrees);
      const steps = Math.round(movementMs / 20);
      for (let step = 1; step <= steps; step++) {
        const k = step / steps;
        const eased = 0.5 - Math.cos(k * Math.PI) / 2;
        const push = Math.sin(k * Math.PI) * pushMg;  // the arm accelerates the wand while raising it
        const pushY = about === "x" ? push : 0, pushZ = about === "y" ? push : 0;
        this.point([start[0] + (raised[0] - start[0]) * eased, start[1] + (raised[1] - start[1]) * eased + pushY, start[2] + (raised[2] - start[2]) * eased + pushZ]);
      }
      this.pose = raised;
      this.rest(holdMs, raised);
    });
  }

  /**
   * A stroke driven from the wrist. Besides the launch-and-brake along `direction`, the sensor is
   * pulled toward the wrist the whole time the wand is turning (centripetal, one sign, peaking
   * between launch and brake), often harder than the stroke itself. Real slashes look like this.
   */
  wristStroke(amplitude = 900, direction: Pose = [0, -1, 0], pivot: Pose = [-1, 0, 0], centripetalScale = 1.5, returnDriftDeg = 6): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const shape = [-0.08, -0.15, -0.12, 0.25, 0.7, 1, 0.85, 0.5, 0.15, -0.35, -0.5, -0.4, -0.2, -0.05, 0.05, 0.08, 0.06, 0.03, 0];
      const turning = { from: 3, to: 13 };  // the wand is swinging from launch to the end of the brake
      shape.forEach((amount, index) => {
        const tangential = amount * amplitude;
        const phase = (index - turning.from) / (turning.to - turning.from);
        const centripetal = phase >= 0 && phase <= 1 ? Math.sin(phase * Math.PI) ** 2 * centripetalScale * amplitude : 0;
        this.point([
          this.pose[0] + direction[0] * tangential + pivot[0] * centripetal,
          this.pose[1] + direction[1] * tangential + pivot[1] * centripetal,
          this.pose[2] + direction[2] * tangential + pivot[2] * centripetal,
        ]);
      });
      const settled = this.rotated(this.pose, returnDriftDeg);
      this.driftPoints(this.pose, settled, 400);
      this.pose = settled;
      this.rest(320);
    });
  }

  /**
   * A stroke that ends in a new held pose: a pull back toward the shoulder tips the wand up by
   * `pitchDeg` about y while it travels along `direction`, so gravity swings onto the x axis
   * during the stroke and stays there. The hand holds the new pose afterwards.
   */
  pitchedStroke(amplitude = 900, direction: Pose = [-1, 0, 0], pitchDeg = 30, holdMs = 320): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const start = this.pose;
      const finish = this.pitched(start, pitchDeg);
      const shape = [-0.08, -0.15, -0.12, 0.25, 0.7, 1, 0.85, 0.5, 0.15, -0.35, -0.5, -0.4, -0.2, -0.05, 0.05, 0.08, 0.06, 0.03, 0];
      shape.forEach((amount, index) => {
        const k = Math.min(1, (index + 1) / (shape.length - 4));
        const eased = 0.5 - Math.cos(k * Math.PI) / 2;
        const gravity: Pose = [start[0] + (finish[0] - start[0]) * eased, start[1] + (finish[1] - start[1]) * eased, start[2] + (finish[2] - start[2]) * eased];
        const value = amount * amplitude;
        this.point([gravity[0] + direction[0] * value, gravity[1] + direction[1] * value, gravity[2] + direction[2] * value]);
      });
      this.pose = finish;
      this.rest(holdMs, finish);
    });
  }

  /**
   * One full circle: the linear acceleration vector turns all the way round in a plane at a steady
   * magnitude, like the centripetal pull of a wand tip drawing a ring, with a little wobble. `sense`
   * picks the way round; `plane` picks which device axes the ring lives in.
   */
  circle(magnitudeMg = 650, periodMs = 900, sense: 1 | -1 = 1, plane: "xz" | "xy" | "yz" = "xz", turns = 1): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const steps = Math.max(8, Math.round((periodMs * turns) / 20));
      const ramp = 3;
      for (let step = 0; step <= steps; step++) {
        const theta = (sense * 2 * Math.PI * step * turns) / steps;
        const envelope = Math.min(1, (step + 1) / ramp, (steps - step + 1) / ramp);
        const radius = magnitudeMg * envelope;
        const wobble = ((this.sequence % 7) - 3) * 8;
        const u = Math.cos(theta) * radius, v = Math.sin(theta) * radius;
        const offset: Pose = plane === "xz" ? [u, wobble, v] : plane === "xy" ? [u, v, wobble] : [wobble, u, v];
        this.point([this.pose[0] + offset[0], this.pose[1] + offset[1], this.pose[2] + offset[2]]);
      }
      this.driftPoints(this.pose, this.pose, 100);
      this.rest(320);
    });
  }

  /** Three quick wiggles along `axis`: six alternating lobes of equal impulse, then stop. */
  shake(amplitude = 700, wiggles = 3, axis: Pose = SHAKE_AXIS): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      for (let half = 0; half < wiggles * 2; half++) {
        const sign = half % 2 === 0 ? 1 : -1;
        for (const amount of [0.5, 1, 0.5]) {
          const value = sign * amount * amplitude;
          this.point([this.pose[0] + axis[0] * value, this.pose[1] + axis[1] * value, this.pose[2] + axis[2] * value]);
        }
      }
      this.driftPoints(this.pose, this.pose, 100);
      this.rest(320);
    });
  }

  /** Roll the wand about its own (y) axis by `degrees` and back, smoothly, like a key in a lock. */
  twist(degrees = 80, movementMs = 500): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const start = this.pose;
      const steps = Math.round(movementMs / 20);
      for (let step = 1; step <= steps; step++) {
        const k = step / steps;
        this.point(this.pitched(start, degrees * Math.sin(k * Math.PI)));
      }
      this.rest(320, start);
    });
  }

  /** Lower a raised guard back to a pose; not a spell. */
  lower(degrees = 35, movementMs = 360, about: "x" | "y" = "x"): readonly CapturedMotion[] {
    return this.capture(() => {
      const start = this.pose;
      const lowered = about === "x" ? this.rotated(start, -degrees) : this.pitched(start, -degrees);
      const steps = Math.round(movementMs / 20);
      for (let step = 1; step <= steps; step++) {
        const k = step / steps;
        const eased = 0.5 - Math.cos(k * Math.PI) / 2;
        this.point([start[0] + (lowered[0] - start[0]) * eased, start[1] + (lowered[1] - start[1]) * eased, start[2] + (lowered[2] - start[2]) * eased]);
      }
      this.pose = lowered;
      this.rest(320, lowered);
    });
  }

  brokenJab(kind: "gap" | "saturated"): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      for (const amount of [0.1, 0.35, 0.7])
        this.point([this.pose[0] + amount * 900, this.pose[1], this.pose[2]]);
      if (kind === "gap") {
        this.timeMs += 180;
        this.point([this.pose[0] + 900, this.pose[1], this.pose[2]]);
      } else {
        this.point([this.pose[0] + 900, this.pose[1], this.pose[2]], MotionFlag.Valid | MotionFlag.Saturated);
      }
      for (const amount of [0.7, 0.2, -0.3, 0, 0, 0])
        this.point([this.pose[0] + amount * 900, this.pose[1], this.pose[2]]);
      this.rest(320);
    });
  }

  neutralSample(durationMs = 20): readonly CapturedMotion[] {
    return this.capture(() => this.rest(durationMs));
  }

  currentPose(): Pose {
    return this.pose;
  }

  private capture(build: () => void): readonly CapturedMotion[] {
    const samples: CapturedMotion[] = [];
    this.collecting = samples;
    try {
      build();
    } finally {
      this.collecting = undefined;
    }
    return samples;
  }

  private collecting?: CapturedMotion[];

  private rest(durationMs: number, pose: Pose = this.pose): void {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 20) {
      const wobble = (this.sequence % 3) - 1;
      this.point([pose[0] + wobble, pose[1] - wobble, pose[2]]);
    }
  }

  private driftPoints(from: Pose, to: Pose, durationMs: number): void {
    const steps = Math.max(1, Math.round(durationMs / 20));
    for (let step = 1; step <= steps; step++) {
      const k = step / steps;
      this.point([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k]);
    }
  }

  /** Rotate a gravity pose about the x axis by `degrees` (positive raises +y). */
  private rotated(pose: Pose, degrees: number): Pose {
    const radians = (degrees * Math.PI) / 180;
    return [pose[0], pose[1] * Math.cos(radians) + pose[2] * Math.sin(radians), -pose[1] * Math.sin(radians) + pose[2] * Math.cos(radians)];
  }

  /** Rotate a gravity pose about the y axis by `degrees` (positive tips gravity from z toward +x). */
  private pitched(pose: Pose, degrees: number): Pose {
    const radians = (degrees * Math.PI) / 180;
    return [pose[0] * Math.cos(radians) + pose[2] * Math.sin(radians), pose[1], -pose[0] * Math.sin(radians) + pose[2] * Math.cos(radians)];
  }

  private point(pose: Pose, flags = MotionFlag.Valid): void {
    const sample: CapturedMotion = {
      version: 1,
      flags,
      seq: this.sequence & 0xffff,
      captureMs: this.timeMs,
      bootId: 11,
      axMg: Math.round(pose[0]),
      ayMg: Math.round(pose[1]),
      azMg: Math.round(pose[2]),
      browserMs: this.timeMs,
      ageUpperMs: 0,
      breaksGesture: this.first,
    };
    this.first = false;
    this.collecting?.push(sample);
    this.sequence++;
    this.timeMs += 20;
  }
}

export function createCoreMotionFixtures(): CoreMotionFixtures {
  const builder = new RawMotionTraceBuilder();
  return {
    stillness: builder.stillness(),
    calibration: {
      stupefy: [builder.jab(820), builder.jab(900), builder.jab(980)],
      // Lowering between guards is part of the recording: the recognizer must ignore it.
      protego: [builder.guard(33), builder.lower(33), builder.guard(36), builder.lower(36), builder.guard(39), builder.lower(39)],
      expelliarmus: [
        builder.jab(820, 0, STROKE_DIRECTIONS.expelliarmus),
        builder.jab(900, 0, STROKE_DIRECTIONS.expelliarmus),
        builder.jab(980, 0, STROKE_DIRECTIONS.expelliarmus),
      ],
    },
    heldOut: {
      stupefy: builder.jab(760),
      protego: builder.guard(31),
      expelliarmus: builder.jab(800, 0, STROKE_DIRECTIONS.expelliarmus),
    },
  };
}

/** Calibration and held-out traces for all seven spells, in the order players learn them. */
export function createSevenSpellFixtures(): SevenSpellFixtures {
  const builder = new RawMotionTraceBuilder();
  // Each jab leaves the hand a few degrees from where it started; alternate the drift so fifteen
  // strokes do not add up to a rotated grip (a real grip change needs Reset grip).
  const strokes = (spell: keyof typeof STROKE_DIRECTIONS) =>
    [820, 900, 980].map((amplitude, index) => builder.jab(amplitude, 0, STROKE_DIRECTIONS[spell], 1, index === 1 ? -12 : 6));
  return {
    stillness: builder.stillness(),
    calibration: {
      stupefy: strokes("stupefy"),
      protego: [builder.guard(33), builder.lower(33), builder.guard(36), builder.lower(36), builder.guard(39), builder.lower(39)],
      expelliarmus: strokes("expelliarmus"),
      incendio: strokes("incendio"),
      sectumsempra: strokes("sectumsempra"),
      "petrificus-totalus": strokes("petrificus-totalus"),
      "expecto-patronum": [builder.circle(600, 900), builder.circle(700, 800), builder.circle(650, 1_000)],
    },
    heldOut: {
      stupefy: builder.jab(760, 0, STROKE_DIRECTIONS.stupefy, 1, -6),
      protego: builder.guard(31),
      expelliarmus: builder.jab(800, 0, STROKE_DIRECTIONS.expelliarmus, 1, 6),
      incendio: builder.jab(840, 0, STROKE_DIRECTIONS.incendio, 1, -6),
      sectumsempra: builder.jab(880, 0, STROKE_DIRECTIONS.sectumsempra, 1, 6),
      "petrificus-totalus": builder.jab(860, 0, STROKE_DIRECTIONS["petrificus-totalus"], 1, -6),
      "expecto-patronum": builder.circle(620, 950),
    },
  };
}
