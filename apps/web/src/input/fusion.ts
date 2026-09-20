import type { Spell } from "../game/contracts";
import type { GestureEvidence } from "./motion";
import type { AccelerationSpikeEvidence } from "./spike";

export type MotionEvidence = GestureEvidence | AccelerationSpikeEvidence;

function isSpike(evidence: MotionEvidence): evidence is AccelerationSpikeEvidence {
  return "kind" in evidence && evidence.kind === "acceleration-spike";
}

function timingFits(voice: UtteranceEvidence, gesture: MotionEvidence, simpleMotion: boolean): boolean {
  const gap = Math.max(0, voice.startMs - gesture.endMs, gesture.startMs - voice.endMs);
  const union = Math.max(voice.endMs, gesture.endMs) - Math.min(voice.startMs, gesture.startMs);
  return gap <= (simpleMotion ? SIMPLE_GAP_MS : GESTURE_GAP_MS) &&
    union <= (simpleMotion ? SIMPLE_UNION_MS : GESTURE_UNION_MS);
}

export type UtteranceOnset = {
  id: string;
  generation: number;
  startMs: number;
};

export type UtteranceEvidence = UtteranceOnset & {
  spell: Spell;
  endMs: number;
  finalAtMs: number;
};

export type CastAttempt = {
  id: string;
  spell: Spell;
  gestureId: string;
  utteranceId: string;
  generation: number;
  timing: {
    speechStartMs: number;
    speechEndMs: number;
    speechFinalAtMs: number;
    gestureStartMs: number;
    gestureEndMs: number;
    order: "speech-first" | "motion-first" | "overlap";
    gapMs: number;
  };
};

export type CastRejection = {
  reason: "spell-gesture-mismatch" | "evidence-timing-mismatch" | "pending-evidence-expired";
  utterance: UtteranceEvidence;
  gesture?: MotionEvidence;
};

export type CastFusionState = {
  generation?: number;
  activeUtterance?: UtteranceOnset;
  pendingUtterance?: UtteranceEvidence;
  pendingGesture?: MotionEvidence;
  lastRejection: string;
};

const SIMPLE_GAP_MS = 350;
const SIMPLE_UNION_MS = 2_000;
const GESTURE_GAP_MS = 2_000;
const GESTURE_UNION_MS = 6_000;
const FINAL_DEADLINE_MS = 1_000;
const SIMPLE_TTL_MS = SIMPLE_UNION_MS + FINAL_DEADLINE_MS;
const GESTURE_TTL_MS = GESTURE_UNION_MS + FINAL_DEADLINE_MS;

class BoundedIds {
  private readonly values = new Set<string>();
  private readonly order: string[] = [];

  has(id: string): boolean {
    return this.values.has(id);
  }

  add(id: string): void {
    if (this.values.has(id)) return;
    this.values.add(id);
    this.order.push(id);
    if (this.order.length > 64) this.values.delete(this.order.shift()!);
  }

  clear(): void {
    this.values.clear();
    this.order.length = 0;
  }
}

export class CastFusion {
  private generation?: number;
  private activeUtterance?: UtteranceOnset;
  private pendingUtterance?: UtteranceEvidence;
  private pendingGesture?: MotionEvidence;
  private readonly motions: MotionEvidence[] = [];
  private simpleMotion = false;
  private readonly utteranceIds = new BoundedIds();
  private readonly gestureIds = new BoundedIds();
  private lastRejection = "";

  constructor(
    private readonly onAccepted: (attempt: CastAttempt) => void,
    private readonly onRejected: (rejection: CastRejection) => void = () => {},
  ) {}

  setSimpleMotion(enabled: boolean): void {
    if (this.simpleMotion === enabled) return;
    this.simpleMotion = enabled;
    // Keep consumed IDs: changing mode must not replay an already used attempt.
    this.activeUtterance = undefined;
    this.pendingUtterance = undefined;
    this.pendingGesture = undefined;
    this.motions.length = 0;
    this.lastRejection = "";
  }

  beginUtterance(onset: UtteranceOnset): void {
    this.assertOnset(onset);
    if (!this.acceptGeneration(onset.generation)) return;
    this.advance(onset.startMs);
    if (this.utteranceIds.has(onset.id)) {
      this.lastRejection = "duplicate-utterance-id";
      return;
    }
    this.utteranceIds.add(onset.id);
    // Arm one confirmed word while its next gesture can still begin. Breathing
    // or wand noise must not take ownership away from that command.
    if (this.pendingUtterance) {
      if (this.simpleMotion || onset.startMs <= this.pendingUtterance.endMs + this.intervalGapMs) return;
      this.pendingUtterance = undefined;
    }
    if (this.activeUtterance) {
      this.reject("second-utterance-onset");
      return;
    }
    this.pruneMotions(onset.startMs - this.intervalGapMs);
    this.activeUtterance = { ...onset };
    this.lastRejection = "";
  }

  pushUtterance(evidence: UtteranceEvidence): void {
    this.assertUtterance(evidence);
    if (!this.acceptGeneration(evidence.generation)) return;
    this.advance(evidence.finalAtMs);
    if (
      !this.activeUtterance ||
      this.activeUtterance.id !== evidence.id ||
      this.activeUtterance.startMs !== evidence.startMs
    ) {
      this.lastRejection = this.utteranceIds.has(evidence.id)
        ? "duplicate-or-invalidated-utterance"
        : "utterance-final-without-onset";
      return;
    }
    if (
      evidence.finalAtMs < evidence.endMs ||
      evidence.finalAtMs - evidence.endMs > FINAL_DEADLINE_MS
    ) {
      this.reject("utterance-final-missed-deadline");
      return;
    }
    this.activeUtterance = undefined;
    this.pendingUtterance = { ...evidence };
    this.tryPair();
  }

  cancelUtterance(id: string, generation: number): void {
    // A late cancellation must never reset or retire a newer input generation.
    if (generation !== this.generation) return;
    if (this.activeUtterance?.id !== id && this.pendingUtterance?.id !== id) return;
    this.reject("utterance-discarded");
  }

  pushGesture(evidence: MotionEvidence): void {
    this.assertGesture(evidence);
    if (isSpike(evidence) !== this.simpleMotion) return;
    if (!this.acceptGeneration(evidence.generation)) return;
    this.advance(evidence.endMs);
    if (this.gestureIds.has(evidence.id)) {
      this.lastRejection = "duplicate-gesture-id";
      return;
    }
    this.gestureIds.add(evidence.id);
    const voice = this.pendingUtterance ?? this.activeUtterance;
    if (voice && voice.startMs - evidence.endMs > this.intervalGapMs) return;
    this.pruneMotions(evidence.endMs - this.pendingTtlMs);
    if (this.motions.length === (this.simpleMotion ? 32 : 8)) this.motions.shift();
    this.motions.push({ ...evidence });
    this.pendingGesture = this.motions[0];
    this.lastRejection = "";
    this.tryPair();
  }

  advance(nowMs: number): void {
    if (!Number.isFinite(nowMs)) throw new Error("Fusion time must be finite");
    const voice = this.pendingUtterance;
    const oldestStart = this.activeUtterance?.startMs ?? voice?.startMs;
    if (oldestStart !== undefined && nowMs - oldestStart > this.pendingTtlMs) {
      const near = voice && this.motions.find(motion => timingFits(voice, motion, this.simpleMotion));
      if (near) this.pendingGesture = near;
      this.reject(near ? "spell-gesture-mismatch" : voice && this.motions.length
        ? "evidence-timing-mismatch" : "pending-evidence-expired");
      return;
    }
    const hadMotion = this.motions.length > 0;
    this.pruneMotions(nowMs - this.pendingTtlMs);
    if (hadMotion && !this.motions.length && oldestStart === undefined)
      this.lastRejection = "pending-evidence-expired";
  }

  private get intervalGapMs(): number {
    return this.simpleMotion ? SIMPLE_GAP_MS : GESTURE_GAP_MS;
  }

  private get pendingTtlMs(): number {
    return this.simpleMotion ? SIMPLE_TTL_MS : GESTURE_TTL_MS;
  }

  reset(generation?: number): void {
    this.generation = generation;
    this.activeUtterance = undefined;
    this.pendingUtterance = undefined;
    this.pendingGesture = undefined;
    this.motions.length = 0;
    this.utteranceIds.clear();
    this.gestureIds.clear();
    this.lastRejection = "";
  }

  /** A brief wand gap invalidates movement, not independently captured speech. */
  clearMotion(): void {
    this.pendingGesture = undefined;
    this.motions.length = 0;
  }

  getState(): CastFusionState {
    return {
      generation: this.generation,
      activeUtterance: this.activeUtterance
        ? { ...this.activeUtterance }
        : undefined,
      pendingUtterance: this.pendingUtterance
        ? { ...this.pendingUtterance }
        : undefined,
      pendingGesture: this.pendingGesture
        ? { ...this.pendingGesture }
        : undefined,
      lastRejection: this.lastRejection,
    };
  }

  private tryPair(): void {
    const voice = this.pendingUtterance;
    if (!voice || this.generation === undefined) return;
    const requiredGesture = voice.spell === "protego" || voice.spell === "episkey"
      ? "protego" : "stupefy";
    const compatible = this.motions.filter(motion => timingFits(voice, motion, this.simpleMotion) &&
      (isSpike(motion) || motion.spell === requiredGesture || motion.spell === voice.spell));
    // Select by captured intervals, not callback arrival or an earlier unrelated movement.
    if (!this.simpleMotion) compatible.sort((left, right) => {
      const distance = (motion: MotionEvidence) => Math.max(0, voice.startMs - motion.endMs, motion.startMs - voice.endMs);
      return distance(left) - distance(right) || Math.abs(left.endMs - voice.endMs) - Math.abs(right.endMs - voice.endMs);
    });
    const gesture = compatible[0];
    if (!gesture) return;
    const attempt: CastAttempt = {
      id: `${this.generation}:cast:${gesture.id}:${voice.id}`,
      spell: voice.spell,
      gestureId: gesture.id,
      utteranceId: voice.id,
      generation: this.generation,
      timing: {
        speechStartMs: voice.startMs, speechEndMs: voice.endMs, speechFinalAtMs: voice.finalAtMs,
        gestureStartMs: gesture.startMs, gestureEndMs: gesture.endMs,
        order: gesture.startMs > voice.endMs ? "speech-first" : gesture.endMs < voice.startMs ? "motion-first" : "overlap",
        gapMs: Math.max(0, voice.startMs - gesture.endMs, gesture.startMs - voice.endMs),
      },
    };
    this.pendingUtterance = undefined;
    this.clearMotion();
    this.lastRejection = "";
    this.onAccepted(attempt);
  }

  private acceptGeneration(generation: number): boolean {
    if (!Number.isInteger(generation) || generation < 0)
      throw new Error("Fusion generation must be a non-negative integer");
    if (this.generation === undefined) {
      this.generation = generation;
      return true;
    }
    if (this.generation === generation) return true;
    this.reset(generation);
    this.lastRejection = "generation-changed";
    return false;
  }

  private pruneMotions(oldestEndMs: number): void {
    for (let index = this.motions.length - 1; index >= 0; index--)
      if (this.motions[index].endMs < oldestEndMs) this.motions.splice(index, 1);
    this.pendingGesture = this.motions[0];
  }

  private reject(reason: string): void {
    const voice = this.pendingUtterance;
    const gesture = this.pendingGesture;
    this.activeUtterance = undefined;
    this.pendingUtterance = undefined;
    this.pendingGesture = undefined;
    this.motions.length = 0;
    this.lastRejection = reason;
    // Only a confirmed incantation can produce a fizzle; silence, stale input and
    // ASR cancellation must never look like an attempted spell.
    if (voice && (reason === "spell-gesture-mismatch" || reason === "evidence-timing-mismatch" ||
      reason === "pending-evidence-expired"))
      this.onRejected({ reason, utterance: { ...voice }, gesture: gesture ? { ...gesture } : undefined });
  }

  private assertOnset(onset: UtteranceOnset): void {
    if (!onset.id || !Number.isFinite(onset.startMs))
      throw new Error("Utterance onset requires an ID and finite start time");
  }

  private assertUtterance(evidence: UtteranceEvidence): void {
    this.assertOnset(evidence);
    if (
      !Number.isFinite(evidence.endMs) ||
      !Number.isFinite(evidence.finalAtMs) ||
      evidence.endMs < evidence.startMs
    )
      throw new Error("Utterance evidence has an invalid interval");
  }

  private assertGesture(evidence: MotionEvidence): void {
    if (
      !evidence.id ||
      !Number.isFinite(evidence.startMs) ||
      !Number.isFinite(evidence.endMs) ||
      evidence.endMs < evidence.startMs ||
      !Number.isFinite(evidence.quality) ||
      evidence.quality < 0 ||
      evidence.quality > 1
    )
      throw new Error("Gesture evidence is invalid");
  }
}
