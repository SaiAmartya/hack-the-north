import type { CapturedMotion } from "../wand/client";
import { MotionFlag } from "../wand/protocol";
import { CORE_SPELL_NAMES, SPELL_NAMES, SPELLS, type GestureKind, type SpellName } from "../game/spells";

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
  | "inconsistent-direction" | "too-similar" | "incomplete-circle" | "guard-tilt"
  | "no-match" | "ambiguous";

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
  direction: Vector;       // signed device-frame direction of the stroke: its launch, minus its brake
  dominantRatio: number;   // share of the stroke's energy that lies along that line
  peak: number;            // strongest acceleration away from the starting pose (gravity swing included)
  strokeMg: number;        // strongest acceleration once the gravity swing between start and end pose is removed
  lobeMs: number;          // how long the strongest stroke stayed above half its peak
  tiltDeg: number;         // orientation change from the starting pose to the held end pose
  tiltDirection: Vector;   // device-frame direction of that orientation change
  startPose: Vector;       // resting pose the movement started from
  endPose: Vector;         // pose held (or reached) at the end
  endQuiet: boolean;       // the movement ended in a still hold (guards need this)
  sweptDeg: number;        // how far the acceleration direction turned, one way round (circles)
  coherence: number;       // 1 when all of that turning shares one plane and one sense
  normal: Vector;          // signed normal of that plane (encodes the way round)
  meanMg: number;          // mean linear acceleration over the whole movement
};
type ImpulseTemplate = { kind: "impulse"; direction: Vector; peak: number; strokeMg: number };
type GuardTemplate = { kind: "guard"; direction: Vector; tiltDeg: number; peak: number };
type ArcTemplate = { kind: "arc"; normal: Vector; sweptDeg: number; meanMg: number };
type GestureTemplate = ImpulseTemplate | GuardTemplate | ArcTemplate;

const EXAMPLES_PER_SPELL = 3;
const kindOf = (spell: SpellName | undefined): GestureKind | undefined => (spell ? SPELLS[spell].gesture : undefined);

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
const IMPULSE_EARLY_DECAY = 0.8;    // ...and once its acceleration has died away; a circle keeps pulling
const IMPULSE_MIN_PEAK_MG = 600;    // calibration floor for a single stroke
const IMPULSE_MIN_LOBE_MS = 60;     // a stroke has to last three samples; a twitch does not
const IMPULSE_MAX_LOBE_MS = 500;    // a stroke longer than this is a push or a circle, not a jab
const IMPULSE_MAX_SWEPT_DEG = 200;  // a stroke whose direction turns this far is a circle, not a jab; a wrist
                                    // slash swings through the centripetal pull and reads as ~180
const PLAY_MIN_PEAK_MG = 400;
const CANDIDATE_MIN_PEAK_MG = 150;  // below this a "movement" is just the hand drifting
const COACH_MIN_MS = 150;           // shorter, weaker movements get no coaching at all
const GUARD_MIN_TILT_DEG = 22;
const GUARD_MIN_PEAK_MG = 200;
const DIRECTION_TOLERANCE_DEG = 40;
const GUARD_TOLERANCE_DEG = 45;
const LOWERING_DEG = 120;           // a tilt this far from the guard template is the guard being lowered
const REORIENTATION_SLACK = 1.3;    // a stroke no stronger than its own gravity change is a re-orientation, not a jab
const AWAY_FROM_GRIP_DEG = 8;       // guard examples must move the hand away from the resting grip on average
const CONSISTENCY_DEG = 50;
const SEPARATION_DEG = 50;          // every impulse spell keeps this far from every other
const AMBIGUITY_MARGIN_DEG = 15;
const ARC_FLOOR_MG = 150;           // samples weaker than this carry no usable direction for rotation
const ARC_MIN_SWEPT_DEG = 240;      // a circle must turn at least two thirds of the way round
const ARC_MIN_COHERENCE = 0.55;     // mostly one plane, one way round
const ARC_MIN_MEAN_MG = 200;
const ARC_MIN_MS = 350;
const ARC_TOLERANCE_DEG = 50;       // plane normal (and therefore sense) tolerance in play
const ARC_CONSISTENCY_DEG = 60;
const REST_TAU_MS = 500;
const LOBE_FRACTION = 0.5;
const STROKE_LOBE_FLOOR = 0.3;      // a launch or brake lobe is the run above this share of the line's peak
const STROKE_AXIS_SHARE = 0.25;     // a line must carry this share of the strongest line's energy to be the stroke
const STROKE_BRAKE_SHARE = 0.15;    // a following lobe with at least this share of the launch's impulse is its brake
const STROKE_PREFER_SHARE = 0.5;    // a stroke at least this strong (vs its template) beats a matching guard
const STROKE_MIN_DOMINANT = 0.2;    // wrist strokes carry a centripetal pull off the line; the line still has to matter

function vector(sample: CapturedMotion): Vector {
  return [sample.axMg, sample.ayMg, sample.azMg];
}
function add(l: Vector, r: Vector): Vector { return [l[0] + r[0], l[1] + r[1], l[2] + r[2]]; }
function subtract(l: Vector, r: Vector): Vector { return [l[0] - r[0], l[1] - r[1], l[2] - r[2]]; }
function scale(v: Vector, k: number): Vector { return [v[0] * k, v[1] * k, v[2] * k]; }
function dot(l: Vector, r: Vector): number { return l[0] * r[0] + l[1] * r[1] + l[2] * r[2]; }
function cross(l: Vector, r: Vector): Vector {
  return [l[1] * r[2] - l[2] * r[1], l[2] * r[0] - l[0] * r[2], l[0] * r[1] - l[1] * r[0]];
}
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
  return Object.fromEntries(SPELL_NAMES.map((spell) => [spell, 0])) as Record<SpellName, number>;
}

/**
 * Signed direction of one stroke. A stroke is a launch followed by a brake along one line, so its
 * sign is the launch's, whichever of the two happens to be sharper (a jab that stops dead brakes
 * harder than it launches; the old "strongest lobe" rule then read it backwards). Wrist strokes
 * also drag the sensor toward the wrist the whole way round (centripetal, one sign, often stronger
 * than the stroke itself); that pull sits in launch and brake alike, so launch minus brake cancels
 * it, and the line of the stroke is the axis carrying the most two-signed energy, not the most
 * energy. A movement with one lobe only (a push, the lift of a raise) keeps that lobe's sign.
 */
function strokeDirection(linear: readonly Vector[], times: readonly number[]): { direction: Vector; peak: number; lobeMs: number; dominantRatio: number } {
  const sizes = linear.map(magnitude);
  let peakIndex = 0;
  for (let index = 1; index < sizes.length; index++) if (sizes[index] > sizes[peakIndex]) peakIndex = index;
  const peak = sizes[peakIndex] ?? 0;
  if (peak === 0) return { direction: [0, 0, 0], peak: 0, lobeMs: 20, dominantRatio: 0 };
  const floor = peak * LOBE_FRACTION;
  let from = peakIndex, to = peakIndex;
  while (from > 0 && sizes[from - 1] >= floor) from--;
  while (to < sizes.length - 1 && sizes[to + 1] >= floor) to++;
  const lobeMs = to > from ? times[to] - times[from] + 20 : 20;

  // Candidate lines: cubic-weighted mean with every sample folded onto the side of the strongest
  // one, then the same on what is left (deflation), up to three orthogonal axes.
  const fold = (values: readonly Vector[]): Vector => {
    let reference = 0;
    for (let index = 1; index < values.length; index++) if (magnitude(values[index]) > magnitude(values[reference])) reference = index;
    const ref = values[reference];
    if (!ref || magnitude(ref) === 0) return [0, 0, 0];
    let sum: Vector = [0, 0, 0];
    for (const value of values) {
      const size = magnitude(value);
      sum = add(sum, scale(value, size * size * size * (dot(value, ref) < 0 ? -1 : 1)));
    }
    return normalized(sum);
  };
  const axes: Vector[] = [];
  let residual: Vector[] = [...linear];
  for (let count = 0; count < 3; count++) {
    const axis = fold(residual);
    if (magnitude(axis) === 0) break;
    axes.push(axis);
    residual = residual.map((value) => subtract(value, scale(axis, dot(value, axis))));
  }
  // Among the lines that carry a real share of the movement (noise is two-signed too), take the
  // one with the most two-signed energy: a slash's sideways launch and brake beat the one-signed
  // centripetal pull even when the pull is stronger.
  const energies = axes.map((candidate) => {
    let plus = 0, minus = 0;
    for (const value of linear) {
      const p = dot(value, candidate);
      if (p > 0) plus += p * p; else minus += p * p;
    }
    return { candidate, total: plus + minus, twoSigned: Math.min(plus, minus) };
  });
  const primary = energies[0]?.total ?? 0;
  let axis = axes[0], bestTwoSigned = -1;
  for (const entry of energies) {
    if (entry.total < primary * STROKE_AXIS_SHARE) continue;
    if (entry.twoSigned > bestTwoSigned) { bestTwoSigned = entry.twoSigned; axis = entry.candidate; }
  }

  // Lobes: runs of one sign along the line, above a share of the line's peak.
  const projections = linear.map((value) => dot(value, axis));
  const lineFloor = Math.max(...projections.map(Math.abs)) * STROKE_LOBE_FLOOR;
  type Lobe = { from: number; to: number; energy: number; impulse: number; sign: number };
  const lobes: Lobe[] = [];
  let current: Lobe | undefined;
  projections.forEach((p, index) => {
    const sign = Math.abs(p) >= lineFloor && lineFloor > 0 ? Math.sign(p) : 0;
    if (current && (sign === 0 || current.sign !== sign)) { lobes.push(current); current = undefined; }
    if (sign !== 0) {
      current ??= { from: index, to: index, energy: 0, impulse: 0, sign };
      current.to = index;
      current.energy += p * p;
      current.impulse += Math.abs(p);
    }
  });
  if (current) lobes.push(current);
  // Which way the wand went: integrate along the line. Velocity peaks at the end of the launch,
  // whatever the wind-up before it or the brake after it happen to measure, so its sign is the
  // launch's. (The centripetal pull of a wrist stroke would integrate too, but it lies off this
  // line.) The launch is the strongest lobe of that sign; the brake, if one cleared the floor, is
  // the strongest opposite lobe after it. Recorded jabs have a wind-up at 5-30 % of the launch
  // and a brake too soft to clear the floor; their sign comes out the same every time.
  const lastLobeEnd = lobes.reduce((last, lobe) => Math.max(last, lobe.to), -1);
  let velocity = 0, peakVelocity = 0;
  for (let index = 0; index <= lastLobeEnd; index++) {
    velocity += projections[index];
    if (Math.abs(velocity) > Math.abs(peakVelocity)) peakVelocity = velocity;
  }
  const launchSign = Math.sign(peakVelocity) || lobes[0]?.sign || 0;
  const strongest = (candidates: readonly Lobe[]): Lobe | undefined =>
    candidates.reduce<Lobe | undefined>((best, lobe) => (!best || lobe.impulse > best.impulse ? lobe : best), undefined);
  const launch = strongest(lobes.filter((lobe) => lobe.sign === launchSign));
  const brake = launch
    ? strongest(lobes.filter((lobe) => lobe.sign === -launchSign && lobe.from > launch.to && lobe.impulse >= launch.impulse * STROKE_BRAKE_SHARE))
    : undefined;
  const weightedMean = (lobe: Lobe): Vector => {
    let sum: Vector = [0, 0, 0], weight = 0;
    for (let index = lobe.from; index <= lobe.to; index++) {
      const w = projections[index] * projections[index];
      sum = add(sum, scale(linear[index], w));
      weight += w;
    }
    return weight > 0 ? scale(sum, 1 / weight) : [0, 0, 0];
  };
  const used = launch ? (brake ? [launch, brake] : [launch]) : [];
  const direction: Vector = !launch
    ? [0, 0, 0]
    : brake
      ? normalized(subtract(weightedMean(launch), weightedMean(brake)))
      : normalized(weightedMean(launch));
  let along = 0, energy = 0;
  for (const lobe of used)
    for (let index = lobe.from; index <= lobe.to; index++) { along += projections[index] ** 2; energy += sizes[index] ** 2; }
  return { direction, peak, lobeMs, dominantRatio: energy > 0 ? along / energy : 0 };
}

/**
 * How the linear acceleration direction turns over a movement. A jab, pull, chop, flick or slash
 * keeps one line (its brake is collinear and counts for nothing); a circle turns all the way round
 * in one plane and one sense. The signed normal remembers which way round.
 */
function rotationStats(linear: readonly Vector[]): { normal: Vector; coherence: number; sweptDeg: number; meanMg: number } {
  const smooth = linear.map((value, index, all) => scale(add(add(all[index - 1] ?? value, value), all[index + 1] ?? value), 1 / 3));
  let rotation: Vector = [0, 0, 0], crossTotal = 0, meanMg = 0, peak = 0;
  const pairs: { cross: Vector; angle: number; weight: number }[] = [];
  for (const value of smooth) {
    const size = magnitude(value);
    meanMg += size;
    peak = Math.max(peak, size);
  }
  meanMg /= Math.max(1, smooth.length);
  for (let index = 1; index < smooth.length; index++) {
    const a = smooth[index - 1], b = smooth[index];
    const ma = magnitude(a), mb = magnitude(b);
    if (ma < ARC_FLOOR_MG || mb < ARC_FLOOR_MG) continue;
    const c = cross(a, b);
    const mc = magnitude(c);
    if (mc < 0.05 * ma * mb) continue;  // collinear pair, including a reversal: no turning evidence
    rotation = add(rotation, c);
    crossTotal += mc;
    // Turning while the pull is strong is a circle; turning while it is weak is the wobble of a
    // brake or the noise between strokes, so each step counts in proportion to its strength.
    pairs.push({ cross: c, angle: angleDegrees(a, b), weight: peak > 0 ? Math.min(ma, mb) / peak : 0 });
  }
  const normal = normalized(rotation);
  let swept = 0;
  for (const pair of pairs) swept += pair.angle * pair.weight * Math.sign(dot(pair.cross, normal));
  return { normal, coherence: crossTotal > 0 ? magnitude(rotation) / crossTotal : 0, sweptDeg: Math.max(0, swept), meanMg };
}

export class MotionRecognizer {
  private phase: MotionRecognizerPhase = "uncalibrated";
  private generation?: number;
  private neutral?: Vector;
  private noiseRms = 0;
  private calibratingSpell?: SpellName;
  private readonly examples = new Map<SpellName, Features[]>();
  private readonly templates = new Map<SpellName, GestureTemplate>();
  private enabledSpells = new Set<SpellName>(CORE_SPELL_NAMES);
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
      !CORE_SPELL_NAMES.every((spell) => this.templates.has(spell)) ||
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
    if (!CORE_SPELL_NAMES.includes(spell)) this.enabledSpells.delete(spell);
    this.phase = "gesture-calibration";
    this.lastIssue = SPELLS[spell].move;
    this.reason = undefined;
    this.lastCandidate = undefined;
    this.clearSegmenter();
    this.setProgress("armed", 0, ARM_MS);
  }

  setEnabledSpells(spells: readonly SpellName[]): void {
    const next = new Set(spells);
    if (next.size !== spells.length || spells.some((spell) => !SPELL_NAMES.includes(spell)))
      throw new Error("Enabled spells must be unique supported spell names");
    for (const spell of next)
      if (!CORE_SPELL_NAMES.includes(spell) && !this.templates.has(spell))
        throw new Error(`Calibrate ${SPELLS[spell].title} before enabling it`);
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
    this.enabledSpells = new Set(CORE_SPELL_NAMES);
    this.evidenceSequence = 0;
    this.lastIssue = reason;
    this.reason = undefined;
    this.lastCandidate = undefined;
    this.clearSegmenter();
    this.rest = undefined;
  }

  getState(): MotionRecognizerState {
    const counts = spellCounts();
    for (const spell of SPELL_NAMES) counts[spell] = this.examples.get(spell)?.length ?? 0;
    return {
      phase: this.phase,
      generation: this.generation,
      stillnessMs: this.phase === "stillness" ? this.quietElapsed() : this.neutral ? STILLNESS_MS : 0,
      calibratingSpell: this.calibratingSpell,
      examplesBySpell: counts,
      calibratedSpells: SPELL_NAMES.filter((spell) => this.templates.has(spell)),
      enabledSpells: SPELL_NAMES.filter((spell) => this.enabledSpells.has(spell)),
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
      // Fast path for strong single strokes. Anything that is not one yet (a brisk raise, a circle
      // still turning) is left for the still end, where tilt, hold and rotation can be judged.
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
    if (magnitude(subtract(current.a, burst.rest)) > burst.peak * IMPULSE_EARLY_DECAY) return false;
    return rotationStats(burst.samples.map((sample) => subtract(sample.a, burst.rest))).sweptDeg < IMPULSE_MAX_SWEPT_DEG;
  }

  private features(burst: Burst, endMs: number, endQuiet: boolean): Features {
    const movement = burst.samples.filter((sample) => sample.t <= endMs);
    const tailStart = endMs - 100;
    const tail = burst.samples.filter((sample) => sample.t >= tailStart && sample.t <= endMs + QUIET_WINDOW_MS);
    const endPose = tail.length ? mean(tail.map((sample) => sample.a)) : movement[movement.length - 1].a;
    // Gravity does not stay put while the wand moves: raising a guard or pulling back to the
    // shoulder pitches it, and the swing of gravity in the device frame (about 700 mg for 40
    // degrees) lands on the wand's own axis, which is exactly where a jab lives. Gravity is
    // therefore interpolated from the starting pose to the pose at the end of the movement and
    // only what the arm did is left. At a still end that pose is exact; on the early path the
    // last 100 ms have already settled below the sharp part of the stroke, so the same estimate
    // costs the launch nothing and stops a pull-back's swing from reading as the jab's brake.
    const span = Math.max(20, endMs - burst.startMs);
    const swing: Vector = subtract(endPose, burst.rest);
    const linear = movement.map((sample) => subtract(sample.a, add(burst.rest, scale(swing, clamp01((sample.t - burst.startMs) / span)))));
    const stroke = strokeDirection(linear, movement.map((sample) => sample.t));
    const rotation = rotationStats(linear);
    return {
      startMs: burst.startMs,
      endMs,
      durationMs: endMs - burst.startMs,
      direction: stroke.direction,
      dominantRatio: stroke.dominantRatio,
      peak: burst.peak,
      strokeMg: stroke.peak,
      lobeMs: stroke.lobeMs,
      tiltDeg: angleDegrees(burst.rest, endPose),
      tiltDirection: normalized(subtract(endPose, burst.rest)),
      startPose: burst.rest,
      endPose,
      endQuiet,
      sweptDeg: rotation.sweptDeg,
      coherence: rotation.coherence,
      normal: rotation.normal,
      meanMg: rotation.meanMg,
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
      if (how === "early") return false;  // not a single stroke; judge it as a guard or circle when it settles
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
    const info = SPELLS[spell];
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
      if (info.gesture === "guard" && features.tiltDeg >= ONSET_TILT_DEG)
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
      this.lastIssue = `${examples.length} of ${EXAMPLES_PER_SPELL}. ${info.again}`;
      return;
    }
    if (info.gesture === "guard") {
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
    } else if (info.gesture === "arc") {
      this.templates.set(spell, {
        kind: "arc",
        normal: normalized(mean(examples.map((example) => example.normal))),
        sweptDeg: median(examples.map((example) => example.sweptDeg)),
        meanMg: median(examples.map((example) => example.meanMg)),
      });
    } else {
      this.templates.set(spell, {
        kind: "impulse",
        direction: normalized(mean(examples.map((example) => example.direction))),
        peak: median(examples.map((example) => example.peak)),
        strokeMg: median(examples.map((example) => example.strokeMg)),
      });
    }
    // A learned spell is a playable spell; Reset grip or a new stream clears it again.
    this.enabledSpells.add(spell);
    this.calibratingSpell = undefined;
    this.updateReadyPhase();
    this.lastIssue = this.phase === "ready" ? "" : `${info.title} learned`;
  }

  private calibratedImpulses(except?: SpellName): { spell: SpellName; template: ImpulseTemplate }[] {
    const result: { spell: SpellName; template: ImpulseTemplate }[] = [];
    for (const [spell, template] of this.templates)
      if (spell !== except && template.kind === "impulse") result.push({ spell, template });
    return result;
  }

  private calibrationIssue(spell: SpellName, features: Features, how: "early" | "quiet"):
    { message: string; reason: MotionRejectionReason } | "ignore" | undefined {
    const info = SPELLS[spell];
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
        if (angleDegrees(features.direction, other.template.direction) <= DIRECTION_TOLERANCE_DEG && features.strokeMg >= other.template.strokeMg * STROKE_PREFER_SHARE)
          return { message: `That looked like ${SPELLS[other.spell].title}. Raise your wand into a guard and hold it.`, reason: "unclear-direction" };
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
    if (info.gesture === "arc") {
      if (how === "early" || !features.endQuiet) return "ignore";
      if (features.durationMs > MOVEMENT_MAX_MS) return { message: "One circle, then pause.", reason: "too-long" };
      if (features.meanMg < ARC_MIN_MEAN_MG || features.peak < PLAY_MIN_PEAK_MG) {
        if (features.durationMs < COACH_MIN_MS) return "ignore";
        return { message: info.harder, reason: "too-small" };
      }
      if (features.sweptDeg < ARC_MIN_SWEPT_DEG)
        return { message: "Draw one full circle, all the way round.", reason: "incomplete-circle" };
      if (features.coherence < ARC_MIN_COHERENCE)
        return { message: "Keep the circle flat and in one direction.", reason: "unclear-direction" };
      if (prior.length && angleDegrees(features.normal, mean(prior.map((example) => example.normal))) > ARC_CONSISTENCY_DEG)
        return { message: info.sameWay, reason: "inconsistent-direction" };
      return undefined;
    }
    if (features.durationMs > MOVEMENT_MAX_MS) return { message: "One movement, then pause.", reason: "too-long" };
    if (features.peak < IMPULSE_MIN_PEAK_MG || features.lobeMs < IMPULSE_MIN_LOBE_MS) {
      if (features.durationMs < COACH_MIN_MS && features.peak < IMPULSE_MIN_PEAK_MG) return "ignore";  // a twitch before the real stroke
      return { message: info.harder, reason: "too-small" };
    }
    if (features.sweptDeg >= IMPULSE_MAX_SWEPT_DEG || features.lobeMs > IMPULSE_MAX_LOBE_MS)
      return { message: "One straight, sharp stroke, then stop.", reason: "unclear-direction" };
    if (features.dominantRatio < STROKE_MIN_DOMINANT)
      return { message: "Make one clear stroke.", reason: "unclear-direction" };
    if (prior.length && angleDegrees(features.direction, mean(prior.map((example) => example.direction))) > CONSISTENCY_DEG)
      return { message: info.sameWay, reason: "inconsistent-direction" };
    for (const other of this.calibratedImpulses(spell))
      if (angleDegrees(other.template.direction, features.direction) < SEPARATION_DEG)
        return { message: `Too close to your ${SPELLS[other.spell].title}. Move in a clearly different direction.`, reason: "too-similar" };
    return undefined;
  }

  private classify(features: Features): { spell?: SpellName; quality: number; reason?: MotionRejectionReason; message: string } {
    const impulses: { spell: SpellName; angle: number; template: ImpulseTemplate }[] = [];
    let guard: { spell: SpellName; quality: number; template: GuardTemplate; angle: number } | undefined;
    let arc: { spell: SpellName; quality: number; angle: number } | undefined;
    // A held tilt whose stroke is no stronger than its own gravity change is the wand being
    // re-oriented (raised or lowered), never a jab or sweep, whatever direction it points.
    const gravityChange = 2_000 * Math.sin((features.tiltDeg * Math.PI) / 360);
    const reorientation = features.endQuiet && features.tiltDeg >= GUARD_MIN_TILT_DEG && features.peak <= gravityChange * REORIENTATION_SLACK + 100;
    // A single stroke keeps one line; a circle turns. Neither may borrow the other's templates.
    const stroke = features.sweptDeg < IMPULSE_MAX_SWEPT_DEG && features.lobeMs <= IMPULSE_MAX_LOBE_MS;
    // A sharp chop from the grip resolves on the fast path before this; a gentle drop that ends
    // held low is indistinguishable from lowering a guard and stays silent.
    let lowering = false;
    for (const spell of this.enabledSpells) {
      const template = this.templates.get(spell);
      if (!template) continue;
      if (template.kind === "impulse") {
        if (reorientation || !stroke) continue;
        const angle = angleDegrees(features.direction, template.direction);
        if (angle <= DIRECTION_TOLERANCE_DEG && features.lobeMs >= IMPULSE_MIN_LOBE_MS &&
          features.peak >= Math.max(PLAY_MIN_PEAK_MG, template.peak * 0.35))
          impulses.push({ spell, angle, template });
      } else if (template.kind === "guard") {
        if (!features.endQuiet) continue;
        const angle = angleDegrees(features.tiltDirection, template.direction);
        if (features.tiltDeg >= GUARD_MIN_TILT_DEG && angle >= LOWERING_DEG) lowering = true;
        if (features.tiltDeg >= Math.max(GUARD_MIN_TILT_DEG, template.tiltDeg * 0.55) && angle <= GUARD_TOLERANCE_DEG &&
          features.peak >= Math.max(GUARD_MIN_PEAK_MG, template.peak * 0.3) && features.peak <= Math.max(template.peak * 4, 2_000) &&
          (!guard || angle < guard.angle))
          guard = { spell, template, angle, quality: clamp01(0.5 + (features.tiltDeg - GUARD_MIN_TILT_DEG) / 60 + ((GUARD_TOLERANCE_DEG - angle) / GUARD_TOLERANCE_DEG) * 0.3) };
      } else {
        if (!features.endQuiet || features.durationMs < ARC_MIN_MS) continue;
        const angle = angleDegrees(features.normal, template.normal);
        if (features.sweptDeg >= Math.max(ARC_MIN_SWEPT_DEG, template.sweptDeg * 0.6) && features.coherence >= ARC_MIN_COHERENCE &&
          features.meanMg >= Math.max(ARC_MIN_MEAN_MG, template.meanMg * 0.35) && angle <= ARC_TOLERANCE_DEG && (!arc || angle < arc.angle))
          arc = { spell, angle, quality: clamp01(0.5 + Math.min(0.3, (features.sweptDeg - ARC_MIN_SWEPT_DEG) / 400) + features.coherence * 0.2) };
      }
    }
    // Nothing but a circle turns all the way round: it cannot be confused with a stroke or a raise.
    if (arc) return { spell: arc.spell, quality: arc.quality, message: "" };
    if (lowering && !guard) return { quality: 0, message: "" };  // lowering the guard is never a cast
    impulses.sort((a, b) => a.angle - b.angle);
    const best = impulses[0];
    if (best && impulses[1] && impulses[1].angle - best.angle < AMBIGUITY_MARGIN_DEG)
      return { quality: 0, reason: "ambiguous", message: "That movement matched two spells. Make it clearer." };
    // A matching guard wins unless the arm's own stroke (gravity swing removed) is as strong as a
    // real cast of that spell: a pull back to the shoulder ends held like a guard but is a stroke.
    if (best && (!guard || features.strokeMg >= best.template.strokeMg * STROKE_PREFER_SHARE)) {
      const quality = clamp01(0.5 + (DIRECTION_TOLERANCE_DEG - best.angle) / (2 * DIRECTION_TOLERANCE_DEG) + Math.min(0.25, features.peak / best.template.peak / 4));
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
