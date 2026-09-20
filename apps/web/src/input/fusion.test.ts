import { describe, expect, it } from "vitest";
import {
  CastFusion,
  type CastAttempt,
  type CastRejection,
  type UtteranceEvidence,
} from "./fusion";
import type { GestureEvidence, SpellName } from "./motion";
import type { Spell } from "../game/contracts";
import type { AccelerationSpikeEvidence } from "./spike";

function spike(id: string, startMs: number, endMs: number, generation = 4): AccelerationSpikeEvidence {
  return { id, kind: "acceleration-spike", startMs, endMs, generation, quality: 0.8 };
}

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
  it("reports one fizzle only for a confirmed incantation, never cancellation or silent motion", () => {
    const attempts: CastAttempt[] = [], rejections: CastRejection[] = [];
    const fusion = new CastFusion(attempt => attempts.push(attempt), rejection => rejections.push(rejection));
    finish(fusion, utterance("wrong", "protego", 1_000, 1_500));
    fusion.pushGesture(gesture("jab", "stupefy", 1_300, 1_700));
    expect(rejections).toHaveLength(0);
    fusion.advance(8_001);
    expect(rejections).toMatchObject([{ reason: "spell-gesture-mismatch", utterance: { id: "wrong", spell: "protego" }, gesture: { id: "jab" } }]);
    fusion.advance(8_500);
    expect(rejections).toHaveLength(1);
    fusion.pushGesture(gesture("silent", "protego", 9_000, 9_400));
    fusion.advance(17_001);
    finish(fusion, utterance("cancelled", "protego", 18_000, 18_400));
    fusion.cancelUtterance("cancelled", 4);
    fusion.advance(19_001);
    expect(rejections).toHaveLength(1);
    finish(fusion, utterance("no-motion", "episkey", 20_000, 20_400));
    fusion.advance(27_001);
    expect(rejections.at(-1)).toMatchObject({ reason: "pending-evidence-expired", utterance: { spell: "episkey" } });
    finish(fusion, utterance("correct", "protego", 29_000, 29_500));
    fusion.pushGesture(gesture("raise", "protego", 29_300, 29_700));
    expect(attempts.map(attempt => attempt.spell)).toEqual(["protego"]);
    expect(rejections).toHaveLength(2);
  });

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
    "retains gesture type and fizzles a wrong movement after the pairing window for %s",
    (spell) => {
      const attempts: CastAttempt[] = [];
      const fusion = new CastFusion((attempt) => attempts.push(attempt));
      finish(fusion, utterance("voice", spell, 1_000, 1_500));
      fusion.pushGesture(gesture("motion", spell === "episkey" ? "stupefy" : "protego", 1_300, 1_700));
      expect(attempts).toHaveLength(0);
      fusion.advance(8_001);
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
        timing: { speechStartMs: 1_000, speechEndMs: 1_500, speechFinalAtMs: 1_800,
          gestureStartMs: 1_300, gestureEndMs: 1_700, order: "overlap", gapMs: 0 },
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

    fusion.advance(8_001);
    expect(fusion.getState()).toMatchObject({
      pendingUtterance: undefined,
      lastRejection: "pending-evidence-expired",
    });

    fusion.pushGesture(gesture("gesture", "protego", 9_000, 9_400));
    expect(fusion.getState().pendingGesture?.id).toBe("gesture");
    fusion.advance(17_001);
    expect(fusion.getState().lastRejection).toBe("pending-evidence-expired");
  });

  it("waits for a fitting gesture instead of rejecting the word on an unrelated candidate", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.pushGesture(gesture("old-raise", "protego", 100, 400));
    fusion.pushGesture(gesture("wrong", "protego", 1_100, 1_450));
    finish(fusion, utterance("voice", "stupefy", 1_000, 1_500));
    expect(attempts).toEqual([]);
    fusion.pushGesture(gesture("delayed-jab", "stupefy", 1_650, 2_100));
    expect(attempts.map(value => value.gestureId)).toEqual(["delayed-jab"]);
    fusion.pushGesture(gesture("wrong", "protego", 1_100, 1_450));
    expect(attempts).toHaveLength(1);
  });

  it("invalidates overlapping unconfirmed speech but retains multiple movement candidates", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.pushGesture(gesture("gesture-a", "stupefy", 900, 1_200));
    fusion.beginUtterance({ id: "voice-a", generation: 4, startMs: 1_000 });
    fusion.beginUtterance({ id: "voice-b", generation: 4, startMs: 1_100 });
    expect(fusion.getState()).toMatchObject({ activeUtterance: undefined,
      pendingGesture: undefined, lastRejection: "second-utterance-onset" });
    fusion.pushGesture(gesture("gesture-b", "stupefy", 3_000, 3_300));
    fusion.pushGesture(gesture("gesture-c", "protego", 3_200, 3_700));
    finish(fusion, utterance("voice-c", "protego", 3_200, 3_800));
    expect(attempts.map(value => value.gestureId)).toEqual(["gesture-c"]);
  });

  it("accepts a two-second gap and six-second span but rejects beyond either bound", () => {
    for (const [motion, expected] of [
      [gesture("boundary", "stupefy", 3_000, 3_300), 1],
      [gesture("late", "stupefy", 3_001, 3_300), 0],
      [gesture("long", "stupefy", 2_800, 6_000), 1],
      [gesture("overlong", "stupefy", 2_800, 6_001), 0],
    ] as const) {
      const attempts: CastAttempt[] = [];
      const fusion = new CastFusion(value => attempts.push(value));
      finish(fusion, utterance("voice", "stupefy", 0, 1_000, 1_500));
      fusion.pushGesture(motion);
      fusion.advance(7_001);
      expect(attempts.length, motion.id).toBe(expected);
    }
  });

  it.each(["speech-first", "motion-first"] as const)("pairs %s capture intervals in either callback order at the same boundary", order => {
    for (const gap of [0, 1_500, 2_000, 2_001]) {
      const voice = utterance("word", "protego", 3_000, 3_500, 4_500);
      const motion = order === "speech-first"
        ? gesture("raise", "protego", 3_500 + gap, 4_100 + gap)
        : gesture("raise", "protego", 2_400 - gap, 3_000 - gap);
      for (const finalFirst of [true, false]) {
        const attempts: CastAttempt[] = [];
        const fusion = new CastFusion(value => attempts.push(value));
        fusion.beginUtterance(voice);
        if (finalFirst) fusion.pushUtterance(voice);
        fusion.pushGesture(motion);
        if (!finalFirst) fusion.pushUtterance(voice);
        expect(attempts.length, `${order}, gap=${gap}, finalFirst=${finalFirst}`).toBe(gap <= 2_000 ? 1 : 0);
        if (gap > 0 && gap <= 2_000) expect(attempts[0].timing).toMatchObject({ order, gapMs: gap });
      }
    }
  });

  it("arms one confirmed spell through subsequent sounds until its gesture is consumed", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("first", "protego", 1_000, 1_500, 1_700));
    fusion.beginUtterance({ id: "next", generation: 4, startMs: 1_850 });
    // The raise settles after the next onset callback, but was captured before it.
    fusion.pushGesture(gesture("raise", "protego", 1_400, 1_800));
    expect(attempts.map(value => value.spell)).toEqual(["protego"]);
    expect(fusion.getState().activeUtterance).toBeUndefined();
    fusion.pushGesture(gesture("jab", "stupefy", 2_100, 2_500));
    fusion.pushUtterance(utterance("next", "incendio", 1_850, 2_200, 2_600));
    expect(attempts.map(value => value.spell)).toEqual(["protego"]);
    finish(fusion, utterance("fresh", "incendio", 2_600, 2_900));
    expect(attempts.map(value => value.spell)).toEqual(["protego", "incendio"]);
  });

  it.each(["cancel", "continuation"] as const)("retains an armed word through an ambiguous later sound after %s", ending => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("word", "protego", 0, 400, 800));
    fusion.beginUtterance({ id: "newer", generation: 4, startMs: 1_000 });
    if (ending === "cancel") fusion.cancelUtterance("newer", 4);
    else fusion.beginUtterance({ id: "tail", generation: 4, startMs: 1_200 });
    expect(fusion.getState().pendingUtterance?.id).toBe("word");
    fusion.cancelUtterance("newer", 4);
    fusion.pushUtterance(utterance("newer", "stupefy", 1_000, 1_300, 1_500));
    fusion.pushGesture(gesture("ambiguous", "protego", 900, 1_400));
    fusion.pushGesture(gesture("ambiguous", "protego", 900, 1_400));
    expect(attempts.map(value => [value.utteranceId, value.gestureId])).toEqual([["word", "ambiguous"]]);
  });

  it("protects confirmed speech from later noise and accepts a delayed classified raise once", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("spell", "protego", 1_000, 1_600, 2_000));
    fusion.beginUtterance({ id: "noise", generation: 4, startMs: 1_970 });
    fusion.cancelUtterance("noise", 4);
    fusion.pushUtterance(utterance("noise", "stupefy", 1_970, 2_100, 2_300));
    fusion.pushGesture(gesture("raise", "protego", 2_300, 2_900));
    fusion.pushGesture(gesture("raise", "protego", 2_300, 2_900));
    expect(attempts.map(value => value.spell)).toEqual(["protego"]);
  });

  it("does not let an old movement shorten the lifetime of a later word and movement", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.pushGesture(gesture("old", "protego", 0, 100));
    fusion.pushGesture(gesture("recent", "protego", 4_000, 4_400));
    finish(fusion, utterance("word", "protego", 4_800, 5_200));
    expect(attempts.map(value => value.gestureId)).toEqual(["recent"]);
  });

  it("admits a replacement command after two seconds instead of locking speech for the seven-second retention TTL", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("first", "stupefy", 1_000, 1_500));
    fusion.beginUtterance({ id: "second", generation: 4, startMs: 3_501 });
    expect(fusion.getState().pendingUtterance).toBeUndefined();
    fusion.pushGesture(gesture("second-jab", "stupefy", 3_600, 3_900));
    expect(attempts).toEqual([]);
    fusion.pushUtterance(utterance("second", "incendio", 3_501, 4_000));
    expect(attempts.map(value => value.spell)).toEqual(["incendio"]);
    finish(fusion, utterance("first", "stupefy", 1_000, 1_500));
    expect(attempts).toHaveLength(1);
  });

  it("casts during later noise without waiting for that noise to resolve", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("word", "protego", 1_000, 1_500));
    fusion.beginUtterance({ id: "noise", generation: 4, startMs: 1_800 });
    fusion.pushGesture(gesture("raise", "protego", 1_700, 2_100));
    expect(attempts.map(value => value.spell)).toEqual(["protego"]);
    fusion.cancelUtterance("noise", 4);
    expect(attempts.map(value => value.spell)).toEqual(["protego"]);
  });

  it("retains a recent motion-first candidate when a new command replaces an expired armed word", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("old", "protego", 1_000, 1_500));
    fusion.pushGesture(gesture("new-jab", "stupefy", 3_100, 3_400));
    finish(fusion, utterance("new", "stupefy", 3_501, 3_900));
    expect(attempts.map(value => [value.spell, value.gestureId])).toEqual([["stupefy", "new-jab"]]);
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

  it("cancels only the matching utterance and consumes its old gesture without changing generations", () => {
    const fusion = new CastFusion(() => undefined);
    const oldGesture = gesture("old-gesture", "stupefy", 1_000, 1_300);
    fusion.beginUtterance({ id: "voice", generation: 4, startMs: 1_000 });
    fusion.pushGesture(oldGesture);
    const original = fusion.getState();
    fusion.cancelUtterance("voice", 5);
    fusion.cancelUtterance("different-voice", 4);
    expect(fusion.getState()).toEqual(original);
    fusion.cancelUtterance("voice", 4);
    expect(fusion.getState()).toMatchObject({
      generation: 4,
      activeUtterance: undefined,
      pendingGesture: undefined,
      lastRejection: "utterance-discarded",
    });
    fusion.pushGesture(oldGesture);
    expect(fusion.getState().pendingGesture).toBeUndefined();
    expect(fusion.getState().lastRejection).toBe("duplicate-gesture-id");

    fusion.reset(5);
    finish(fusion, utterance("voice", "stupefy", 2_000, 2_300, 2_500, 5));
    const fresh = fusion.getState();
    fusion.cancelUtterance("voice", 4);
    expect(fusion.getState()).toEqual(fresh);
    fusion.cancelUtterance("voice", 5);
    expect(fusion.getState().pendingUtterance).toBeUndefined();
  });
});

describe("optional simple motion fusion", () => {
  it.each(["stupefy", "protego", "incendio", "expelliarmus", "episkey"] as const)(
    "selects %s only from speech with the same directionless evidence in either arrival order", spell => {
      for (const motionFirst of [true, false]) {
        const attempts: CastAttempt[] = [];
        const fusion = new CastFusion(value => attempts.push(value));
        fusion.setSimpleMotion(true);
        if (motionFirst) fusion.pushGesture(spike("motion", 1_300, 1_320));
        finish(fusion, utterance("voice", spell, 1_000, 1_500));
        if (!motionFirst) fusion.pushGesture(spike("motion", 1_300, 1_320));
        expect(attempts.map(value => value.spell)).toEqual([spell]);
      }
    },
  );

  it("defaults off and accepts only its enabled evidence type without poisoning the valid attempt", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("normal", "protego", 1_000, 1_500));
    fusion.pushGesture(spike("ignored-simple", 1_300, 1_320));
    expect(attempts).toHaveLength(0);
    fusion.pushGesture(gesture("raise", "protego", 1_300, 1_500));
    fusion.setSimpleMotion(true);
    finish(fusion, utterance("simple", "episkey", 3_000, 3_500));
    fusion.pushGesture(gesture("ignored-typed", "protego", 3_300, 3_500));
    expect(attempts).toHaveLength(1);
    fusion.pushGesture(spike("simple-motion", 3_300, 3_320));
    expect(attempts.map(value => value.spell)).toEqual(["protego", "episkey"]);
  });

  it("retains a confirmed word across a late noise onset, discarded final and no-speech cancellation", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.setSimpleMotion(true);
    finish(fusion, utterance("word", "stupefy", 1_000, 1_500, 1_600));
    fusion.beginUtterance({ id: "noise", generation: 4, startMs: 1_650 });
    fusion.cancelUtterance("noise", 4);
    fusion.pushUtterance(utterance("noise", "protego", 1_650, 1_700, 1_750));
    expect(fusion.getState().pendingUtterance?.id).toBe("word");
    fusion.pushGesture(spike("motion", 1_800, 1_820));
    fusion.pushGesture(spike("extra-motion", 1_840, 1_860));
    finish(fusion, utterance("word", "stupefy", 1_000, 1_500, 1_600));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ spell: "stupefy", utteranceId: "word", gestureId: "motion" });
  });

  it("keeps the first fitting spike through repeated motion and does not reuse consumed evidence", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.setSimpleMotion(true);
    fusion.pushGesture(spike("unrelated", 400, 420));
    fusion.beginUtterance({ id: "word", generation: 4, startMs: 1_000 });
    expect(fusion.getState().pendingGesture).toBeUndefined();
    fusion.pushGesture(spike("first", 1_100, 1_120));
    fusion.pushGesture(spike("second", 1_400, 1_420));
    expect(fusion.getState().pendingGesture?.id).toBe("first");
    fusion.pushUtterance(utterance("word", "incendio", 1_000, 1_500));
    expect(attempts[0].gestureId).toBe("first");
    fusion.pushGesture(spike("first", 1_100, 1_120));
    fusion.pushGesture(spike("second", 1_400, 1_420));
    finish(fusion, utterance("word", "incendio", 1_000, 1_500));
    expect(attempts).toHaveLength(1);
    expect(fusion.getState().pendingGesture).toBeUndefined();
  });

  it("selects the first temporally relevant spike when an earlier one exceeds the 2 s union", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.setSimpleMotion(true);
    fusion.beginUtterance({ id: "word", generation: 4, startMs: 1_000 });
    fusion.pushGesture(spike("too-early", 700, 720));
    fusion.pushGesture(spike("fits", 1_200, 1_220));
    fusion.pushGesture(spike("also-fits", 1_800, 1_820));
    fusion.pushUtterance(utterance("word", "protego", 1_000, 3_000, 3_900));
    expect(attempts.map(value => value.gestureId)).toEqual(["fits"]);
  });

  it("expires an old background spike without erasing a recent spike before speech onset", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.setSimpleMotion(true);
    fusion.pushGesture(spike("old", 0, 20));
    fusion.pushGesture(spike("recent", 2_900, 2_920));
    finish(fusion, utterance("word", "stupefy", 3_100, 3_500, 3_800));
    expect(attempts.map(value => value.gestureId)).toEqual(["recent"]);
  });

  it("keeps all timing limits and leaves quiet, voice-only, motion-only and stale evidence uncast", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    fusion.setSimpleMotion(true);
    fusion.advance(500);
    finish(fusion, utterance("alone", "protego", 1_000, 1_500));
    fusion.advance(4_001);
    fusion.pushGesture(spike("silent", 5_000, 5_020));
    fusion.advance(8_001);
    finish(fusion, utterance("gap", "protego", 9_000, 9_500));
    fusion.pushGesture(spike("too-late", 9_851, 9_871));
    fusion.advance(12_001);
    finish(fusion, utterance("late-final", "protego", 13_000, 13_500, 14_501));
    fusion.pushGesture(spike("late-final-motion", 13_200, 13_220));
    fusion.advance(17_000);
    expect(attempts).toHaveLength(0);
    finish(fusion, utterance("boundary", "episkey", 18_000, 18_500, 19_500));
    fusion.pushGesture(spike("boundary-motion", 18_850, 18_870));
    expect(attempts).toHaveLength(1);
  });

  it("clears pending evidence on mode changes and generations while retaining mode and consumed IDs", () => {
    const attempts: CastAttempt[] = [];
    const fusion = new CastFusion(value => attempts.push(value));
    finish(fusion, utterance("old-normal", "protego", 1_000, 1_500));
    fusion.setSimpleMotion(true);
    fusion.pushGesture(spike("old-spike", 1_300, 1_320));
    finish(fusion, utterance("old-normal", "protego", 1_000, 1_500));
    expect(attempts).toHaveLength(0);
    fusion.setSimpleMotion(false);
    expect(fusion.getState().pendingGesture).toBeUndefined();
    fusion.setSimpleMotion(true);
    fusion.pushGesture(spike("old-spike", 1_300, 1_320));
    expect(fusion.getState().pendingGesture).toBeUndefined();
    fusion.reset(5);
    finish(fusion, utterance("new", "protego", 2_000, 2_500, 2_800, 5));
    fusion.pushGesture(spike("new-spike", 2_300, 2_320, 5));
    expect(attempts).toHaveLength(1);
    fusion.pushGesture(spike("old-generation", 3_000, 3_020, 5));
    fusion.beginUtterance({ id: "trigger", startMs: 3_000, generation: 6 });
    expect(fusion.getState()).toMatchObject({ pendingGesture: undefined, activeUtterance: undefined, lastRejection: "generation-changed" });
  });

  it("still invalidates two overlapping unconfirmed utterances in simple mode", () => {
    const fusion = new CastFusion(() => {});
    fusion.setSimpleMotion(true);
    fusion.beginUtterance({ id: "first", startMs: 1_000, generation: 4 });
    fusion.beginUtterance({ id: "second", startMs: 1_050, generation: 4 });
    expect(fusion.getState()).toMatchObject({ activeUtterance: undefined, lastRejection: "second-utterance-onset" });
  });
});
