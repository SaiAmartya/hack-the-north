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
};

type Vector = readonly [number, number, number];
type Axis = 0 | 1 | 2;
type Candidate = {
  startMs: number;
  samples: CapturedMotion[];
  settleStartMs?: number;
};
type CandidateFeatures = {
  startMs: number;
  endMs: number;
  durationMs: number;
  dominantAxis: Axis;
  dominantRatio: number;
  peak: number;
  peakSign: 1 | -1;
  startAngleDeg: number;
  finalAngleDeg: number;
  finalDirection: Vector;
};
type GestureTemplate =
  | { kind: "impulse"; axis: Axis; sign: 1 | -1; typicalPeak: number }
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
  private neutralStableSince?: number;
  private armed = false;
  private candidate?: Candidate;
  private evidenceSequence = 0;
  private lastIssue = "";

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
    this.clearSegmenter();
  }

  beginGestureCalibration(spell: SpellName): void {
    if (!this.neutral || this.phase === "stillness" || this.phase === "fault")
      throw new Error("Complete stillness calibration first");
    this.calibratingSpell = spell;
    this.examples.set(spell, []);
    this.templates.delete(spell);
    this.phase = "gesture-calibration";
    this.lastIssue = `Collect three coached ${spell} examples`;
    this.clearSegmenter();
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

    if (!this.isFiniteSample(sample)) {
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
    this.neutralStableSince = undefined;
    this.previous = undefined;
    if (this.phase === "stillness") {
      this.stillSamples = [];
      this.stillStartedAt = undefined;
    }
  }

  private pushStillness(sample: CapturedMotion): void {
    if (this.stillStartedAt === undefined) this.stillStartedAt = sample.browserMs;
    this.stillSamples.push(sample);
    if (sample.browserMs - this.stillStartedAt < STILLNESS_MS) return;

    const values = this.stillSamples.map(vector);
    const neutral = mean(values);
    const residuals = values.map((value) => magnitude(subtract(value, neutral)));
    const rms = Math.sqrt(
      residuals.reduce((total, value) => total + value * value, 0) /
        residuals.length,
    );
    const gravity = magnitude(neutral);
    if (gravity < 750 || gravity > 1_250 || rms > 80 || Math.max(...residuals) > 250) {
      this.phase = "fault";
      this.lastIssue = "Stillness calibration moved too much or gravity was invalid";
      this.clearSegmenter();
      return;
    }
    this.neutral = neutral;
    this.noiseRms = rms;
    this.phase = "gesture-calibration";
    this.lastIssue = "Stillness captured; collect three coached examples per core spell";
    this.stillSamples = [];
    this.stillStartedAt = undefined;
    this.clearSegmenter();
  }

  private pushSegmenter(sample: CapturedMotion): void {
    if (!this.neutral) return;
    if (!this.previous) {
      this.previous = sample;
      this.neutralStableSince = this.isNeutral(vector(sample))
        ? sample.browserMs
        : undefined;
      return;
    }

    const current = vector(sample);
    const previous = vector(this.previous);
    const delta = magnitude(subtract(current, previous));
    const stableThreshold = Math.max(24, this.noiseRms * 3);
    const activityThreshold = Math.max(45, this.noiseRms * 6);
    const residual = magnitude(subtract(current, this.neutral));
    const angle = angleDegrees(current, this.neutral);

    if (!this.candidate) {
      if (
        this.armed &&
        (delta > activityThreshold || residual > 180 || angle > 8)
      ) {
        this.candidate = {
          startMs: sample.browserMs,
          samples: [this.previous, sample],
        };
        this.armed = false;
        this.neutralStableSince = undefined;
        return;
      }
      if (this.isNeutral(current) && delta <= stableThreshold) {
        this.neutralStableSince ??= this.previous.browserMs;
        if (sample.browserMs - this.neutralStableSince >= REST_MS)
          this.armed = true;
      } else {
        this.neutralStableSince = undefined;
        if (!this.isNeutral(current)) this.armed = false;
      }
      return;
    }

    this.candidate.samples.push(sample);
    const elapsed = sample.browserMs - this.candidate.startMs;
    if (elapsed > MOVEMENT_MAX_MS + SETTLE_MS) {
      this.rejectCandidate("Gesture exceeded the 900 ms movement limit");
      return;
    }
    if (delta <= stableThreshold) this.candidate.settleStartMs ??= sample.browserMs;
    else this.candidate.settleStartMs = undefined;

    if (
      this.candidate.settleStartMs !== undefined &&
      sample.browserMs - this.candidate.settleStartMs >= SETTLE_MS
    ) {
      const duration = this.candidate.settleStartMs - this.candidate.startMs;
      if (duration < MOVEMENT_MIN_MS || duration > MOVEMENT_MAX_MS) {
        this.rejectCandidate("Gesture movement must last 150–900 ms");
        return;
      }
      this.completeCandidate(this.candidate, this.candidate.settleStartMs);
      this.candidate = undefined;
      this.armed = false;
      this.neutralStableSince = this.isNeutral(current)
        ? sample.browserMs
        : undefined;
    }
  }

  private completeCandidate(candidate: Candidate, endMs: number): void {
    const features = this.features(candidate, endMs);
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
      return;
    }
    const match = matches[0];
    this.lastIssue = "";
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
    const smoothed = movement.map((_, index) => {
      const first = Math.max(0, index - 1);
      const last = Math.min(movement.length - 1, index + 1);
      return mean(movement.slice(first, last + 1).map(vector));
    });
    const offsets = smoothed.map((value) => subtract(value, this.neutral!));
    const energy: Vector = [
      offsets.reduce((total, value) => total + value[0] ** 2, 0),
      offsets.reduce((total, value) => total + value[1] ** 2, 0),
      offsets.reduce((total, value) => total + value[2] ** 2, 0),
    ];
    const dominantAxis = energy.indexOf(Math.max(...energy)) as Axis;
    const totalEnergy = energy[0] + energy[1] + energy[2];
    const axisValues = offsets.map((value) => value[dominantAxis]);
    const peakValue = axisValues.reduce((best, value) =>
      Math.abs(value) > Math.abs(best) ? value : best,
    );
    const settled = candidate.samples.filter((sample) => sample.browserMs >= endMs);
    const finalVector = mean(settled.map(vector));
    return {
      startMs: candidate.startMs,
      endMs,
      durationMs: endMs - candidate.startMs,
      dominantAxis,
      dominantRatio: totalEnergy > 0 ? energy[dominantAxis] / totalEnergy : 0,
      peak: Math.abs(peakValue),
      peakSign: peakValue >= 0 ? 1 : -1,
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
      this.lastIssue = issue;
      return;
    }
    const examples = this.examples.get(spell) ?? [];
    examples.push(features);
    this.examples.set(spell, examples);
    this.lastIssue = `${examples.length}/3 ${spell} examples captured`;
    if (examples.length < 3) return;

    if (spell === "protego") {
      this.templates.set(spell, {
        kind: "guard",
        direction: normalized(mean(examples.map((example) => example.finalDirection))),
      });
    } else {
      this.templates.set(spell, {
        kind: "impulse",
        axis: examples[0].dominantAxis,
        sign: examples[0].peakSign,
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
  ): string | undefined {
    if (features.startAngleDeg > NEUTRAL_DEGREES)
      return "Begin each coached gesture from the calibrated neutral grip";
    const prior = this.examples.get(spell) ?? [];
    if (spell === "protego") {
      if (features.finalAngleDeg < GUARD_DEGREES)
        return "Protego must finish in a stable tilt of at least 25 degrees";
      if (
        prior.length > 0 &&
        dot(features.finalDirection, prior[0].finalDirection) < 0.8
      )
        return "Protego examples must use a consistent tilt direction";
      return undefined;
    }
    if (features.dominantRatio < DOMINANT_RATIO)
      return "Impulse examples need at least 65% energy on one axis";
    if (features.finalAngleDeg > NEUTRAL_DEGREES)
      return "Impulse examples must return within 20 degrees of neutral";
    if (features.peak < 250) return "Impulse example was too small to calibrate";
    if (
      prior.some(
        (example) =>
          example.dominantAxis !== features.dominantAxis ||
          example.peakSign !== features.peakSign,
      )
    )
      return "Impulse examples must keep the same dominant axis and direction";
    const stupefy = this.templates.get("stupefy");
    if (
      spell === "expelliarmus" &&
      stupefy?.kind === "impulse" &&
      stupefy.axis === features.dominantAxis
    )
      return "Expelliarmus must use a different dominant axis from Stupefy";
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
      if (features.finalAngleDeg < GUARD_DEGREES || direction < 0.8)
        return undefined;
      return clamp01(
        0.5 +
          (features.finalAngleDeg - GUARD_DEGREES) / 50 +
          (direction - 0.8),
      );
    }
    const minimumPeak = Math.max(180, template.typicalPeak * 0.5);
    if (
      features.dominantAxis !== template.axis ||
      features.peakSign !== template.sign ||
      features.dominantRatio < DOMINANT_RATIO ||
      features.finalAngleDeg > NEUTRAL_DEGREES ||
      features.peak < minimumPeak
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
    return this.neutral !== undefined && angleDegrees(value, this.neutral) <= NEUTRAL_DEGREES;
  }

  private rejectCandidate(reason: string): void {
    this.lastIssue = reason;
    this.candidate = undefined;
    this.armed = false;
    this.neutralStableSince = undefined;
  }

  private updateReadyPhase(): void {
    this.phase = [...this.enabledSpells].every((spell) => this.templates.has(spell))
      ? "ready"
      : "gesture-calibration";
  }

  private clearSegmenter(): void {
    this.previous = undefined;
    this.neutralStableSince = undefined;
    this.armed = false;
    this.candidate = undefined;
  }
}
