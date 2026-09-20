import type { Spell } from "../game/contracts";
import type { GestureEvidence } from "./motion";

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
};

export type CastRejection = {
  reason: "spell-gesture-mismatch" | "evidence-timing-mismatch" | "pending-evidence-expired" | "multiple-gesture-candidates";
  utterance: UtteranceEvidence;
  gesture?: GestureEvidence;
};

export type CastFusionState = {
  generation?: number;
  activeUtterance?: UtteranceOnset;
  pendingUtterance?: UtteranceEvidence;
  pendingGesture?: GestureEvidence;
  lastRejection: string;
};

const MAX_INTERVAL_GAP_MS = 350;
const MAX_UNION_MS = 2_000;
const FINAL_DEADLINE_MS = 1_000;
const PENDING_TTL_MS = MAX_UNION_MS + FINAL_DEADLINE_MS;

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
  private pendingGesture?: GestureEvidence;
  private readonly utteranceIds = new BoundedIds();
  private readonly gestureIds = new BoundedIds();
  private lastRejection = "";

  constructor(
    private readonly onAccepted: (attempt: CastAttempt) => void,
    private readonly onRejected: (rejection: CastRejection) => void = () => {},
  ) {}

  beginUtterance(onset: UtteranceOnset): void {
    this.assertOnset(onset);
    if (!this.acceptGeneration(onset.generation)) return;
    this.advance(onset.startMs);
    if (this.utteranceIds.has(onset.id)) {
      this.lastRejection = "duplicate-utterance-id";
      return;
    }
    this.utteranceIds.add(onset.id);
    if (this.activeUtterance || this.pendingUtterance) {
      this.reject("second-utterance-onset");
      return;
    }
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

  pushGesture(evidence: GestureEvidence): void {
    this.assertGesture(evidence);
    if (!this.acceptGeneration(evidence.generation)) return;
    this.advance(evidence.endMs);
    if (this.gestureIds.has(evidence.id)) {
      this.lastRejection = "duplicate-gesture-id";
      return;
    }
    this.gestureIds.add(evidence.id);
    if (this.pendingGesture) {
      this.reject("multiple-gesture-candidates");
      return;
    }
    this.pendingGesture = { ...evidence };
    this.lastRejection = "";
    this.tryPair();
  }

  advance(nowMs: number): void {
    if (!Number.isFinite(nowMs)) throw new Error("Fusion time must be finite");
    const oldestStart = Math.min(
      this.activeUtterance?.startMs ?? Infinity,
      this.pendingUtterance?.startMs ?? Infinity,
      this.pendingGesture?.startMs ?? Infinity,
    );
    if (oldestStart !== Infinity && nowMs - oldestStart > PENDING_TTL_MS)
      this.reject("pending-evidence-expired");
  }

  reset(generation?: number): void {
    this.generation = generation;
    this.activeUtterance = undefined;
    this.pendingUtterance = undefined;
    this.pendingGesture = undefined;
    this.utteranceIds.clear();
    this.gestureIds.clear();
    this.lastRejection = "";
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
    const gesture = this.pendingGesture;
    if (!voice || !gesture || this.generation === undefined) return;
    const gap = Math.max(
      0,
      voice.startMs - gesture.endMs,
      gesture.startMs - voice.endMs,
    );
    const union =
      Math.max(voice.endMs, gesture.endMs) -
      Math.min(voice.startMs, gesture.startMs);
    if (gap > MAX_INTERVAL_GAP_MS || union > MAX_UNION_MS) {
      this.reject("evidence-timing-mismatch");
      return;
    }
    const requiredGesture = voice.spell === "protego" || voice.spell === "episkey"
      ? "protego"
      : "stupefy";
    if (gesture.spell !== requiredGesture && gesture.spell !== voice.spell) {
      this.reject("spell-gesture-mismatch");
      return;
    }
    const attempt: CastAttempt = {
      id: `${this.generation}:cast:${gesture.id}:${voice.id}`,
      spell: voice.spell,
      gestureId: gesture.id,
      utteranceId: voice.id,
      generation: this.generation,
    };
    this.activeUtterance = undefined;
    this.pendingUtterance = undefined;
    this.pendingGesture = undefined;
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

  private reject(reason: string): void {
    const voice = this.pendingUtterance;
    const gesture = this.pendingGesture;
    this.activeUtterance = undefined;
    this.pendingUtterance = undefined;
    this.pendingGesture = undefined;
    this.lastRejection = reason;
    // Only a confirmed incantation can produce a fizzle; silence, stale input and
    // ASR cancellation must never look like an attempted spell.
    if (voice && (reason === "spell-gesture-mismatch" || reason === "evidence-timing-mismatch" ||
      reason === "pending-evidence-expired" || reason === "multiple-gesture-candidates"))
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

  private assertGesture(evidence: GestureEvidence): void {
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
