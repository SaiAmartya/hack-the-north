import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";

export type SpellName = "stupefy" | "protego" | "expelliarmus";

export type GestureEvidence = {
  id: string;
  generation: number;
  spell: SpellName;
  startMs: number;
  endMs: number;
  quality: number;
};

export type MotionRecognizerPhase =
  | "uncalibrated"
  | "stillness"
  | "gesture-calibration"
  | "resuming"
  | "ready"
  | "fault";

export type MotionRecognizerState = {
  phase: MotionRecognizerPhase;
  generation?: number;
  stillnessMs: number;
  calibratingSpell?: SpellName;
  examplesBySpell: Readonly<Record<SpellName, number>>;
  calibratedSpells: readonly SpellName[];
  enabledSpells: readonly SpellName[];
  lastIssue: string;
  progress: "hold-still" | "return-neutral" | "armed" | "moving" | "settling" | "ready";
  progressMs: number;
  progressTargetMs: number;
  reason?: MotionRejectionReason;
};

export type MotionRejectionReason =
  | "keep-still" | "invalid-gravity" | "motion-gap" | "invalid-sample"
  | "return-neutral" | "too-short" | "too-long" | "unclear-direction"
  | "too-small" | "missing-stop" | "inconsistent-direction" | "guard-tilt"
  | "no-match" | "ambiguous";

export const MOTION_RECOGNIZER_VERSION = 2 as const;

export type MotionStopEvidence = "opposite" | "release" | "none";

export type MotionDiagnostics = {
  version: typeof MOTION_RECOGNIZER_VERSION;
  neutralMg?: readonly [number, number, number];
  noiseMg: number;
  candidate?: {
    startMs: number;
    endMs: number;
    durationMs: number;
    peakMg: number;
    dominantRatio: number;
    stopEvidence: MotionStopEvidence;
    finalAngleDeg: number;
    reason: string;
  };
};

type Vector = readonly [number, number, number];
type Matrix = [[number, number, number], [number, number, number], [number, number, number]];
type Candidate = {
  startMs: number;
  samples: CapturedMotion[];
};
type CandidateFeatures = {
  startMs: number;
  endMs: number;
  durationMs: number;
  direction: Vector;
  dominantRatio: number;
  peak: number;
  stopped: boolean;
  stopEvidence: MotionStopEvidence;
  startAngleDeg: number;
  finalAngleDeg: number;
  finalDirection: Vector;
};
type GestureTemplate =
  | { kind: "impulse"; direction: Vector; typicalPeak: number }
  | { kind: "guard"; direction: Vector };

const SPELLS: readonly SpellName[] = [
  "stupefy",
  "protego",
  "expelliarmus",
];
const CORE_SPELLS: readonly SpellName[] = ["stupefy", "protego"];
const STILLNESS_MS = 3_000;
const REST_MS = 200;
const MOVEMENT_MIN_MS = 150;
const MOVEMENT_MAX_MS = 900;
const SETTLE_MS = 150;
const MAX_GAP_MS = 150;
const DOMINANT_RATIO = 0.65;
const NEUTRAL_DEGREES = 20;
const GUARD_DEGREES = 25;
const DIRECTION_DEGREES = 25;
const RESUME_MS = 1_000;
const ONSET_MIN_MG = 120;
const ONSET_TILT_DEGREES = 8;
const ONSET_SUSTAIN_MS = 40;
const QUASI_STATIC_MG = 180;
const RELEASE_RMS_MG = 60;
const RELEASE_DRIFT_MG = 80;
const RELEASE_ROTATION_DEGREES = 5;

// Integrate observed intervals, not sample counts, so callback jitter cannot
// overweight a burst of readings. Window boundaries never become observations.
function weightedMean(samples: readonly CapturedMotion[], start: number, end: number): Vector {
  let total: Vector = [0, 0, 0];
  let duration = 0;
  for (let index = 1; index < samples.length; index++) {
    const left = samples[index - 1], right = samples[index];
    const from = Math.max(start, left.browserMs), to = Math.min(end, right.browserMs);
    if (to <= from) continue;
    const interpolate = (time: number) => add(vector(left), scale(subtract(vector(right), vector(left)), (time - left.browserMs) / (right.browserMs - left.browserMs)));
    const weight = to - from;
    total = add(total, scale(add(interpolate(from), interpolate(to)), weight / 2));
    duration += weight;
  }
  return duration > 0 ? scale(total, 1 / duration) : vector(samples[samples.length - 1]);
}

function weightedEnergy(samples: readonly CapturedMotion[], start: number, end: number, center: Vector): Matrix {
  const matrix: Matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let index = 1; index < samples.length; index++) {
    const left = samples[index - 1], right = samples[index];
    const from = Math.max(start, left.browserMs), to = Math.min(end, right.browserMs);
    if (to <= from) continue;
    const a = subtract(vector(left), center), b = subtract(vector(right), center);
    const delta = subtract(b, a);
    const first = add(a, scale(delta, (from - left.browserMs) / (right.browserMs - left.browserMs)));
    const last = add(a, scale(delta, (to - left.browserMs) / (right.browserMs - left.browserMs)));
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++)
      matrix[row][column] += (to - from) * (2 * first[row] * first[column] + first[row] * last[column] + last[row] * first[column] + 2 * last[row] * last[column]) / 6;
  }
  return matrix;
}

function leadingDirection(matrix: Matrix): { direction: Vector; ratio: number } {
  const diagonal = [matrix[0][0], matrix[1][1], matrix[2][2]];
  const multiply = (value: Vector): Vector => [
    dot(matrix[0], value),
    dot(matrix[1], value),
    dot(matrix[2], value),
  ];
  let direction: Vector = [1, 0, 0], eigenvalue = -Infinity;
  for (const seed of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
    let candidate: Vector = seed;
    for (let step = 0; step < 24; step++) candidate = normalized(multiply(candidate));
    const value = dot(candidate, multiply(candidate));
    if (value > eigenvalue) {
      direction = candidate;
      eigenvalue = value;
    }
  }
  const total = diagonal.reduce((sum, value) => sum + value, 0);
  return { direction, ratio: total > 0 ? eigenvalue / total : 0 };
}

function vector(sample: CapturedMotion): Vector {
  return [sample.axMg, sample.ayMg, sample.azMg];
}

function add(left: Vector, right: Vector): Vector {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vector, right: Vector): Vector {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: Vector, factor: number): Vector {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(left: Vector, right: Vector): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function magnitude(value: Vector): number {
  return Math.sqrt(dot(value, value));
}

function normalized(value: Vector): Vector {
  const length = magnitude(value);
  return length > 0 ? scale(value, 1 / length) : [0, 0, 0];
}

function mean(values: readonly Vector[]): Vector {
  return scale(values.reduce(add, [0, 0, 0] as Vector), 1 / values.length);
}

function angleDegrees(left: Vector, right: Vector): number {
  const divisor = magnitude(left) * magnitude(right);
  if (divisor === 0) return 180;
  const cosine = Math.max(-1, Math.min(1, dot(left, right) / divisor));
  return (Math.acos(cosine) * 180) / Math.PI;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function spellCounts(): Record<SpellName, number> {
  return { stupefy: 0, protego: 0, expelliarmus: 0 };
}

export class MotionRecognizer {
  private phase: MotionRecognizerPhase = "uncalibrated";
  private generation?: number;
  private stillSamples: CapturedMotion[] = [];
  private stillStartedAt?: number;
  private neutral?: Vector;
  private noiseRms = 0;
  private calibratingSpell?: SpellName;
  private readonly examples = new Map<SpellName, CandidateFeatures[]>();
  private readonly templates = new Map<SpellName, GestureTemplate>();
  private enabledSpells = new Set<SpellName>(CORE_SPELLS);
  private previous?: CapturedMotion;
  private recent: CapturedMotion[] = [];
  private armed = false;
  private candidate?: Candidate;
  private evidenceSequence = 0;
  private lastIssue = "";
  private reason?: MotionRejectionReason;
  private progress: MotionRecognizerState["progress"] = "hold-still";
  private progressMs = 0;
  private progressTargetMs = STILLNESS_MS;
  private lastCandidate?: MotionDiagnostics["candidate"];

  constructor(private readonly onGesture: (evidence: GestureEvidence) => void) {}

  beginCalibration(): void {
    this.phase = "stillness";
    this.generation = undefined;
    this.stillSamples = [];
    this.stillStartedAt = undefined;
    this.neutral = undefined;
    this.noiseRms = 0;
    this.calibratingSpell = undefined;
    this.examples.clear();
    this.templates.clear();
    this.enabledSpells = new Set(CORE_SPELLS);
    this.evidenceSequence = 0;
    this.lastIssue = "Hold the wand still for 3 seconds";
    this.reason = undefined;
    this.lastCandidate = undefined;
    this.clearSegmenter();
    this.setProgress("hold-still", 0, STILLNESS_MS);
  }

  resumeCalibration(generation: number): boolean {
    if (!Number.isSafeInteger(generation) || generation < 0 || !this.neutral ||
      !CORE_SPELLS.every((spell) => this.templates.has(spell)) ||
      ![...this.enabledSpells].every((spell) => this.templates.has(spell))) return false;
    this.generation = generation;
    this.calibratingSpell = undefined;
    this.phase = "resuming";
    this.clearSegmenter();
    this.lastIssue = "Hold your calibrated neutral grip for 1 second";
    this.setProgress("return-neutral", 0, RESUME_MS);
    return true;
  }

  beginGestureCalibration(spell: SpellName): void {
    if (!this.neutral || this.phase === "stillness" || this.phase === "resuming" || this.phase === "fault")
      throw new Error("Complete stillness calibration first");
    this.calibratingSpell = spell;
    this.examples.set(spell, []);
    this.templates.delete(spell);
    this.phase = "gesture-calibration";
    this.lastIssue = `Collect three coached ${spell} examples`;
    this.reason = undefined;
    this.lastCandidate = undefined;
    this.clearSegmenter();
    this.setProgress("return-neutral", 0, REST_MS);
  }

  setEnabledSpells(spells: readonly SpellName[]): void {
    const next = new Set(spells);
    if (next.size !== spells.length || spells.some((spell) => !SPELLS.includes(spell)))
      throw new Error("Enabled spells must be unique supported spell names");
    if (next.has("expelliarmus") && !this.templates.has("expelliarmus"))
      throw new Error("Calibrate Expelliarmus before enabling it");
    this.enabledSpells = next;
    this.updateReadyPhase();
  }

  push(sample: CapturedMotion, generation: number): void {
    if (this.phase === "uncalibrated" || this.phase === "fault") return;
    if (this.generation === undefined) this.generation = generation;
    else if (generation !== this.generation) {
      this.reset("Motion generation changed; recalibrate for the new stream");
      return;
    }

    if (!this.isFiniteSample(sample) || sample.ageUpperMs < 0 || sample.ageUpperMs > 200) {
      this.breakContinuity("Non-finite motion sample");
      return;
    }
    if (
      !(sample.flags & MotionFlag.Valid) ||
      sample.flags & (MotionFlag.Saturated | MotionFlag.Discontinuity)
    ) {
      this.breakContinuity("Invalid, saturated or discontinuous motion");
      return;
    }

    const gap = this.previous
      ? sample.browserMs - this.previous.browserMs
      : undefined;
    if (gap !== undefined && (gap <= 0 || gap > MAX_GAP_MS)) {
      this.breakContinuity(
        gap > MAX_GAP_MS
          ? "Motion gap exceeded 150 ms"
          : "Motion timestamps were not monotonic",
      );
    }
    if (sample.breaksGesture) {
      this.breakContinuity("Motion source marked a gesture break");
    }

    if (this.phase === "stillness") this.pushStillness(sample);
    else if (this.phase === "resuming") this.pushResume(sample);
    else if (this.calibratingSpell || this.phase === "ready")
      this.pushSegmenter(sample);
    this.previous = sample;
  }

  clearPending(reason = ""): void {
    this.clearSegmenter();
    if (this.phase === "stillness") {
      this.stillSamples = [];
      this.stillStartedAt = undefined;
    }
    this.lastIssue = reason;
    this.reason = undefined;
    this.lastCandidate = undefined;
  }

  reset(reason = ""): void {
    this.phase = "uncalibrated";
    this.generation = undefined;
    this.stillSamples = [];
    this.stillStartedAt = undefined;
    this.neutral = undefined;
    this.noiseRms = 0;
    this.calibratingSpell = undefined;
    this.examples.clear();
    this.templates.clear();
    this.enabledSpells = new Set(CORE_SPELLS);
    this.evidenceSequence = 0;
    this.lastIssue = reason;
    this.reason = undefined;
    this.lastCandidate = undefined;
    this.clearSegmenter();
  }

  getState(): MotionRecognizerState {
    const counts = spellCounts();
    for (const spell of SPELLS) counts[spell] = this.examples.get(spell)?.length ?? 0;
    return {
      phase: this.phase,
      generation: this.generation,
      stillnessMs:
        this.phase === "stillness" && this.stillStartedAt !== undefined
          ? Math.max(
              0,
              (this.stillSamples.at(-1)?.browserMs ?? this.stillStartedAt) -
                this.stillStartedAt,
            )
          : this.neutral
            ? STILLNESS_MS
            : 0,
      calibratingSpell: this.calibratingSpell,
      examplesBySpell: counts,
      calibratedSpells: SPELLS.filter((spell) => this.templates.has(spell)),
      enabledSpells: SPELLS.filter((spell) => this.enabledSpells.has(spell)),
      lastIssue: this.lastIssue,
      progress: this.progress,
      progressMs: this.progressMs,
      progressTargetMs: this.progressTargetMs,
      reason: this.reason,
    };
  }

  getDiagnostics(): MotionDiagnostics {
    return {
      version: MOTION_RECOGNIZER_VERSION,
      neutralMg: this.neutral,
      noiseMg: this.noiseRms,
      candidate: this.lastCandidate,
    };
  }

  private isFiniteSample(sample: CapturedMotion): boolean {
    return [
      sample.browserMs,
      sample.ageUpperMs,
      sample.axMg,
      sample.ayMg,
      sample.azMg,
    ].every(Number.isFinite);
  }

  private breakContinuity(reason: string): void {
    this.lastIssue = reason;
    this.candidate = undefined;
    this.armed = false;
    this.recent = [];
    this.lastCandidate = undefined;
    this.reason = reason.includes("gap") ? "motion-gap" : "invalid-sample";
    this.setProgress(this.phase === "stillness" ? "hold-still" : "return-neutral", 0, this.phase === "stillness" ? STILLNESS_MS : this.phase === "resuming" ? RESUME_MS : REST_MS);
    this.previous = undefined;
    if (this.phase === "stillness") {
      this.stillSamples = [];
      this.stillStartedAt = undefined;
    }
  }

  private pushStillness(sample: CapturedMotion): void {
    if (this.stillStartedAt === undefined) this.stillStartedAt = sample.browserMs;
    this.stillSamples.push(sample);
    this.trimWindow(this.stillSamples, STILLNESS_MS);
    const elapsed = sample.browserMs - this.stillSamples[0].browserMs;
    this.setProgress("hold-still", Math.min(elapsed, STILLNESS_MS), STILLNESS_MS);
    if (elapsed >= REST_MS && !this.stable(this.stillSamples, Math.min(elapsed, STILLNESS_MS))) {
      this.stillSamples = [sample];
      this.stillStartedAt = sample.browserMs;
      this.lastIssue = "Keep still; the quiet window will restart automatically";
      this.reason = "keep-still";
      this.progressMs = 0;
      return;
    }
    if (elapsed < STILLNESS_MS) return;

    const start = sample.browserMs - STILLNESS_MS;
    const neutral = weightedMean(this.stillSamples, start, sample.browserMs);
    const energy = weightedEnergy(this.stillSamples, start, sample.browserMs, neutral);
    const rms = Math.sqrt((energy[0][0] + energy[1][1] + energy[2][2]) / STILLNESS_MS);
    const gravity = magnitude(neutral);
    if (gravity < 750 || gravity > 1_250) {
      this.lastIssue = "Hold the controller still in its neutral grip";
      this.reason = "invalid-gravity";
      this.stillSamples = [sample];
      this.stillStartedAt = sample.browserMs;
      return;
    }
    this.neutral = neutral;
    this.noiseRms = rms;
    this.phase = "gesture-calibration";
    this.lastIssue = "Stillness captured; collect three coached examples per core spell";
    this.stillSamples = [];
    this.stillStartedAt = undefined;
    this.clearSegmenter();
    this.reason = undefined;
    this.setProgress("return-neutral", 0, REST_MS);
  }

  private pushSegmenter(sample: CapturedMotion): void {
    if (!this.neutral) return;
    this.recent.push(sample);
    this.trimWindow(this.recent, REST_MS);
    const current = vector(sample);
    if (!this.candidate) {
      const stable = this.stable(this.recent, REST_MS);
      const onsetMs = this.armed ? this.onsetStart(this.recent) : undefined;
      if (onsetMs !== undefined) {
        const start = Math.max(0, onsetMs - 20);
        this.candidate = {
          startMs: onsetMs,
          samples: this.recent.filter((candidateSample) => candidateSample.browserMs >= start),
        };
        this.armed = false;
        this.setProgress("moving", 0, MOVEMENT_MAX_MS);
        return;
      }
      if (stable && this.isNeutral(current)) {
        this.armed = true;
        if (this.reason === "return-neutral") {
          this.reason = undefined;
          this.lastIssue = "";
        }
        this.setProgress("armed", REST_MS, REST_MS);
      } else {
        if (!stable && this.armed) {
          this.setProgress("armed", this.stableSuffix(this.recent, REST_MS), REST_MS);
          return;
        }
        this.armed = false;
        if (stable && !this.isNeutral(current)) {
          this.reason = "return-neutral";
          this.lastIssue = "Return to the calibrated neutral grip, or restart calibration for this grip";
        }
        this.setProgress("return-neutral", this.isNeutral(current) ? this.stableSuffix(this.recent, REST_MS) : 0, REST_MS);
      }
      return;
    }

    this.candidate.samples.push(sample);
    const elapsed = sample.browserMs - this.candidate.startMs;
    if (elapsed > MOVEMENT_MAX_MS + SETTLE_MS) {
      this.rejectCandidate("Gesture exceeded the 900 ms movement limit", "too-long");
      return;
    }
    this.setProgress("moving", elapsed, MOVEMENT_MAX_MS);
    const release = this.releaseSuffix(this.candidate.samples, this.candidate.startMs);
    if (release) this.setProgress("settling", release.durationMs, SETTLE_MS);
    if (release && release.durationMs >= SETTLE_MS) {
      const endMs = release.startMs;
      const duration = endMs - this.candidate.startMs;
      if (duration < MOVEMENT_MIN_MS || duration > MOVEMENT_MAX_MS) {
        this.rejectCandidate("Make one deliberate jab or guard, then let the wand settle", duration < MOVEMENT_MIN_MS ? "too-short" : "too-long", endMs);
        return;
      }
      this.completeCandidate(this.candidate, endMs);
      this.candidate = undefined;
      this.armed = false;
      this.recent = [sample];
      this.setProgress("return-neutral", 0, REST_MS);
    }
  }

  private pushResume(sample: CapturedMotion): void {
    this.recent.push(sample);
    this.trimWindow(this.recent, RESUME_MS);
    if (!this.isNeutral(vector(sample))) {
      this.recent = [sample];
      this.reason = "return-neutral";
    }
    const elapsed = sample.browserMs - this.recent[0].browserMs;
    if (elapsed >= REST_MS && !this.stable(this.recent, Math.min(elapsed, RESUME_MS))) {
      this.recent = [sample];
      this.reason = "keep-still";
    }
    this.setProgress("return-neutral", sample.browserMs - this.recent[0].browserMs, RESUME_MS);
    if (!this.stable(this.recent, RESUME_MS) || !this.isNeutral(vector(sample))) return;
    this.phase = "ready";
    this.clearSegmenter();
    this.lastIssue = "";
    this.reason = undefined;
    this.setProgress("ready", RESUME_MS, RESUME_MS);
  }

  private trimWindow(samples: CapturedMotion[], duration: number): void {
    const start = samples[samples.length - 1].browserMs - duration;
    while (samples.length > 2 && samples[1].browserMs <= start) samples.shift();
  }

  private stable(samples: readonly CapturedMotion[], duration: number): boolean {
    const end = samples[samples.length - 1]?.browserMs;
    if (end === undefined || duration <= 0 || samples[0].browserMs > end - duration ||
      samples.filter((sample) => sample.browserMs >= end - duration).length < 4) return false;
    const start = end - duration;
    const center = weightedMean(samples, start, end);
    const energy = weightedEnergy(samples, start, end, center);
    const rms = Math.sqrt((energy[0][0] + energy[1][1] + energy[2][2]) / duration);
    const first = weightedMean(samples, start, start + Math.min(50, duration));
    const last = weightedMean(samples, end - Math.min(50, duration), end);
    return rms <= Math.max(30, 3 * this.noiseRms) &&
      magnitude(subtract(first, last)) <= Math.max(40, 4 * this.noiseRms) &&
      angleDegrees(first, last) <= 3;
  }

  private stableSuffix(samples: readonly CapturedMotion[], limit: number): number {
    const end = samples[samples.length - 1].browserMs;
    let longest = 0;
    for (let index = samples.length - 4; index >= 0; index--) {
      const duration = Math.min(limit, end - samples[index].browserMs);
      if (this.stable(samples, duration)) longest = duration;
      else break;
      if (duration === limit) break;
    }
    return longest;
  }

  private onsetStart(samples: readonly CapturedMotion[]): number | undefined {
    if (!this.neutral || samples.length < 4) return undefined;
    const threshold = Math.max(ONSET_MIN_MG, 6 * this.noiseRms);
    let start: number | undefined;
    for (const sample of samples) {
      const value = vector(sample);
      const active =
        magnitude(subtract(value, this.neutral)) >= threshold ||
        angleDegrees(value, this.neutral) >= ONSET_TILT_DEGREES;
      if (!active) {
        start = undefined;
        continue;
      }
      start ??= sample.browserMs;
      if (sample.browserMs - start >= ONSET_SUSTAIN_MS) return start;
    }
    return undefined;
  }

  private releaseSuffix(samples: readonly CapturedMotion[], earliestStartMs: number): { startMs: number; durationMs: number } | undefined {
    const end = samples[samples.length - 1]?.browserMs;
    if (!this.neutral || end === undefined || samples.length < 4) return undefined;
    let best: { startMs: number; durationMs: number } | undefined;
    for (let index = samples.length - 4; index >= 0; index--) {
      const startMs = samples[index].browserMs;
      if (startMs < earliestStartMs) break;
      const durationMs = end - startMs;
      if (durationMs > SETTLE_MS + 200) break;
      if (durationMs < ONSET_SUSTAIN_MS) continue;
      if (samples.filter((sample) => sample.browserMs >= startMs).length < 4) continue;

      const center = weightedMean(samples, startMs, end);
      const energy = weightedEnergy(samples, startMs, end, center);
      const rms = Math.sqrt((energy[0][0] + energy[1][1] + energy[2][2]) / durationMs);
      const edgeMs = Math.min(50, durationMs);
      const first = weightedMean(samples, startMs, startMs + edgeMs);
      const last = weightedMean(samples, end - edgeMs, end);
      const drift = magnitude(subtract(first, last));
      const rotation = angleDegrees(first, last);
      const gravityError = Math.abs(magnitude(center) - magnitude(this.neutral));
      const tiltedEndpoint = angleDegrees(center, this.neutral) > ONSET_TILT_DEGREES;
      if (
        rms <= (tiltedEndpoint ? Math.max(30, 3 * this.noiseRms) : Math.max(RELEASE_RMS_MG, 4 * this.noiseRms)) &&
        drift <= (tiltedEndpoint ? Math.max(40, 4 * this.noiseRms) : Math.max(RELEASE_DRIFT_MG, 6 * this.noiseRms)) &&
        rotation <= (tiltedEndpoint ? 3 : RELEASE_ROTATION_DEGREES) &&
        gravityError <= QUASI_STATIC_MG
      )
        best = { startMs, durationMs };
      else if (best) break;
    }
    return best;
  }

  private setProgress(progress: MotionRecognizerState["progress"], elapsed: number, target: number): void {
    this.progress = progress;
    this.progressMs = Math.max(0, elapsed);
    this.progressTargetMs = target;
  }

  private completeCandidate(candidate: Candidate, endMs: number): void {
    if (candidate.samples.filter((sample) => sample.browserMs >= candidate.startMs && sample.browserMs <= endMs).length < 4) {
      this.lastIssue = "The movement needs at least four fresh observations";
      this.reason = "too-short";
      return;
    }
    const features = this.features(candidate, endMs);
    this.recordCandidate(features, "candidate");
    if (this.calibratingSpell) {
      this.acceptCalibrationExample(this.calibratingSpell, features);
      return;
    }
    if (this.phase !== "ready" || this.generation === undefined) return;

    const matches = [...this.enabledSpells]
      .map((spell) => ({ spell, quality: this.match(spell, features) }))
      .filter(
        (result): result is { spell: SpellName; quality: number } =>
          result.quality !== undefined,
      );
    if (matches.length !== 1) {
      this.lastIssue =
        matches.length > 1
          ? "Gesture matched multiple spell profiles"
          : "Gesture did not match a calibrated spell";
      this.reason = matches.length > 1 ? "ambiguous" : "no-match";
      this.recordCandidate(features, this.reason);
      return;
    }
    const match = matches[0];
    this.lastIssue = "";
    this.reason = undefined;
    this.recordCandidate(features, "accepted");
    this.onGesture({
      id: `${this.generation}:gesture:${++this.evidenceSequence}`,
      generation: this.generation,
      spell: match.spell,
      startMs: features.startMs,
      endMs: features.endMs,
      quality: match.quality,
    });
  }

  private features(candidate: Candidate, endMs: number): CandidateFeatures {
    if (!this.neutral) throw new Error("Neutral calibration missing");
    const movement = candidate.samples.filter((sample) => sample.browserMs <= endMs);
    const principal = leadingDirection(weightedEnergy(candidate.samples, candidate.startMs, endMs, this.neutral));
    const projections = movement.map((sample) => dot(subtract(vector(sample), this.neutral!), principal.direction));
    const lobeThreshold = Math.max(40, this.noiseRms * 4);
    let firstSign = 0, runSign = 0, runStart = 0, firstLobeEnd = Infinity;
    for (let index = 0; index < movement.length; index++) {
      const value = projections[index];
      const sign = Math.abs(value) >= lobeThreshold ? Math.sign(value) : 0;
      if (sign === 0 || sign !== runSign) {
        runSign = sign;
        runStart = movement[index].browserMs;
      }
      if (sign !== 0 && movement[index].browserMs - runStart >= 40) {
        firstSign = sign;
        firstLobeEnd = movement[index].browserMs;
        break;
      }
    }
    const direction = scale(principal.direction, firstSign);
    const peak = Math.max(0, ...projections.map((value) => value * firstSign));
    const weakStopThreshold = Math.max(80, peak * 0.08, this.noiseRms * 3);
    const opposite = movement.some((sample, index) =>
      sample.browserMs > firstLobeEnd && projections[index] * firstSign <= -weakStopThreshold);
    const lastSampleMs = candidate.samples[candidate.samples.length - 1].browserMs;
    const finalVector = weightedMean(candidate.samples, endMs, lastSampleMs);
    const finalResidual = magnitude(subtract(finalVector, this.neutral));
    const finalProjection = Math.abs(dot(subtract(finalVector, this.neutral), scale(principal.direction, firstSign)));
    const release =
      lastSampleMs - endMs >= SETTLE_MS &&
      endMs - firstLobeEnd >= 60 &&
      finalResidual <= Math.max(QUASI_STATIC_MG, peak * 0.35) &&
      finalProjection <= Math.max(ONSET_MIN_MG, peak * 0.25);
    const stopEvidence: MotionStopEvidence = opposite
      ? "opposite"
      : release
        ? "release"
        : "none";
    return {
      startMs: candidate.startMs,
      endMs,
      durationMs: endMs - candidate.startMs,
      direction,
      dominantRatio: principal.ratio,
      peak,
      stopped: stopEvidence !== "none",
      stopEvidence,
      startAngleDeg: angleDegrees(vector(candidate.samples[0]), this.neutral),
      finalAngleDeg: angleDegrees(finalVector, this.neutral),
      finalDirection: normalized(subtract(finalVector, this.neutral)),
    };
  }

  private acceptCalibrationExample(
    spell: SpellName,
    features: CandidateFeatures,
  ): void {
    const issue = this.calibrationIssue(spell, features);
    if (issue) {
      this.lastIssue = issue.message;
      this.reason = issue.reason;
      this.recordCandidate(features, issue.reason);
      return;
    }
    const examples = this.examples.get(spell) ?? [];
    examples.push(features);
    this.examples.set(spell, examples);
    this.lastIssue = `${examples.length}/3 ${spell} examples captured`;
    this.reason = undefined;
    if (examples.length < 3) return;

    if (spell === "protego") {
      this.templates.set(spell, {
        kind: "guard",
        direction: normalized(mean(examples.map((example) => example.finalDirection))),
      });
    } else {
      this.templates.set(spell, {
        kind: "impulse",
        direction: normalized(mean(examples.map((example) => example.direction))),
        typicalPeak: median(examples.map((example) => example.peak)),
      });
    }
    this.calibratingSpell = undefined;
    this.updateReadyPhase();
    this.lastIssue =
      this.phase === "ready"
        ? "Core gesture calibration complete; held-out checks remain"
        : `${spell} calibrated; collect the remaining enabled spell examples`;
  }

  private calibrationIssue(
    spell: SpellName,
    features: CandidateFeatures,
  ): { message: string; reason: MotionRejectionReason } | undefined {
    if (features.startAngleDeg > NEUTRAL_DEGREES)
      return { message: "Begin each coached gesture from the calibrated neutral grip", reason: "return-neutral" };
    const prior = this.examples.get(spell) ?? [];
    if (spell === "protego") {
      if (features.finalAngleDeg < GUARD_DEGREES)
        return { message: "Protego must finish in a stable tilt of at least 25 degrees", reason: "guard-tilt" };
      if (
        prior.some((example) => angleDegrees(features.finalDirection, example.finalDirection) > DIRECTION_DEGREES)
      )
        return { message: "Protego examples must use a consistent tilt direction", reason: "inconsistent-direction" };
      return undefined;
    }
    if (features.dominantRatio < DOMINANT_RATIO || magnitude(features.direction) < 0.9)
      return { message: "Impulse examples need a clear first direction and at least 65% energy along it", reason: "unclear-direction" };
    if (features.finalAngleDeg > NEUTRAL_DEGREES)
      return { message: "Impulse examples must return within 20 degrees of neutral", reason: "return-neutral" };
    if (features.peak < 250) return { message: "Impulse example was too small to calibrate", reason: "too-small" };
    if (!features.stopped) return { message: "Finish the impulse with an opposite stopping movement", reason: "missing-stop" };
    if (
      prior.some(
        (example) =>
          angleDegrees(example.direction, features.direction) > DIRECTION_DEGREES,
      )
    )
      return { message: "Impulse examples must keep directions within 25 degrees", reason: "inconsistent-direction" };
    const stupefy = this.templates.get("stupefy");
    if (
      spell === "expelliarmus" &&
      stupefy?.kind === "impulse" &&
      angleDegrees(stupefy.direction, features.direction) < 65
    )
      return { message: "Expelliarmus must use a distinct direction from Stupefy", reason: "inconsistent-direction" };
    return undefined;
  }

  private match(
    spell: SpellName,
    features: CandidateFeatures,
  ): number | undefined {
    const template = this.templates.get(spell);
    if (!template || features.startAngleDeg > NEUTRAL_DEGREES) return undefined;
    if (template.kind === "guard") {
      const direction = dot(features.finalDirection, template.direction);
      if (features.finalAngleDeg < GUARD_DEGREES || angleDegrees(features.finalDirection, template.direction) > DIRECTION_DEGREES)
        return undefined;
      return clamp01(
        0.5 +
          (features.finalAngleDeg - GUARD_DEGREES) / 50 +
          (direction - 0.8),
      );
    }
    const minimumPeak = Math.max(180, template.typicalPeak * 0.5);
    if (
      angleDegrees(features.direction, template.direction) > DIRECTION_DEGREES ||
      features.dominantRatio < DOMINANT_RATIO ||
      features.finalAngleDeg > NEUTRAL_DEGREES ||
      features.peak < minimumPeak || !features.stopped
    )
      return undefined;
    return clamp01(
      0.45 +
        (features.dominantRatio - DOMINANT_RATIO) +
        Math.min(0.3, features.peak / template.typicalPeak / 3) +
        (NEUTRAL_DEGREES - features.finalAngleDeg) / 100,
    );
  }

  private isNeutral(value: Vector): boolean {
    return this.neutral !== undefined && magnitude(value) >= 750 && magnitude(value) <= 1250 && angleDegrees(value, this.neutral) <= NEUTRAL_DEGREES;
  }

  private recordCandidate(features: CandidateFeatures, reason: string): void {
    const candidate = {
      startMs: features.startMs,
      endMs: features.endMs,
      durationMs: features.durationMs,
      peakMg: features.peak,
      dominantRatio: features.dominantRatio,
      stopEvidence: features.stopEvidence,
      finalAngleDeg: features.finalAngleDeg,
      reason,
    };
    if ([
      candidate.startMs,
      candidate.endMs,
      candidate.durationMs,
      candidate.peakMg,
      candidate.dominantRatio,
      candidate.finalAngleDeg,
    ].every(Number.isFinite))
      this.lastCandidate = candidate;
  }

  private rejectCandidate(reason: string, code: MotionRejectionReason, endMs?: number): void {
    this.lastIssue = reason;
    this.reason = code;
    if (this.candidate && this.neutral) {
      const fallbackEnd = this.candidate.samples[this.candidate.samples.length - 1]?.browserMs ?? this.candidate.startMs;
      this.recordCandidate(this.features(this.candidate, endMs ?? fallbackEnd), code);
    }
    this.candidate = undefined;
    this.armed = false;
    this.recent = [];
    this.setProgress("return-neutral", 0, REST_MS);
  }

  private updateReadyPhase(): void {
    if (this.phase === "resuming") return;
    this.phase = [...this.enabledSpells].every((spell) => this.templates.has(spell))
      ? "ready"
      : "gesture-calibration";
  }

  private clearSegmenter(): void {
    this.previous = undefined;
    this.recent = [];
    this.armed = false;
    this.candidate = undefined;
    this.setProgress(this.phase === "stillness" ? "hold-still" : "return-neutral", 0, this.phase === "stillness" ? STILLNESS_MS : this.phase === "resuming" ? RESUME_MS : REST_MS);
  }
}
