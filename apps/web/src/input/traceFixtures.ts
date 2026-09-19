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

export class RawMotionTraceBuilder {
  private timeMs = 0;
  private sequence = 0;
  private first = true;

  stillness(): readonly CapturedMotion[] {
    return this.capture(() => {
      for (let elapsed = 0; elapsed <= 3_000; elapsed += 20) {
        const wobble = (this.sequence % 5) - 2;
        this.point([wobble, -wobble, 1_000 + (wobble % 2)]);
      }
    });
  }

  jab(amplitude = 900, axis: 0 | 1 = 0, direction?: Pose, stopScale = 1): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(260);
      const shape = [
        0.05, 0.15, 0.3, 0.55, 0.8, 1, 0.8, 0.5, 0.15, -0.2, -0.45,
        -0.3, -0.12, 0, 0, 0,
      ];
      for (const amount of shape) {
        const value = amount * amplitude * (amount < 0 ? stopScale : 1);
        const unit = direction ?? (axis === 0 ? [1, 0, 0] : [0, 1, 0]);
        this.point([unit[0] * value, unit[1] * value, 1_000 + unit[2] * value]);
      }
      this.rest(260);
    });
  }

  guard(degrees = 35, holdMs = 220, movementMs = 320): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(260);
      const steps = Math.round(movementMs / 20);
      for (let step = 1; step <= steps; step++)
        this.point(this.tilt((degrees * step) / steps));
      this.rest(holdMs, this.tilt(degrees));
      for (let step = steps - 1; step >= 0; step--)
        this.point(this.tilt((degrees * step) / steps));
      this.rest(260);
    });
  }

  brokenJab(kind: "gap" | "saturated"): readonly CapturedMotion[] {
    return this.capture(() => {
      this.rest(260);
      for (const amount of [0.1, 0.35, 0.7])
        this.point([amount * 900, 0, 1_000]);
      if (kind === "gap") {
        this.timeMs += 180;
        this.point([900, 0, 1_000]);
      } else {
        this.point(
          [900, 0, 1_000],
          MotionFlag.Valid | MotionFlag.Saturated,
        );
      }
      for (const amount of [0.7, 0.2, -0.3, 0, 0, 0])
        this.point([amount * 900, 0, 1_000]);
      this.rest(260);
    });
  }

  neutralSample(durationMs = 20): readonly CapturedMotion[] {
    return this.capture(() => this.rest(durationMs));
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

  private rest(durationMs: number, pose: Pose = [0, 0, 1_000]): void {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 20) this.point(pose);
  }

  private tilt(degrees: number): Pose {
    const radians = (degrees * Math.PI) / 180;
    return [0, Math.sin(radians) * 1_000, Math.cos(radians) * 1_000];
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
      protego: [builder.guard(33), builder.guard(36), builder.guard(39)],
      expelliarmus: [
        builder.jab(820, 1),
        builder.jab(900, 1),
        builder.jab(980, 1),
      ],
    },
    heldOut: {
      stupefy: builder.jab(760),
      protego: builder.guard(31),
      expelliarmus: builder.jab(800, 1),
    },
  };
}
