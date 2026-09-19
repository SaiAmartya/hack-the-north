// Motion segmentation and gesture classification for wand samples.
//
// The wand only sends raw acceleration (milligravity, 3 axes, ~50 Hz). This module turns that
// stream into bounded movement segments and scores each segment against per-player calibration
// prototypes for the three gestures: jab (Stupefy), guard (Protego), sweep (Expelliarmus).
//
// Everything here is pure and clock-injected so it can be unit tested with synthetic samples.

/** One acceleration sample in milligravity with the wand clock in ms. */
export type MotionSample = { x: number; y: number; z: number; ms: number };

export type GestureKind = "jab" | "guard" | "sweep";
export const GESTURES: GestureKind[] = ["jab", "guard", "sweep"];

export type Vec3 = [number, number, number];

export type SegmenterConfig = {
  restMs: number;          // quiet time required before a new movement may start (MVP: 200)
  onsetMg: number;         // dynamic acceleration that starts a movement
  releaseMg: number;       // dynamic acceleration below which the movement is over
  settleMs: number;        // quiet time that ends a movement (MVP: 150)
  minMs: number;           // shorter movements are fidgets (MVP: 150)
  maxMs: number;           // longer movements are "too noisy" (MVP: 900)
  gapMs: number;           // a sample gap larger than this invalidates the movement (MVP: 150)
  holdMs: number;          // stable time after a movement that ends in a new orientation = guard hold
};

/** Still in an unexplained orientation for this long: accept it as the new rest pose. */
const RESEED_MS = 800;
/** A wand that is not accelerating measures about 1 g in total; beyond this deviation it is moving. */
const QUASI_STATIC_MG = 150;

export const DEFAULT_SEGMENTER: SegmenterConfig = {
  restMs: 200,
  onsetMg: 350,
  releaseMg: 180,
  settleMs: 150,
  minMs: 120,
  maxMs: 900,
  gapMs: 150,
  holdMs: 250,
};

export type Segment = {
  startMs: number;        // wand clock
  endMs: number;
  durationMs: number;
  peakMg: number;         // largest dynamic acceleration magnitude
  dir: Vec3;              // unit vector of the dynamic acceleration at the first peak (badge frame)
  gravityBefore: Vec3;    // unit gravity vector at rest before the movement
  gravityAfter: Vec3;     // unit gravity vector once settled
  tiltDeg: number;        // angle between the two gravity vectors
  held: boolean;          // orientation stayed stable for holdMs after settling
  reversals: number;      // sign changes of the dominant-axis dynamic acceleration
  samples: number;
  rejected?: "too-short" | "too-long" | "gap";
};

function norm(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
function unit(v: Vec3): Vec3 {
  const n = norm(v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function angleDeg(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(unit(a), unit(b))));
  return (Math.acos(c) * 180) / Math.PI;
}

type Phase = "rest" | "moving" | "settling" | "holding";

/**
 * Turns samples into Segments. Feed every accepted sample in order; `push` returns a completed
 * Segment when a movement has settled (and, for guards, when the hold check has finished).
 *
 * Two signals drive it:
 *  - `dyn`    = acceleration minus the slow gravity estimate taken at rest. Starts a movement and
 *               gives its direction and peak. It also grows when the wand is merely rotated, which
 *               is exactly what a raised guard needs.
 *  - `jitter` = change between consecutive samples (deviation from a fast running mean). Ends a
 *               movement, because it drops to sensor noise as soon as the wand holds still in ANY
 *               orientation, unlike `dyn`.
 */
export class Segmenter {
  private phase: Phase = "rest";
  private gravity: Vec3 = [0, 0, 1000];
  private fast: Vec3 = [0, 0, 1000];
  private ready = false;
  private quietSinceMs = 0;
  private lastMs = -1;
  private restMs = 0;
  private start = 0;
  private peak = 0;
  private dir: Vec3 = [0, 0, 1];
  private gravityBefore: Vec3 = [0, 0, 1000];
  private lastSign = 0;
  private reversals = 0;
  private count = 0;
  private endMs = 0;
  private pending: Segment | null = null;
  private holdGravity: Vec3 = [0, 0, 1000];
  private holdSince = 0;
  private offSinceMs = -1;

  constructor(readonly cfg: SegmenterConfig = DEFAULT_SEGMENTER) {}

  /** True while the wand is still enough to accept a new movement. */
  get atRest(): boolean {
    return this.phase === "rest" && this.restMs >= this.cfg.restMs;
  }

  /** Gravity estimate in mg (badge frame). Only meaningful after ~0.5 s at rest. */
  get gravityVector(): Vec3 {
    return this.gravity;
  }

  /** Current phase name, for diagnostics panels. */
  get phaseName(): string {
    return this.phase;
  }

  reset(): void {
    this.phase = "rest";
    this.ready = false;
    this.lastMs = -1;
    this.restMs = 0;
    this.pending = null;
  }

  push(s: MotionSample): Segment | null {
    const a: Vec3 = [s.x, s.y, s.z];
    const gap = this.lastMs < 0 ? 0 : s.ms - this.lastMs;
    this.lastMs = s.ms;
    if (!this.ready) {
      this.gravity = a;
      this.fast = a;
      this.ready = true;
      this.quietSinceMs = s.ms;
      return null;
    }
    const jitter = norm([a[0] - this.fast[0], a[1] - this.fast[1], a[2] - this.fast[2]]);
    this.fast = [this.fast[0] + (a[0] - this.fast[0]) * 0.5, this.fast[1] + (a[1] - this.fast[1]) * 0.5, this.fast[2] + (a[2] - this.fast[2]) * 0.5];
    const dyn: Vec3 = [a[0] - this.gravity[0], a[1] - this.gravity[1], a[2] - this.gravity[2]];
    const mag = norm(dyn);
    // Still = no sample-to-sample change AND total acceleration near 1 g. Both are needed: a
    // smooth swing changes slowly, a hold in any orientation still measures 1 g.
    const still = jitter < this.cfg.releaseMg && Math.abs(norm(a) - 1000) < QUASI_STATIC_MG;
    let out: Segment | null = null;

    switch (this.phase) {
      case "rest": {
        if (mag < this.cfg.releaseMg && still) {
          this.restMs += gap;
          this.offSinceMs = -1;
          this.gravity = [this.gravity[0] + (a[0] - this.gravity[0]) * 0.1, this.gravity[1] + (a[1] - this.gravity[1]) * 0.1, this.gravity[2] + (a[2] - this.gravity[2]) * 0.1];
        } else if (mag >= this.cfg.onsetMg && this.restMs >= this.cfg.restMs) {
          this.offSinceMs = -1;
          this.phase = "moving";
          this.start = s.ms;
          this.peak = mag;
          this.dir = unit(dyn);
          this.gravityBefore = this.gravity;
          this.lastSign = 0;
          this.reversals = 0;
          this.count = 1;
        } else if (still) {
          // Still, but not where gravity was last seen: the wand was moved without a clean
          // segment (lowered slowly, put down, picked up). After a while accept the new pose as
          // rest, otherwise no gesture could ever start again.
          if (this.offSinceMs < 0) this.offSinceMs = s.ms;
          if (s.ms - this.offSinceMs >= RESEED_MS) {
            this.gravity = this.fast;
            this.offSinceMs = -1;
            this.restMs = 0;
          }
        }
        // Otherwise: the ramp into a movement or a fidget. Not rest, but the rest timer is kept so a
        // real onset a few samples later still qualifies.
        break;
      }
      case "moving": {
        this.count++;
        if (gap > this.cfg.gapMs) {
          out = this.finish(s.ms, "gap");
          break;
        }
        if (mag > this.peak) {
          this.peak = mag;
          this.dir = unit(dyn);
        }
        const axis = [0, 1, 2].reduce((best, i) => (Math.abs(this.dir[i]) > Math.abs(this.dir[best]) ? i : best), 0);
        const sign = Math.sign(dyn[axis]);
        if (sign !== 0 && Math.abs(dyn[axis]) > this.cfg.releaseMg) {
          if (this.lastSign !== 0 && sign !== this.lastSign) this.reversals++;
          this.lastSign = sign;
        }
        if (s.ms - this.start > this.cfg.maxMs) {
          out = this.finish(s.ms, "too-long");
        } else if (still) {
          this.phase = "settling";
          this.endMs = s.ms;
          this.quietSinceMs = s.ms;
        }
        break;
      }
      case "settling": {
        this.count++;
        if (!still) {
          this.phase = "moving"; // the same movement continues
          break;
        }
        if (s.ms - this.quietSinceMs >= this.cfg.settleMs) {
          const seg = this.finish(this.endMs, undefined, a);
          if (seg.tiltDeg >= 25 && !seg.rejected) {
            // Might be a guard: watch the hold before reporting it.
            this.pending = seg;
            this.holdGravity = a;
            this.holdSince = s.ms;
            this.phase = "holding";
          } else {
            out = seg;
          }
        }
        break;
      }
      case "holding": {
        const moved = angleDeg(a, this.holdGravity) > 15 || !still;
        if (moved) {
          out = { ...this.pending!, held: false };
          this.pending = null;
          this.phase = "rest";
          this.restMs = 0;
        } else if (s.ms - this.holdSince >= this.cfg.holdMs) {
          out = { ...this.pending!, held: true, gravityAfter: unit(a) };
          this.pending = null;
          this.phase = "rest";
          this.restMs = 0;
          this.gravity = a;
        }
        break;
      }
    }
    return out;
  }

  private finish(endMs: number, rejected?: Segment["rejected"], settled?: Vec3): Segment {
    const durationMs = Math.max(0, endMs - this.start);
    const after = settled ?? this.gravity;
    const seg: Segment = {
      startMs: this.start,
      endMs,
      durationMs,
      peakMg: this.peak,
      dir: this.dir,
      gravityBefore: unit(this.gravityBefore),
      gravityAfter: unit(after),
      tiltDeg: angleDeg(this.gravityBefore, after),
      held: false,
      reversals: this.reversals,
      samples: this.count,
      rejected,
    };
    if (!rejected && durationMs < this.cfg.minMs) seg.rejected = "too-short";
    this.phase = "rest";
    this.restMs = 0;
    if (settled) this.gravity = settled;
    return seg;
  }
}

// ---------------------------------------------------------------------------------------------
// Classification against calibrated prototypes.

export type Prototype = {
  kind: GestureKind;
  dir: Vec3;          // mean direction of the first peak
  tiltDeg: number;
  peakMg: number;
  durationMs: number;
  examples: number;
};

export type Calibration = Record<GestureKind, Prototype | undefined>;

export type Verdict = {
  kind: GestureKind | null;
  confidence: number;      // 0..1, only meaningful when kind is set
  scores: Record<GestureKind, number>;  // lower is closer
  reason: string;
};

export function emptyCalibration(): Calibration {
  return { jab: undefined, guard: undefined, sweep: undefined };
}

/** Fold one example into the prototype for its gesture (running mean). */
export function addExample(cal: Calibration, kind: GestureKind, seg: Segment): Calibration {
  const p = cal[kind];
  if (!p) {
    return { ...cal, [kind]: { kind, dir: seg.dir, tiltDeg: seg.tiltDeg, peakMg: seg.peakMg, durationMs: seg.durationMs, examples: 1 } };
  }
  const n = p.examples + 1;
  const mix = (a: number, b: number) => a + (b - a) / n;
  const dir = unit([mix(p.dir[0], seg.dir[0]), mix(p.dir[1], seg.dir[1]), mix(p.dir[2], seg.dir[2])]);
  return {
    ...cal,
    [kind]: { kind, dir, tiltDeg: mix(p.tiltDeg, seg.tiltDeg), peakMg: mix(p.peakMg, seg.peakMg), durationMs: mix(p.durationMs, seg.durationMs), examples: n },
  };
}

const ACCEPT_SCORE = 0.9;   // distance below which a gesture is accepted
const MARGIN = 0.15;        // best must beat the runner-up by this much

function distance(seg: Segment, p: Prototype): number {
  const dirTerm = 1 - dot(unit(seg.dir), unit(p.dir));                 // 0 same direction, 2 opposite
  const tiltTerm = Math.abs(seg.tiltDeg - p.tiltDeg) / 45;
  const peakTerm = Math.abs(Math.log((seg.peakMg + 1) / (p.peakMg + 1))) / Math.log(2.5);
  const durTerm = Math.abs(seg.durationMs - p.durationMs) / 500;
  return dirTerm * 1.2 + tiltTerm * 0.8 + peakTerm * 0.4 + durTerm * 0.3;
}

/** Score a completed, non-rejected segment. Guards additionally require the held pose. */
export function classify(seg: Segment, cal: Calibration): Verdict {
  const scores: Record<GestureKind, number> = { jab: Infinity, guard: Infinity, sweep: Infinity };
  if (seg.rejected) return { kind: null, confidence: 0, scores, reason: seg.rejected };
  for (const kind of GESTURES) {
    const p = cal[kind];
    if (!p) continue;
    if (kind === "guard" && !seg.held) continue;          // a guard must end in a held raised pose
    if (kind !== "guard" && seg.tiltDeg >= 35) continue;  // jabs and sweeps come back to the grip
    scores[kind] = distance(seg, p);
  }
  const ranked = GESTURES.filter((k) => Number.isFinite(scores[k])).sort((a, b) => scores[a] - scores[b]);
  if (ranked.length === 0) return { kind: null, confidence: 0, scores, reason: "no calibrated gesture fits" };
  const best = ranked[0];
  const bestScore = scores[best];
  const runnerUp = ranked.length > 1 ? scores[ranked[1]] : Infinity;
  if (bestScore > ACCEPT_SCORE) return { kind: null, confidence: 0, scores, reason: `closest is ${best} but too far (${bestScore.toFixed(2)})` };
  if (runnerUp - bestScore < MARGIN) return { kind: null, confidence: 0, scores, reason: `ambiguous between ${best} and ${ranked[1]}` };
  const confidence = Math.max(0, Math.min(1, 1 - bestScore / ACCEPT_SCORE));
  return { kind: best, confidence, scores, reason: "matched" };
}

export const CALIBRATION_STORAGE_KEY = "hp-wand-calibration-v1";

export function saveCalibration(mac: string, cal: Calibration): void {
  try {
    const all = JSON.parse(localStorage.getItem(CALIBRATION_STORAGE_KEY) ?? "{}") as Record<string, Calibration>;
    all[mac] = cal;
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: calibration lives for this page only */
  }
}

export function loadCalibration(mac: string): Calibration {
  try {
    const all = JSON.parse(localStorage.getItem(CALIBRATION_STORAGE_KEY) ?? "{}") as Record<string, Calibration>;
    return { ...emptyCalibration(), ...(all[mac] ?? {}) };
  } catch {
    return emptyCalibration();
  }
}
