import { describe, expect, it } from "vitest";
import {
  CastFusion,
  type CastAttempt,
  type UtteranceEvidence,
} from "./fusion";
import type { GestureEvidence, SpellName } from "./motion";
import type { Spell } from "../game/contracts";

function gesture(
  id: string,
  spell: SpellName,
  startMs: number,
  endMs: number,
  generation = 4,
): GestureEvidence {
  return { id, spell, startMs, endMs, generation, quality: 0.8 };
}

function utterance(
  id: string,
  spell: Spell,
  startMs: number,
  endMs: number,
  finalAtMs = endMs + 300,
  generation = 4,
): UtteranceEvidence {
  return { id, spell, startMs, endMs, finalAtMs, generation };
}

function finish(fusion: CastFusion, evidence: UtteranceEvidence): void {
  fusion.beginUtterance({
    id: evidence.id,
    generation: evidence.generation,
    startMs: evidence.startMs,
  });
  fusion.pushUtterance(evidence);
}

describe("speech and gesture fusion", () => {
  it.each([
    ["stupefy", "stupefy"],
    ["expelliarmus", "stupefy"],
    ["incendio", "stupefy"],
    ["protego", "protego"],
    ["episkey", "protego"],
  ] as const)("selects %s from speech and the %s movement", (spell, movement) => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion((attempt) => attempts.push(attempt));
    finish(fusion, utterance("voice", spell, 1_000, 1_500));
    fusion.pushGesture(gesture("motion", movement, 1_300, 1_700));
    expect(attempts.map((attempt) => attempt.spell)).toEqual([spell]);
  });

  it.each(["incendio", "expelliarmus", "episkey"] as const)(
    "rejects the wrong movement for %s without weakening fusion timing",
    (spell) => {
      const attempts: CastAttempt[] = [];
      const fusion = new CastFusion((attempt) => attempts.push(attempt));
      finish(fusion, utterance("voice", spell, 1_000, 1_500));
      fusion.pushGesture(gesture("motion", spell === "episkey" ? "stupefy" : "protego", 1_300, 1_700));
      expect(attempts).toHaveLength(0);
      expect(fusion.getState().lastRejection).toBe("spell-gesture-mismatch");
    },
  );

  it("accepts either arrival order once and consumes duplicate IDs", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion((attempt) => attempts.push(attempt));
    const voice = utterance("voice-1", "stupefy", 1_000, 1_500);
    const motion = gesture("gesture-1", "stupefy", 1_300, 1_700);

    finish(fusion, voice);
    fusion.pushGesture(motion);
    finish(fusion, voice);
    fusion.pushGesture(motion);

    expect(attempts).toEqual([
      {
        id: "4:cast:gesture-1:voice-1",
        spell: "stupefy",
        gestureId: "gesture-1",
        utteranceId: "voice-1",
        generation: 4,
      },
    ]);

    const secondVoice = utterance("voice-2", "protego", 3_000, 3_400);
    const secondMotion = gesture("gesture-2", "protego", 3_250, 3_700);
    fusion.pushGesture(secondMotion);
    finish(fusion, secondVoice);
    expect(attempts.map((attempt) => attempt.spell)).toEqual([
      "stupefy",
      "protego",
    ]);
  });

  it("keeps speech-only and motion-only evidence pending until bounded expiry", () => {
    const fusion = new CastFusion(() => undefined);
    finish(fusion, utterance("voice", "stupefy", 1_000, 1_400));
    expect(fusion.getState().pendingUtterance?.id).toBe("voice");
    expect(fusion.getState().lastRejection).toBe("");

    fusion.advance(4_001);
    expect(fusion.getState()).toMatchObject({
      pendingUtterance: undefined,
      lastRejection: "pending-evidence-expired",
    });

    fusion.pushGesture(gesture("gesture", "protego", 5_000, 5_400));
    expect(fusion.getState().pendingGesture?.id).toBe("gesture");
    fusion.advance(8_001);
    expect(fusion.getState().lastRejection).toBe("pending-evidence-expired");
  });

  it("rejects only after contradictory spell or timing evidence exists", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion((attempt) => attempts.push(attempt));

    finish(fusion, utterance("voice-a", "stupefy", 1_000, 1_300));
    expect(fusion.getState().lastRejection).toBe("");
    fusion.pushGesture(gesture("gesture-a", "protego", 1_100, 1_450));
    expect(fusion.getState().lastRejection).toBe("spell-gesture-mismatch");

    finish(fusion, utterance("voice-b", "protego", 3_000, 3_250));
    fusion.pushGesture(gesture("gesture-b", "protego", 3_601, 3_900));
    expect(fusion.getState().lastRejection).toBe("evidence-timing-mismatch");
    expect(attempts).toHaveLength(0);
  });

  it("invalidates the whole attempt on a second onset or gesture candidate", () => {
    const fusion = new CastFusion(() => undefined);
    fusion.pushGesture(gesture("gesture-a", "stupefy", 900, 1_200));
    fusion.beginUtterance({ id: "voice-a", generation: 4, startMs: 1_000 });
    fusion.beginUtterance({ id: "voice-b", generation: 4, startMs: 1_100 });
    expect(fusion.getState()).toMatchObject({
      activeUtterance: undefined,
      pendingGesture: undefined,
      lastRejection: "second-utterance-onset",
    });

    fusion.pushGesture(gesture("gesture-b", "protego", 3_000, 3_300));
    fusion.pushGesture(gesture("gesture-c", "protego", 3_100, 3_400));
    expect(fusion.getState()).toMatchObject({
      pendingGesture: undefined,
      lastRejection: "multiple-gesture-candidates",
    });
  });

  it("enforces final deadline while accepting exact timing boundaries", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion((attempt) => attempts.push(attempt));
    const late = utterance("late", "stupefy", 1_000, 1_400, 2_401);
    finish(fusion, late);
    expect(fusion.getState().lastRejection).toBe(
      "utterance-final-missed-deadline",
    );

    const boundaryVoice = utterance(
      "boundary-voice",
      "stupefy",
      4_000,
      4_500,
      5_500,
    );
    finish(fusion, boundaryVoice);
    fusion.pushGesture(
      gesture("boundary-gesture", "stupefy", 4_850, 5_150),
    );
    expect(attempts).toHaveLength(1);
  });

  it("drops the triggering evidence when generations change", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion((attempt) => attempts.push(attempt));
    fusion.pushGesture(gesture("old-gesture", "stupefy", 1_000, 1_300, 4));
    fusion.beginUtterance({ id: "new-voice", generation: 5, startMs: 1_100 });
    expect(fusion.getState()).toMatchObject({
      generation: 5,
      pendingGesture: undefined,
      activeUtterance: undefined,
      lastRejection: "generation-changed",
    });

    const voice = utterance("new-voice", "stupefy", 2_000, 2_300, 2_500, 5);
    finish(fusion, voice);
    fusion.pushGesture(gesture("new-gesture", "stupefy", 2_100, 2_450, 5));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].generation).toBe(5);
  });
});
