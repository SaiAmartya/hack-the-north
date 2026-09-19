import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";

type Pose = readonly [number, number, number];

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

  guard(degrees = 35, holdMs = 320, movementMs = 320): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(300);
      const start = this.pose;
      const raised = this.rotated(start, degrees);
      const steps = Math.round(movementMs / 20);
      for (let step = 1; step <= steps; step++) {
        const k = step / steps;
        const eased = 0.5 - Math.cos(k * Math.PI) / 2;
        const push = Math.sin(k * Math.PI) * 220;  // the arm accelerates the wand while raising it
        this.point([start[0] + (raised[0] - start[0]) * eased, start[1] + (raised[1] - start[1]) * eased + push, start[2] + (raised[2] - start[2]) * eased]);
      }
      this.pose = raised;
      this.rest(holdMs, raised);
    });
  }

  /** Lower a raised guard back to a pose; not a spell. */
  lower(degrees = 35, movementMs = 360): readonly CapturedMotion[] {
    return this.capture(() => {
      const start = this.pose;
      const lowered = this.rotated(start, -degrees);
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
      expelliarmus: [builder.jab(820, 1), builder.jab(900, 1), builder.jab(980, 1)],
    },
    heldOut: {
      stupefy: builder.jab(760),
      protego: builder.guard(31),
      expelliarmus: builder.jab(800, 1),
    },
  };
}
