import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";
import {
  dtwDistance,
  prepareImpulseTrace,
  type PreparedImpulseTrace,
} from "./dtw";
import { CORE_SPELL_NAMES, SPELL_NAMES, SPELLS as SPELL_INFO, type GestureKind, type SpellName } from "../game/spells";

export type { SpellName };

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
  | "return-neutral" | "too-long" | "unclear-direction" | "too-small"
  | "inconsistent-direction" | "guard-tilt" | "no-match" | "ambiguous";

/** Diagnostics keep the version-2 wire shape the deployed phone service validates. */
export type MotionStopEvidence = "opposite" | "release" | "none";

export type MotionDiagnostics = {
  version: 2;
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
type Sample = { t: number; a: Vector; jerk: number };
type Burst = {
  startMs: number;
  rest: Vector;            // pose the movement started from (frozen)
  samples: Sample[];
  peak: number;
  peakAt: number;
  peakIndex: number;
  earlyEvaluated: boolean; // the fast impulse path already looked at this movement
  settled: boolean;        // a spell was resolved early; the rest of the burst is ignored
};
type Features = {
  startMs: number;
  endMs: number;
  durationMs: number;
  direction: Vector;       // signed device-frame direction of the strongest stroke
  dominantRatio: number;
  peak: number;
  lobeMs: number;          // how long the strongest stroke stayed above half its peak
  tiltDeg: number;         // orientation change from the starting pose to the held end pose
  tiltDirection: Vector;   // device-frame direction of that orientation change
  startPose: Vector;       // resting pose the movement started from
  endPose: Vector;         // pose held (or reached) at the end
  endQuiet: boolean;       // the movement ended in a still hold (guards need this)
  impulseTrace: PreparedImpulseTrace;
};
type ImpulseTemplate = {
  kind: "impulse";
  direction: Vector;
  traces: readonly PreparedImpulseTrace[];
  peak: number;
  acceptanceDistance: number;
};
type GuardTemplate = { kind: "guard"; direction: Vector; tiltDeg: number; peak: number };
type GestureTemplate = ImpulseTemplate | GuardTemplate;

const SPELLS: readonly SpellName[] = SPELL_NAMES;
const CORE_SPELLS: readonly SpellName[] = CORE_SPELL_NAMES;
const EXAMPLES_PER_SPELL = 3;
const kindOf = (spell: SpellName | undefined): GestureKind | undefined => (spell ? SPELL_INFO[spell].gesture : undefined);

// Wii-remote style segmentation: a movement starts on a sharp change, continues through any number of
// strokes, and ends when the wand is held still again in whatever pose it ended up. Nothing requires
// returning to the calibrated pose; the resting reference follows the player's hand while it is quiet.
const STILLNESS_MS = 1_500;
const RESUME_MS = 1_000;
const ARM_MS = 250;                 // quiet before a new movement may start
const QUIET_WINDOW_MS = 200;        // trailing still window that ends a movement
const QUIET_JERK_MG = 140;          // per 20 ms; resting hands measure well under 100
const QUIET_SPREAD_MG = 150;
const ONSET_JERK_MG = 180;          // two consecutive samples, or one sample above the single threshold
const ONSET_JERK_SINGLE_MG = 450;
const ONSET_LINEAR_MG = 450;        // weak movements still start a candidate so coaching can say "harder"
const ONSET_TILT_DEG = 15;          // a slow deliberate raise still starts a movement
const MAX_GAP_MS = 150;
const MOVEMENT_MAX_MS = 2_000;
const IMPULSE_EARLY_PEAK_MG = 800;  // strokes this strong resolve without waiting for stillness
const IMPULSE_SETTLE_MS = 120;
const IMPULSE_SETTLE_JERK_MG = 250; // the stroke is over once the wand stops accelerating sharply
const IMPULSE_MIN_PEAK_MG = 600;    // calibration floor for a jab or sweep
const IMPULSE_MIN_LOBE_MS = 60;     // a stroke has to last three samples; a twitch does not
const PLAY_MIN_PEAK_MG = 400;
const CANDIDATE_MIN_PEAK_MG = 150;  // below this a "movement" is just the hand drifting
const COACH_MIN_MS = 150;           // shorter, weaker movements get no coaching at all
const GUARD_MIN_TILT_DEG = 22;
const GUARD_MIN_PEAK_MG = 200;
const DIRECTION_TOLERANCE_DEG = 40;
const GUARD_TOLERANCE_DEG = 45;
const LOWERING_DEG = 120;           // a tilt this far from the guard template is the guard being lowered
const REORIENTATION_SLACK = 1.3;    // a stroke no stronger than its own gravity change is a re-orientation, not a jab
const GUARD_PREFER_PEAK_MG = 1_500; // below this a matching guard beats a matching impulse
const AWAY_FROM_GRIP_DEG = 8;       // guard examples must move the hand away from the resting grip on average
const CONSISTENCY_DEG = 50;
const SEPARATION_DEG = 50;
const DTW_AMBIGUITY_MARGIN = 0.12;
const DTW_MIN_ACCEPTANCE_DISTANCE = 0.3;
const DTW_MAX_ACCEPTANCE_DISTANCE = 0.55;
const DTW_COHESION_SCALE = 2.5;
const DTW_ARC_CONSISTENCY = 0.55;   // a circle example may differ from the earlier ones by at most this trace distance
const IMPULSE_EARLY_DECAY = 0.8;    // the fast path needs the pull to have died away; a circle keeps pulling
const REST_TAU_MS = 500;
const LOBE_FRACTION = 0.5;

function vector(sample: CapturedMotion): Vector {
  return [sample.axMg, sample.ayMg, sample.azMg];
}
function add(l: Vector, r: Vector): Vector { return [l[0] + r[0], l[1] + r[1], l[2] + r[2]]; }
function subtract(l: Vector, r: Vector): Vector { return [l[0] - r[0], l[1] - r[1], l[2] - r[2]]; }
function scale(v: Vector, k: number): Vector { return [v[0] * k, v[1] * k, v[2] * k]; }
function dot(l: Vector, r: Vector): number { return l[0] * r[0] + l[1] * r[1] + l[2] * r[2]; }
function magnitude(v: Vector): number { return Math.sqrt(dot(v, v)); }
function normalized(v: Vector): Vector {
  const length = magnitude(v);
  return length > 0 ? scale(v, 1 / length) : [0, 0, 0];
}
function mean(values: readonly Vector[]): Vector {
  return values.length ? scale(values.reduce(add, [0, 0, 0] as Vector), 1 / values.length) : [0, 0, 0];
}
function angleDegrees(l: Vector, r: Vector): number {
  const divisor = magnitude(l) * magnitude(r);
  if (divisor === 0) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, dot(l, r) / divisor))) * 180) / Math.PI;
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function stopEvidence(how: "early" | "quiet"): MotionStopEvidence { return how === "early" ? "opposite" : "release"; }
function spellCounts(): Record<SpellName, number> {
  return Object.fromEntries(SPELLS.map((spell) => [spell, 0])) as Record<SpellName, number>;
}

export class MotionRecognizer {
  private phase: MotionRecognizerPhase = "uncalibrated";
  private generation?: number;
  private neutral?: Vector;
  private noiseRms = 0;
  private calibratingSpell?: SpellName;
  private readonly examples = new Map<SpellName, Features[]>();
  private readonly templates = new Map<SpellName, GestureTemplate>();
  private enabledSpells = new Set<SpellName>(CORE_SPELLS);
  private previous?: CapturedMotion;
  private window: Sample[] = [];
  private rest?: Vector;
  private quietSince?: number;
  private armed = false;   // latched once the hand has been still for ARM_MS; cleared when a movement starts
  private burst?: Burst;
  private rejectedGuardReturn?: Vector;  // after a rejected raise, the lowering that undoes it is expected next
  private evidenceSequence = 0;
  private lastIssue = "";
  private reason?: MotionRejectionReason;
  private progress: MotionRecognizerState["progress"] = "hold-still";
  private progressMs = 0;
  private progressTargetMs = STILLNESS_MS;
  private lastCandidate?: MotionDiagnostics["candidate"];

  constructor(private readonly onGesture: (evidence: GestureEvidence) => void) {}

  beginCalibration(): void {
    this.reset("Hold your wand still");
    this.phase = "stillness";
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
    this.lastIssue = "Hold your wand still for a moment";
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
    this.lastIssue = SPELL_INFO[spell].calibration;
    this.reason = undefined;
    this.lastCandidate = undefined;
    this.clearSegmenter();
    this.setProgress("armed", 0, ARM_MS);
  }

  setEnabledSpells(spells: readonly SpellName[]): void {
    const next = new Set(spells);
    if (next.size !== spells.length || spells.some((spell) => !SPELLS.includes(spell)))
      throw new Error("Enabled spells must be unique supported spell names");
    for (const spell of next)
      if (!this.templates.has(spell)) throw new Error(`Calibrate ${SPELL_INFO[spell].title} before enabling it`);
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
      this.breakContinuity("Non-finite motion sample", "invalid-sample");
      return;
    }
    if (!(sample.flags & MotionFlag.Valid) || sample.flags & (MotionFlag.Saturated | MotionFlag.Discontinuity)) {
      this.breakContinuity("Invalid, saturated or discontinuous motion", "invalid-sample");
      return;
    }
    const gap = this.previous ? sample.browserMs - this.previous.browserMs : undefined;
    if (gap !== undefined && (gap <= 0 || gap > MAX_GAP_MS))
      this.breakContinuity(gap > MAX_GAP_MS ? "Motion gap exceeded 150 ms" : "Motion timestamps were not monotonic", "motion-gap");
    if (sample.breaksGesture) this.breakContinuity("Motion source marked a gesture break", "motion-gap");

    const current = this.observe(sample);
    this.previous = sample;
    if (this.phase === "stillness") this.pushStillness(current);
    else if (this.phase === "resuming") this.pushResume(current);
    else if (this.calibratingSpell || this.phase === "ready") this.pushSegmenter(current);
  }

  clearPending(reason = ""): void {
    this.clearSegmenter();
    this.lastIssue = reason;
    this.reason = undefined;
    this.lastCandidate = undefined;
  }

  reset(reason = ""): void {
    this.phase = "uncalibrated";
    this.generation = undefined;
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
    this.rest = undefined;
  }

  getState(): MotionRecognizerState {
    const counts = spellCounts();
    for (const spell of SPELLS) counts[spell] = this.examples.get(spell)?.length ?? 0;
    return {
      phase: this.phase,
      generation: this.generation,
      stillnessMs: this.phase === "stillness" ? this.quietElapsed() : this.neutral ? STILLNESS_MS : 0,
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
    return { version: 2, neutralMg: this.neutral, noiseMg: this.noiseRms, candidate: this.lastCandidate };
  }

  // ---------------------------------------------------------------------------------------------
  // Sample conditioning

  private isFiniteSample(sample: CapturedMotion): boolean {
    return [sample.browserMs, sample.ageUpperMs, sample.axMg, sample.ayMg, sample.azMg].every(Number.isFinite);
  }

  private observe(sample: CapturedMotion): Sample {
    const a = vector(sample);
    const last = this.window[this.window.length - 1];
    const dt = last ? sample.browserMs - last.t : 0;
    // Sample-to-sample change normalised to a 20 ms step: orientation drift barely registers,
    // a real stroke does, and it is immune to whatever pose the hand has drifted into.
    const jerk = last && dt > 0 ? (magnitude(subtract(a, last.a)) * 20) / Math.max(dt, 5) : 0;
    const current: Sample = { t: sample.browserMs, a, jerk };
    this.window.push(current);
    const keep = Math.max(QUIET_WINDOW_MS, RESUME_MS, STILLNESS_MS) + 100;
    while (this.window.length > 2 && this.window[0].t < sample.browserMs - keep) this.window.shift();
    return current;
  }

  private breakContinuity(reason: string, code: MotionRejectionReason): void {
    this.lastIssue = reason;
    this.reason = code;
    this.burst = undefined;
    this.window = [];
    this.quietSince = undefined;
    this.armed = false;
    this.previous = undefined;
    this.lastCandidate = undefined;
    if (this.phase === "stillness") this.setProgress("hold-still", 0, STILLNESS_MS);
    else if (this.phase === "resuming") this.setProgress("return-neutral", 0, RESUME_MS);
    else this.setProgress("armed", 0, ARM_MS);
  }

  /** Trailing samples covering `duration` ms ending at the latest sample, if the window has them. */
  private trailing(duration: number, notBefore = -Infinity): Sample[] | undefined {
    const end = this.window[this.window.length - 1]?.t;
    if (end === undefined) return undefined;
    const start = end - duration;
    if (start < notBefore) return undefined;
    const slice = this.window.filter((sample) => sample.t >= start);
    if (slice.length < 4 || slice[0].t > start + 40) return undefined;
    return slice;
  }

  private isQuiet(slice: readonly Sample[]): boolean {
    const center = mean(slice.map((sample) => sample.a));
    let spread = 0, jerk = 0;
    for (let index = 0; index < slice.length; index++) {
      spread = Math.max(spread, magnitude(subtract(slice[index].a, center)));
      if (index > 0) jerk = Math.max(jerk, slice[index].jerk);
    }
    return jerk < QUIET_JERK_MG && spread < QUIET_SPREAD_MG;
  }

  private quietElapsed(): number {
    const end = this.window[this.window.length - 1]?.t;
    return end === undefined || this.quietSince === undefined ? 0 : Math.max(0, end - this.quietSince);
  }

  /** Extend or restart the quiet run; returns the current quiet duration. */
  private trackQuiet(current: Sample): number {
    const slice = this.trailing(QUIET_WINDOW_MS);
    if (!slice || !this.isQuiet(slice)) {
      this.quietSince = undefined;
      return 0;
    }
    const center = mean(slice.map((sample) => sample.a));
    if (this.quietSince === undefined || !this.rest) {
      // A fresh still run (after a movement, a gap or a reconnect) re-anchors the resting pose at once;
      // a lagging reference would otherwise read the next raise as already under way.
      this.quietSince = slice[0].t;
      this.rest = center;
    } else {
      const k = Math.min(1, (current.t - (this.window[this.window.length - 2]?.t ?? current.t)) / REST_TAU_MS);
      this.rest = add(this.rest, scale(subtract(center, this.rest), k));
    }
    return current.t - this.quietSince;
  }

  // ---------------------------------------------------------------------------------------------
  // Calibration phases

  private pushStillness(current: Sample): void {
    const quiet = this.trackQuiet(current);
    this.setProgress("hold-still", Math.min(quiet, STILLNESS_MS), STILLNESS_MS);
    if (quiet === 0) {
      this.lastIssue = "Keep still; the timer restarts on its own";
      this.reason = "keep-still";
      return;
    }
    if (quiet < STILLNESS_MS) return;
    const slice = this.trailing(STILLNESS_MS)!;
    const neutral = mean(slice.map((sample) => sample.a));
    const gravity = magnitude(neutral);
    if (gravity < 700 || gravity > 1_300) {
      this.lastIssue = "Hold the wand still in a comfortable grip";
      this.reason = "invalid-gravity";
      this.quietSince = undefined;
      return;
    }
    let energy = 0;
    for (const sample of slice) energy += dot(subtract(sample.a, neutral), subtract(sample.a, neutral));
    this.neutral = neutral;
    this.rest = neutral;
    this.noiseRms = Math.sqrt(energy / slice.length);
    this.phase = "gesture-calibration";
    this.lastIssue = "Grip learned";
    this.reason = undefined;
    this.clearSegmenter();
    this.setProgress("armed", 0, ARM_MS);
  }

  private pushResume(current: Sample): void {
    const quiet = this.trackQuiet(current);
    this.setProgress("return-neutral", Math.min(quiet, RESUME_MS), RESUME_MS);
    if (quiet === 0) {
      this.reason = "keep-still";
      return;
    }
    if (quiet < RESUME_MS) return;
    this.phase = "ready";
    this.clearSegmenter();
    this.lastIssue = "";
    this.reason = undefined;
    this.setProgress("ready", RESUME_MS, RESUME_MS);
  }

  // ---------------------------------------------------------------------------------------------
  // Segmenter

  private pushSegmenter(current: Sample): void {
    if (!this.rest) this.rest = this.neutral;
    if (!this.burst) {
      const quiet = this.trackQuiet(current);
      if (quiet >= ARM_MS) this.armed = true;
      if (this.armed && this.onset(current)) {
        const rest = this.rest!;
        const previous = this.window[this.window.length - 2];
        const lead = previous && current.t - previous.t <= MAX_GAP_MS ? [previous, current] : [current];
        this.burst = { startMs: lead[0].t, rest, samples: lead, peak: 0, peakAt: lead[0].t, peakIndex: 0, earlyEvaluated: false, settled: false };
        this.quietSince = undefined;
        this.armed = false;
        for (let index = 0; index < lead.length; index++) this.trackPeak(this.burst, index);
        this.setProgress("moving", 0, MOVEMENT_MAX_MS);
        return;
      }
      this.setProgress("armed", this.armed ? ARM_MS : Math.min(quiet, ARM_MS), ARM_MS);
      return;
    }

    const burst = this.burst;
    burst.samples.push(current);
    this.trackPeak(burst, burst.samples.length - 1);
    const elapsed = current.t - burst.startMs;
    const slice = this.trailing(QUIET_WINDOW_MS, burst.startMs + 20);
    const quiet = slice !== undefined && this.isQuiet(slice);
    if (quiet) this.setProgress("settling", QUIET_WINDOW_MS, QUIET_WINDOW_MS);
    else this.setProgress("moving", elapsed, MOVEMENT_MAX_MS);

    const calibratingKind = kindOf(this.calibratingSpell);
    if (!burst.earlyEvaluated && calibratingKind !== "guard" && calibratingKind !== "arc" && this.impulseComplete(burst, current)) {
      // Fast path for strong strokes. A stroke that is not a spell yet (e.g. a brisk guard raise) is
      // left for the still end, where tilt and hold can be judged.
      burst.earlyEvaluated = true;
      if (this.complete(this.features(burst, current.t, false), "early")) burst.settled = true;
    }
    if (quiet) {
      const features = this.features(burst, slice![0].t, true);
      const center = mean(slice!.map((sample) => sample.a));
      this.burst = undefined;
      this.rest = center;
      this.quietSince = slice![0].t;
      if (!burst.settled) this.complete(features, "quiet");
      else this.setProgress("armed", 0, ARM_MS);
      return;
    }
    if (elapsed > MOVEMENT_MAX_MS) {
      const features = this.features(burst, current.t, false);
      this.burst = undefined;
      this.quietSince = undefined;
      if (!burst.settled) {
        if (features.peak >= CANDIDATE_MIN_PEAK_MG) this.rejectCandidate(features, "Pause between spells so each one can settle", "too-long");
      }
      this.setProgress("armed", 0, ARM_MS);
    }
  }

  private onset(current: Sample): boolean {
    const previous = this.window[this.window.length - 2];
    const rest = this.rest!;
    if (current.jerk >= ONSET_JERK_SINGLE_MG) return true;
    if (previous && current.jerk >= ONSET_JERK_MG && previous.jerk >= ONSET_JERK_MG) return true;
    if (magnitude(subtract(current.a, rest)) >= ONSET_LINEAR_MG) return true;
    const recent = this.window.slice(-3);
    return recent.length === 3 && angleDegrees(mean(recent.map((sample) => sample.a)), rest) >= ONSET_TILT_DEG;
  }

  private trackPeak(burst: Burst, index: number): void {
    const sample = burst.samples[index];
    const linear = magnitude(subtract(sample.a, burst.rest));
    if (linear > burst.peak) {
      burst.peak = linear;
      burst.peakAt = sample.t;
      burst.peakIndex = index;
    }
  }

  private impulseComplete(burst: Burst, current: Sample): boolean {
    if (burst.peak < IMPULSE_EARLY_PEAK_MG || current.t - burst.peakAt < IMPULSE_SETTLE_MS) return false;
    // Pose-independent: the hand may still be rotated; the stroke is over when sharp acceleration is.
    const since = current.t - 100;
    const tail = burst.samples.filter((sample) => sample.t >= since);
    if (tail.length < 3 || !tail.every((sample) => sample.jerk < IMPULSE_SETTLE_JERK_MG)) return false;
    // A stroke's acceleration dies away after its brake; a circle keeps pulling the whole way round.
    return magnitude(subtract(current.a, burst.rest)) <= burst.peak * IMPULSE_EARLY_DECAY;
  }

  private features(burst: Burst, endMs: number, endQuiet: boolean): Features {
    const movement = burst.samples.filter((sample) => sample.t <= endMs);
    const linear = movement.map((sample) => subtract(sample.a, burst.rest));
    const peakIndex = Math.min(burst.peakIndex, movement.length - 1);
    const peak = burst.peak;
    const floor = peak * LOBE_FRACTION;
    let from = peakIndex, to = peakIndex;
    while (from > 0 && magnitude(linear[from - 1]) >= floor) from--;
    while (to < linear.length - 1 && magnitude(linear[to + 1]) >= floor) to++;
    // Cubic weighting keeps the direction anchored on the strongest part of the stroke rather than
    // on the wind-up and follow-through that rotate around it.
    let weighted: Vector = [0, 0, 0], energy = 0;
    for (let index = from; index <= to; index++) {
      const value = linear[index], size = magnitude(value);
      weighted = add(weighted, scale(value, size * size * size));
      energy += size * size;
    }
    const direction = normalized(weighted);
    const lobeMs = to > from ? movement[to].t - movement[from].t + 20 : 20;
    let along = 0;
    for (let index = from; index <= to; index++) along += dot(linear[index], direction) ** 2;
    const tailStart = endMs - 100;
    const tail = burst.samples.filter((sample) => sample.t >= tailStart && sample.t <= endMs + QUIET_WINDOW_MS);
    const endPose = tail.length ? mean(tail.map((sample) => sample.a)) : movement[movement.length - 1].a;
    return {
      startMs: burst.startMs,
      endMs,
      durationMs: endMs - burst.startMs,
      direction,
      dominantRatio: energy > 0 ? along / energy : 0,
      peak,
      lobeMs,
      tiltDeg: angleDegrees(burst.rest, endPose),
      tiltDirection: normalized(subtract(endPose, burst.rest)),
      startPose: burst.rest,
      endPose,
      endQuiet,
      impulseTrace: prepareImpulseTrace(linear),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Completion, calibration and classification

  /** Returns true when the movement was resolved (spell emitted or calibration example judged). */
  private complete(features: Features, how: "early" | "quiet"): boolean {
    if (features.peak < CANDIDATE_MIN_PEAK_MG) {
      this.setProgress("armed", 0, ARM_MS);
      return how === "quiet";  // the hand drifted; not a movement anyone meant
    }
    if (this.calibratingSpell) {
      this.recordCandidate(features, stopEvidence(how), "candidate");
      this.acceptCalibrationExample(this.calibratingSpell, features, how);
      return true;
    }
    if (this.phase !== "ready" || this.generation === undefined) return true;
    const match = this.classify(features);
    if (!match.spell) {
      if (how === "early") return false;  // not a jab or sweep; judge it as a possible guard when it settles
      this.recordCandidate(features, "release", "candidate");
      if (match.reason !== undefined) {
        this.reason = match.reason;
        this.lastIssue = match.message;
        this.recordCandidate(features, "release", match.reason);
      }
      this.setProgress("armed", 0, ARM_MS);
      return true;
    }
    this.lastIssue = "";
    this.reason = undefined;
    this.recordCandidate(features, stopEvidence(how), "accepted");
    this.setProgress("ready", ARM_MS, ARM_MS);
    this.onGesture({
      id: `${this.generation}:gesture:${++this.evidenceSequence}`,
      generation: this.generation,
      spell: match.spell,
      startMs: features.startMs,
      endMs: features.endMs,
      quality: match.quality,
    });
    return true;
  }

  private acceptCalibrationExample(spell: SpellName, features: Features, how: "early" | "quiet"): void {
    const issue = this.calibrationIssue(spell, features, how);
    if (issue === "ignore") {
      this.setProgress("armed", 0, ARM_MS);
      return;
    }
    if (issue) {
      this.lastIssue = issue.message;
      this.reason = issue.reason;
      this.recordCandidate(features, stopEvidence(how), issue.reason);
      this.setProgress("armed", 0, ARM_MS);
      if (kindOf(spell) === "guard" && features.tiltDeg >= ONSET_TILT_DEG)
        this.rejectedGuardReturn = scale(features.tiltDirection, -1);
      return;
    }
    this.rejectedGuardReturn = undefined;
    const examples = this.examples.get(spell) ?? [];
    examples.push(features);
    this.examples.set(spell, examples);
    this.reason = undefined;
    this.recordCandidate(features, stopEvidence(how), "accepted");
    this.setProgress("ready", ARM_MS, ARM_MS);
    if (examples.length < EXAMPLES_PER_SPELL) {
      this.lastIssue = `${examples.length} of ${EXAMPLES_PER_SPELL}. ${SPELL_INFO[spell].again}`;
      return;
    }
    if (kindOf(spell) === "guard") {
      // Three "raises" that on average bring the hand back toward the resting grip were lowerings
      // (the wand was already up when calibration started): start again from the grip.
      const neutral = this.neutral;
      if (neutral) {
        const away = examples.reduce((sum, example) => sum + angleDegrees(example.endPose, neutral) - angleDegrees(example.startPose, neutral), 0) / examples.length;
        if (away < -AWAY_FROM_GRIP_DEG) {
          this.examples.set(spell, []);
          this.lastIssue = "Start from your resting grip, then raise and hold.";
          this.reason = "return-neutral";
          return;
        }
      }
      this.templates.set(spell, {
        kind: "guard",
        direction: normalized(mean(examples.map((example) => example.tiltDirection))),
        tiltDeg: median(examples.map((example) => example.tiltDeg)),
        peak: median(examples.map((example) => example.peak)),
      });
    } else {
      const traces = examples.map((example) => example.impulseTrace);
      const pairwiseDistances: number[] = [];
      for (let left = 0; left < traces.length; left++)
        for (let right = left + 1; right < traces.length; right++)
          pairwiseDistances.push(dtwDistance(traces[left], traces[right]));
      this.templates.set(spell, {
        kind: "impulse",
        direction: normalized(mean(examples.map((example) => example.direction))),
        traces,
        peak: median(examples.map((example) => example.peak)),
        acceptanceDistance: Math.min(
          DTW_MAX_ACCEPTANCE_DISTANCE,
          Math.max(
            DTW_MIN_ACCEPTANCE_DISTANCE,
            median(pairwiseDistances) * DTW_COHESION_SCALE,
          ),
        ),
      });
    }
    // A learned spell is a playable spell; Reset grip or a new stream clears it again.
    this.enabledSpells.add(spell);
    this.calibratingSpell = undefined;
    this.updateReadyPhase();
    this.lastIssue = this.phase === "ready" ? "" : `${SPELL_INFO[spell].title} learned`;
  }

  private calibrationIssue(spell: SpellName, features: Features, how: "early" | "quiet"):
    { message: string; reason: MotionRejectionReason } | "ignore" | undefined {
    const info = SPELL_INFO[spell];
    const prior = this.examples.get(spell) ?? [];
    if (info.gesture === "guard") {
      if (how === "early" || !features.endQuiet) return "ignore";
      // The first held tilt defines the raise, wherever the hand happens to rest; each lowering
      // afterwards points the opposite way and is ignored rather than coached. The lowering that
      // undoes a *rejected* raise is expected too, so it can never seed the template.
      if (this.rejectedGuardReturn && angleDegrees(features.tiltDirection, this.rejectedGuardReturn) <= 60) {
        this.rejectedGuardReturn = undefined;
        return "ignore";
      }
      if (prior.length && angleDegrees(features.tiltDirection, mean(prior.map((example) => example.tiltDirection))) > LOWERING_DEG)
        return "ignore";
      for (const other of this.calibratedImpulses())
        if (other.template.kind === "impulse" && kindOf(other.spell) === "impulse" &&
          angleDegrees(features.direction, other.template.direction) <= DIRECTION_TOLERANCE_DEG && features.peak >= other.template.peak * 0.5)
          return { message: `That looked like ${SPELL_INFO[other.spell].title}. Raise your wand into a guard and hold it.`, reason: "unclear-direction" };
      if (features.peak < GUARD_MIN_PEAK_MG) {
        if (features.tiltDeg < GUARD_MIN_TILT_DEG) return "ignore";  // the hand drifting, not an attempt
        return { message: info.harder, reason: "too-small" };
      }
      if (features.tiltDeg < GUARD_MIN_TILT_DEG)
        return { message: "Raise your wand higher, then hold it still.", reason: "guard-tilt" };
      if (prior.length && angleDegrees(features.tiltDirection, mean(prior.map((example) => example.tiltDirection))) > CONSISTENCY_DEG)
        return { message: info.sameWay, reason: "inconsistent-direction" };
      return undefined;
    }
    if (features.durationMs > MOVEMENT_MAX_MS) return { message: "One movement, then pause.", reason: "too-long" };
    if (features.peak < IMPULSE_MIN_PEAK_MG || features.lobeMs < IMPULSE_MIN_LOBE_MS) {
      if (features.durationMs < COACH_MIN_MS && features.peak < IMPULSE_MIN_PEAK_MG) return "ignore";  // a twitch before the real stroke
      return { message: info.harder, reason: "too-small" };
    }
    if (info.gesture === "arc") {
      // A circle has no single direction: it is held together and kept apart by trace distance,
      // exactly the measure that recognizes it in play.
      if (how === "early" || !features.endQuiet) return "ignore";
      if (prior.length && median(prior.map((example) => dtwDistance(features.impulseTrace, example.impulseTrace))) > DTW_ARC_CONSISTENCY)
        return { message: info.sameWay, reason: "inconsistent-direction" };
      for (const other of this.calibratedImpulses(spell))
        if (median(other.template.traces.map((trace) => dtwDistance(features.impulseTrace, trace))) <= other.template.acceptanceDistance)
          return { message: `Too close to your ${SPELL_INFO[other.spell].title}. Draw a full round circle.`, reason: "inconsistent-direction" };
      return undefined;
    }
    if (features.dominantRatio < 0.35)
      return { message: "Make one clear stroke.", reason: "unclear-direction" };
    if (prior.length && angleDegrees(features.direction, mean(prior.map((example) => example.direction))) > CONSISTENCY_DEG)
      return { message: info.sameWay, reason: "inconsistent-direction" };
    for (const other of this.calibratedImpulses(spell)) {
      // Strokes stay apart by direction; a circle by trace distance, since its mean direction is
      // an accident of where it started.
      const apart = kindOf(other.spell) === "arc"
        ? median(other.template.traces.map((trace) => dtwDistance(features.impulseTrace, trace))) > other.template.acceptanceDistance
        : angleDegrees(other.template.direction, features.direction) >= SEPARATION_DEG;
      if (!apart)
        return { message: `Too close to your ${SPELL_INFO[other.spell].title}. Move in a clearly different direction.`, reason: "inconsistent-direction" };
    }
    return undefined;
  }

  private calibratedImpulses(except?: SpellName): { spell: SpellName; template: ImpulseTemplate }[] {
    const result: { spell: SpellName; template: ImpulseTemplate }[] = [];
    for (const [spell, template] of this.templates)
      if (spell !== except && template.kind === "impulse") result.push({ spell, template });
    return result;
  }

  private classify(features: Features): { spell?: SpellName; quality: number; reason?: MotionRejectionReason; message: string } {
    const impulses: { spell: SpellName; score: number; template: ImpulseTemplate }[] = [];
    let guard: { spell: SpellName; quality: number; template: GuardTemplate } | undefined;
    // A held tilt whose stroke is no stronger than its own gravity change is the wand being
    // re-oriented (raised or lowered), never a jab or sweep, whatever direction it points.
    const gravityChange = 2_000 * Math.sin((features.tiltDeg * Math.PI) / 360);
    const reorientation = features.endQuiet && features.tiltDeg >= GUARD_MIN_TILT_DEG && features.peak <= gravityChange * REORIENTATION_SLACK + 100;
    let lowering = false;
    for (const spell of this.enabledSpells) {
      const template = this.templates.get(spell);
      if (!template) continue;
      if (template.kind === "impulse") {
        if (reorientation) continue;
        if (features.lobeMs >= IMPULSE_MIN_LOBE_MS &&
          features.peak >= Math.max(PLAY_MIN_PEAK_MG, template.peak * 0.35)) {
          const score = median(template.traces.map((trace) => dtwDistance(features.impulseTrace, trace)));
          impulses.push({ spell, score, template });
        }
      } else if (features.endQuiet) {
        const angle = angleDegrees(features.tiltDirection, template.direction);
        if (features.tiltDeg >= GUARD_MIN_TILT_DEG && angle >= LOWERING_DEG) lowering = true;
        if (features.tiltDeg >= Math.max(GUARD_MIN_TILT_DEG, template.tiltDeg * 0.55) && angle <= GUARD_TOLERANCE_DEG &&
          features.peak >= Math.max(GUARD_MIN_PEAK_MG, template.peak * 0.3) && features.peak <= Math.max(template.peak * 4, 1_500))
          guard = { spell, template, quality: clamp01(0.5 + (features.tiltDeg - GUARD_MIN_TILT_DEG) / 60 + ((GUARD_TOLERANCE_DEG - angle) / GUARD_TOLERANCE_DEG) * 0.3) };
      }
    }
    if (lowering && !guard) return { quality: 0, message: "" };  // lowering the guard is never a cast
    impulses.sort((a, b) => a.score - b.score);
    const best = impulses[0];
    if (best && impulses[1] && impulses[1].score - best.score < DTW_AMBIGUITY_MARGIN)
      return { quality: 0, reason: "ambiguous", message: "That movement matched two spells. Make it clearer." };
    // A matching guard wins unless the stroke is far too strong to be a raise.
    if (best && best.score <= best.template.acceptanceDistance &&
      (!guard || features.peak > Math.max(guard.template.peak * 2, GUARD_PREFER_PEAK_MG))) {
      const quality = clamp01(0.75 - best.score / Math.max(best.template.acceptanceDistance, 0.001) * 0.5 +
        Math.min(0.25, features.peak / best.template.peak / 4));
      return { spell: best.spell, quality, message: "" };
    }
    if (guard) return { spell: guard.spell, quality: guard.quality, message: "" };
    const weak = features.peak < PLAY_MIN_PEAK_MG && features.tiltDeg < GUARD_MIN_TILT_DEG;
    return weak
      ? { quality: 0, message: "" }  // gentle fidgeting: no coaching needed
      : { quality: 0, reason: "no-match", message: "That movement did not match a spell." };
  }

  // ---------------------------------------------------------------------------------------------
  // Bookkeeping

  private setProgress(progress: MotionRecognizerState["progress"], elapsed: number, target: number): void {
    this.progress = progress;
    this.progressMs = Math.max(0, elapsed);
    this.progressTargetMs = target;
  }

  private recordCandidate(features: Features, stopEvidence: MotionStopEvidence, reason: string): void {
    const candidate = {
      startMs: features.startMs,
      endMs: features.endMs,
      durationMs: features.durationMs,
      peakMg: features.peak,
      dominantRatio: Math.min(1, features.dominantRatio),
      stopEvidence,
      finalAngleDeg: features.tiltDeg,
      reason,
    };
    if ([candidate.startMs, candidate.endMs, candidate.durationMs, candidate.peakMg, candidate.dominantRatio, candidate.finalAngleDeg].every(Number.isFinite))
      this.lastCandidate = candidate;
  }

  private rejectCandidate(features: Features, message: string, code: MotionRejectionReason): void {
    this.lastIssue = message;
    this.reason = code;
    this.recordCandidate(features, "none", code);
  }

  private updateReadyPhase(): void {
    if (this.phase === "resuming") return;
    this.phase = [...this.enabledSpells].every((spell) => this.templates.has(spell)) ? "ready" : "gesture-calibration";
  }

  private clearSegmenter(): void {
    this.previous = undefined;
    this.window = [];
    this.quietSince = undefined;
    this.armed = false;
    this.burst = undefined;
    this.rejectedGuardReturn = undefined;
  }
}
