import type { CapturedMotion } from "../wand/client";
import { ALL_MOTION_FLAGS, MotionFlag } from "../wand/protocol";

/** Motion confirmation only: speech remains the sole source of spell identity. */
export type AccelerationSpikeEvidence = {
  kind: "acceleration-spike";
  id: string;
  generation: number;
  startMs: number;
  endMs: number;
  quality: number;
};

type Vector = readonly [number, number, number];
const START_MG = 200;
const QUIET_MG = 75;
const BASELINE_MS = 120;
const REARM_MS = 180;
const MIN_SPIKE_MS = 20;
const MAX_AGE_MS = 200;
const MAX_GAP_MS = 150;

/**
 * Optional simple-input path. A short change from the recent acceleration vector
 * confirms movement regardless of direction. Gravity stays in the vector, so
 * rotating the wand can also confirm movement; this is not gesture classification.
 */
export class AccelerationSpikeRecognizer {
  private generation?: number;
  private previous?: CapturedMotion;
  private baseline?: Vector;
  private quietSince?: number;
  private spikeStart?: number;
  private armed = false;
  private serial = 0;

  constructor(private readonly onSpike: (evidence: AccelerationSpikeEvidence) => void) {}

  reset(): void {
    this.generation = undefined;
    this.clearMotion();
  }

  push(sample: CapturedMotion, generation: number): void {
    if (!Number.isInteger(generation) || generation < 0)
      throw new Error("Spike generation must be a non-negative integer");
    if (this.generation !== generation) {
      this.clearMotion();
      this.generation = generation;
    }
    if (!this.validSample(sample)) {
      this.clearMotion();
      return;
    }
    const previous = this.previous;
    const dt = previous ? sample.browserMs - previous.browserMs : 0;
    if (sample.breaksGesture || (previous && (
      dt <= 0 || dt > MAX_GAP_MS || sample.bootId !== previous.bootId ||
      ((sample.seq - previous.seq + 65_536) % 65_536) !== 1
    ))) this.clearMotion();

    const vector: Vector = [sample.axMg, sample.ayMg, sample.azMg];
    this.previous = sample;
    if (!this.baseline) {
      this.baseline = vector;
      this.quietSince = sample.browserMs;
      return;
    }
    const baseline = this.baseline;
    const change = Math.hypot(vector[0] - baseline[0], vector[1] - baseline[1], vector[2] - baseline[2]);
    const alpha = 1 - Math.exp(-dt / BASELINE_MS);
    this.baseline = [
      baseline[0] + alpha * (vector[0] - baseline[0]),
      baseline[1] + alpha * (vector[1] - baseline[1]),
      baseline[2] + alpha * (vector[2] - baseline[2]),
    ];

    if (change <= QUIET_MG) {
      this.spikeStart = undefined;
      this.quietSince ??= sample.browserMs;
      if (sample.browserMs - this.quietSince >= REARM_MS) this.armed = true;
      return;
    }
    this.quietSince = undefined;
    if (!this.armed) return;
    if (change < START_MG) {
      this.spikeStart = undefined;
      return;
    }
    this.spikeStart ??= sample.browserMs;
    if (sample.browserMs - this.spikeStart < MIN_SPIKE_MS) return;
    const startMs = this.spikeStart;
    this.armed = false;
    this.spikeStart = undefined;
    this.onSpike({
      kind: "acceleration-spike",
      id: `${generation}:spike:${++this.serial}`,
      generation,
      startMs,
      endMs: sample.browserMs,
      quality: Math.min(1, change / (START_MG * 2)),
    });
  }

  private clearMotion(): void {
    this.previous = undefined;
    this.baseline = undefined;
    this.quietSince = undefined;
    this.spikeStart = undefined;
    this.armed = false;
  }

  private validSample(sample: CapturedMotion): boolean {
    return [sample.browserMs, sample.ageUpperMs, sample.captureMs, sample.axMg, sample.ayMg, sample.azMg].every(Number.isFinite) &&
      sample.ageUpperMs >= 0 && sample.ageUpperMs <= MAX_AGE_MS &&
      sample.version === 1 && Number.isInteger(sample.seq) && sample.seq >= 0 && sample.seq <= 65_535 &&
      Number.isInteger(sample.bootId) && Number.isInteger(sample.flags) &&
      (sample.flags & ~ALL_MOTION_FLAGS) === 0 &&
      (sample.flags & MotionFlag.Valid) !== 0 &&
      (sample.flags & (MotionFlag.Saturated | MotionFlag.Discontinuity)) === 0;
  }
}
