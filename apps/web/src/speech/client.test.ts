import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserSpeechPlatform,
  SpeechClient,
  type SpeechClientPlatform,
  type SpeechEvidence,
  type SpeechDiagnostic,
  type SpeechDiscard,
} from "./client";
import {
  SPEECH_SAMPLE_RATE,
  type CapturedAudioFrame,
} from "./endpoint";
import { CastFusion, type CastAttempt } from "../input/fusion";
import type { GestureEvidence } from "../input/motion";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakePlatform implements SpeechClientPlatform {
  nowMs = 0;
  frame = 0;
  generation = 0;
  idCounter = 0;
  stopped = false;
  transcriptions: Deferred<Response>[] = [];
  requests: { url: string; init?: RequestInit }[] = [];
  private onFrame?: (frame: CapturedAudioFrame, timeOriginMs: number) => void;
  private invalidated?: (issue: string) => void;

  now = () => this.nowMs;
  createId = () => `utterance-${++this.idCounter}`;
  isHidden = () => false;
  watchLifecycle = (listener: (issue: string) => void) => {
    this.invalidated = listener;
    return () => {
      this.invalidated = undefined;
    };
  };
  openCapture: SpeechClientPlatform["openCapture"] = async (
    generation,
    _workletUrl,
    onFrame,
  ) => {
    this.generation = generation;
    this.onFrame = onFrame;
    return { stop: () => { this.stopped = true; } };
  };
  request: typeof fetch = async (input, init) => {
    const url = String(input);
    this.requests.push({ url, init });
    if (url.endsWith("/health")) {
      return Response.json({
        status: "ok",
        ready: true,
        warm: true,
        busy: false,
        workerAvailable: true,
      });
    }
    const pending = deferred<Response>();
    this.transcriptions.push(pending);
    return pending.promise;
  };

  feed(amplitude: number, count: number): void {
    for (let index = 0; index < count; index++) {
      const samples = new Float32Array(128).fill(amplitude);
      this.onFrame?.(
        {
          generation: this.generation,
          startFrame: this.frame,
          sampleRate: SPEECH_SAMPLE_RATE,
          channelCount: 1,
          rms: Math.abs(amplitude),
          samples,
          discontinuity: false,
          nonFinite: false,
        },
        0,
      );
      this.frame += samples.length;
      this.nowMs = (this.frame * 1000) / SPEECH_SAMPLE_RATE;
    }
  }

  calibrate(): void {
    this.feed(0.002, 250);
  }

  utterance(): void {
    this.feed(0.08, 20);
    this.feed(0.001, 25);
  }

  hide(): void {
    this.invalidated?.("Page hidden or suspended; speech evidence was cleared");
  }

  gap(): void {
    this.frame += 128;
    this.feed(0.002, 1);
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function fuseSpeech(client: SpeechClient) {
  const casts: CastAttempt[] = [];
  const fusion = new CastFusion((attempt) => casts.push(attempt));
  client.onOnset((event) => fusion.beginUtterance(event));
  client.onSpeech((event) => fusion.pushUtterance({ ...event, finalAtMs: event.arrivedMs }));
  client.onDiscard((event) => fusion.cancelUtterance(event.id, event.generation, event.disposition));
  return { fusion, casts };
}

function matchingGesture(headers: Headers, id: string, spell: "stupefy" | "protego" = "stupefy"): GestureEvidence {
  return {
    id,
    spell,
    startMs: Number(headers.get("X-Wand-Voice-Start-Ms")),
    endMs: Number(headers.get("X-Wand-Voice-End-Ms")),
    generation: Number(headers.get("X-Wand-Generation")),
    quality: 0.9,
  };
}

describe("speech client lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps rejected transcript diagnostics without accepting uncertain spell evidence", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const evidence: SpeechEvidence[] = [];
    const diagnostics: SpeechDiagnostic[] = [];
    client.onSpeech((item) => evidence.push(item));
    client.onDiagnostic((item) => diagnostics.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    platform.transcriptions[0].resolve(Response.json({
      utteranceId: headers.get("X-Wand-Utterance-Id"),
      generation: Number(headers.get("X-Wand-Generation")),
      text: "Stupefy", transcript: "Stupefy.", spell: null, accepted: false,
      reason: "low-confidence", inferenceMs: 200, noSpeechProbability: 0.9,
    }));
    await flush();
    expect(evidence).toEqual([]);
    expect(client.getSnapshot()).toMatchObject({ phase: "listening", issue: "" });
    expect(diagnostics.at(-1)).toMatchObject({ type: "result", transcript: "Stupefy.",
      detail: "low-confidence", inferenceMs: 200, noSpeechProbability: 0.9 });
    client.stop();
  });

  it("clears a lost audio interval, recalibrates automatically, and accepts only fresh speech", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    await client.start();
    platform.calibrate();
    platform.utterance();
    const old = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(old, "lost-gesture"));
    platform.gap();
    expect(client.getSnapshot()).toMatchObject({ phase: "calibrating", issue: "" });
    expect(fusion.getState().pendingGesture).toBeUndefined();
    platform.transcriptions[0].resolve(Response.json({ utteranceId: old.get("X-Wand-Utterance-Id"),
      generation: Number(old.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(casts).toEqual([]);
    expect(platform.stopped).toBe(false);
    platform.calibrate();
    platform.utterance();
    const fresh = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(fresh, "fresh-gesture"));
    platform.transcriptions[1].resolve(Response.json({ utteranceId: fresh.get("X-Wand-Utterance-Id"),
      generation: Number(fresh.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(casts).toHaveLength(1);
    expect(casts[0].gestureId).toBe("fresh-gesture");
    client.stop();
  });

  it("surfaces a persistent helper failure only after three fresh attempts", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    await client.start();
    platform.calibrate();
    for (let index = 0; index < 3; index++) {
      platform.utterance();
      platform.transcriptions[index].resolve(new Response(null, { status: 503 }));
      await flush();
      expect(client.getSnapshot().phase).toBe(index < 2 ? "listening" : "fault");
    }
    expect(platform.stopped).toBe(true);
    client.stop();
  });

  it.each(["stupefy", "protego", "expelliarmus", "incendio", "episkey"])(
    "calibrates, sends bounded raw PCM, and emits exact %s evidence", async (spell) => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const evidence: SpeechEvidence[] = [];
    client.onSpeech((item) => evidence.push(item));
    await client.start();
    expect(platform.requests[0]).toMatchObject({
      url: "/api/speech/health",
      init: { method: "POST" },
    });
    platform.calibrate();
    expect(client.getSnapshot().phase).toBe("listening");

    platform.utterance();
    expect(client.getSnapshot().phase).toBe("busy");
    const request = platform.requests.at(-1)!;
    const headers = new Headers(request.init?.headers);
    expect(request.url).toBe("/api/speech/transcribe");
    expect(headers.get("X-Wand-Audio-Format")).toBe("pcm_s16le");
    expect(headers.get("X-Wand-Sample-Rate")).toBe("16000");
    expect(headers.get("X-Wand-Channels")).toBe("1");
    expect((request.init?.body as ArrayBuffer).byteLength).toBeLessThanOrEqual(
      96_000,
    );

    const utteranceId = headers.get("X-Wand-Utterance-Id")!;
    const generation = Number(headers.get("X-Wand-Generation"));
    platform.transcriptions[0].resolve(
      Response.json({
        utteranceId,
        generation,
        text: `${spell.toUpperCase()}!`,
        spell,
      }),
    );
    await flush();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      id: utteranceId,
      generation,
      spell,
    });
    expect(evidence[0].endMs).toBeLessThan(evidence[0].arrivedMs);
    expect(client.getSnapshot().phase).toBe("listening");
    expect(fusion.getState().pendingUtterance?.id).toBe(utteranceId);
    fusion.pushGesture(matchingGesture(headers, "later-gesture", spell === "protego" || spell === "episkey" ? "protego" : "stupefy"));
    expect(casts).toHaveLength(1);
    expect(casts[0].spell).toBe(spell);
  });

  it.each(["before", "after"])("keeps completed speech when noise re-triggers during inference and the result arrives %s the suppressed clip", async resultOrder => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const evidence: SpeechEvidence[] = [];
    const onsets: string[] = [];
    const diagnostics: SpeechDiagnostic[] = [];
    client.onSpeech((item) => evidence.push(item));
    client.onOnset((item) => onsets.push(item.id));
    client.onDiagnostic(item => diagnostics.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(1);
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(headers, "first-gesture", "protego"));
    // A modest energy bump after 200ms of quiet triggers endpointing while
    // the first job is finishing. It must not erase that completed spell.
    platform.feed(0.012, 10);
    expect(onsets).toHaveLength(1);
    expect(platform.transcriptions).toHaveLength(1);
    if (resultOrder === "after") platform.feed(0.001, 25);
    platform.transcriptions[0].resolve(
      Response.json({
        utteranceId: headers.get("X-Wand-Utterance-Id"),
        generation: Number(headers.get("X-Wand-Generation")),
        text: "Protego",
        spell: "protego",
      }),
    );
    await flush();
    if (resultOrder === "before") platform.feed(0.001, 25);
    expect(evidence).toHaveLength(1);
    expect(casts).toHaveLength(1);
    expect(casts[0].gestureId).toBe("first-gesture");
    expect(platform.transcriptions).toHaveLength(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "onset", detail: "inference-busy: later onset ignored" }),
      expect.objectContaining({ type: "discard", detail: "inference-busy" }),
    ]));
    expect(client.getSnapshot()).toMatchObject({ phase: "listening", issue: "" });
    platform.utterance();
    const fresh = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(fresh, "next-gesture", "protego"));
    platform.transcriptions[1].resolve(Response.json({ utteranceId: fresh.get("X-Wand-Utterance-Id"),
      generation: Number(fresh.get("X-Wand-Generation")), text: "Protego", spell: "protego" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["first-gesture", "next-gesture"]);
    expect(onsets).toHaveLength(2);
    client.stop();
  });

  it("suppresses noise captured during inference even when its onset confirmation arrives after the spell result", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const onsets = vi.fn();
    const diagnostics: SpeechDiagnostic[] = [];
    client.onOnset(onsets);
    client.onDiagnostic(event => diagnostics.push(event));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const first = new Headers(platform.requests.at(-1)!.init?.headers);
    // This is the recorded ordering: noise starts ~30ms before the valid
    // result, but has not yet crossed the endpoint's 60ms onset threshold.
    const noiseStartMs = platform.nowMs;
    platform.feed(0.012, 4);
    expect(onsets).toHaveBeenCalledOnce();
    platform.transcriptions[0].resolve(Response.json({ utteranceId: first.get("X-Wand-Utterance-Id"),
      generation: Number(first.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(fusion.getState().pendingUtterance?.spell).toBe("stupefy");
    platform.feed(0.012, 6);
    expect(onsets).toHaveBeenCalledOnce();
    expect(fusion.getState().pendingUtterance?.spell).toBe("stupefy");
    platform.feed(0.001, 25);
    expect(platform.transcriptions).toHaveLength(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "onset", voiceStartMs: noiseStartMs,
        detail: "inference-busy-delayed: onset captured before prior result" }),
      expect.objectContaining({ type: "discard", detail: "inference-busy-delayed" }),
    ]));
    const gesture = matchingGesture(first, "preserved-word");
    fusion.pushGesture(gesture);
    fusion.pushGesture(gesture);
    expect(casts.map(cast => cast.gestureId)).toEqual(["preserved-word"]);
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(2);
    const fresh = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(fresh, "fresh-word"));
    platform.transcriptions[1].resolve(Response.json({ utteranceId: fresh.get("X-Wand-Utterance-Id"),
      generation: Number(fresh.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["preserved-word", "fresh-word"]);
    client.stop();
  });

  it("does not suppress a genuinely new onset captured at or after the prior result", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const onsets = vi.fn();
    client.onOnset(onsets);
    await client.start();
    platform.calibrate();
    platform.utterance();
    const first = new Headers(platform.requests.at(-1)!.init?.headers);
    platform.transcriptions[0].resolve(Response.json({ utteranceId: first.get("X-Wand-Utterance-Id"),
      generation: Number(first.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    const nextStartMs = platform.nowMs;
    platform.utterance();
    expect(onsets).toHaveBeenCalledTimes(2);
    expect(onsets.mock.calls[1][0].startMs).toBe(nextStartMs);
    expect(platform.transcriptions).toHaveLength(2);
    client.stop();
  });

  it.each([4, 10])("keeps the tail of a suppressed busy-time sound fenced until quiet (%i frames before result)", async framesBeforeResult => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const onsets = vi.fn();
    const diagnostics: SpeechDiagnostic[] = [];
    client.onOnset(onsets);
    client.onDiagnostic(event => diagnostics.push(event));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const first = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(first, "retained-first"));
    // Four frames exercise delayed confirmation; ten exercise the already-busy
    // onset path. The same continuous noise then spans multiple clip limits.
    platform.feed(0.012, framesBeforeResult);
    platform.transcriptions[0].resolve(Response.json({ utteranceId: first.get("X-Wand-Utterance-Id"),
      generation: Number(first.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["retained-first"]);
    platform.feed(0.012, 500 - framesBeforeResult);
    expect(platform.transcriptions).toHaveLength(1);
    expect(onsets).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ type: "discard",
      detail: framesBeforeResult < 8 ? "inference-busy-delayed" : "inference-busy" })]));
    platform.feed(0.001, 25);
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(2);
    const fresh = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(fresh, "after-quiet"));
    platform.transcriptions[1].resolve(Response.json({ utteranceId: fresh.get("X-Wand-Utterance-Id"),
      generation: Number(fresh.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["retained-first", "after-quiet"]);
    expect(onsets).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("still invalidates a forced-cutoff pending result when speech continues and never queues that continuation", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const onsets = vi.fn();
    const diagnostics: SpeechDiagnostic[] = [];
    client.onOnset(onsets);
    client.onDiagnostic(event => diagnostics.push(event));
    await client.start();
    platform.calibrate();
    platform.feed(0.08, 225);
    const cut = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(cut, "ambiguous-gesture", "protego"));
    platform.feed(0.08, 10);
    expect(onsets).toHaveBeenCalledTimes(2);
    expect(platform.transcriptions).toHaveLength(1);
    platform.transcriptions[0].resolve(Response.json({ utteranceId: cut.get("X-Wand-Utterance-Id"),
      generation: Number(cut.get("X-Wand-Generation")), text: "Protego", spell: "protego" }));
    await flush();
    expect(casts).toEqual([]);
    platform.feed(0.08, 20);
    platform.feed(0.001, 25);
    expect(fusion.getState().pendingGesture).toBeUndefined();
    expect(platform.transcriptions).toHaveLength(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "discard", detail: "Ambiguous continuation invalidated cutoff utterance", endReason: "voice-limit" }),
      expect.objectContaining({ type: "result", detail: "Ambiguous continuation or paused cutoff discarded", endReason: "voice-limit" }),
    ]));
    platform.utterance();
    const fresh = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(fresh, "fresh-complete-gesture", "protego"));
    platform.transcriptions[1].resolve(Response.json({ utteranceId: fresh.get("X-Wand-Utterance-Id"),
      generation: Number(fresh.get("X-Wand-Generation")), text: "Protego", spell: "protego" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["fresh-complete-gesture"]);
    client.stop();
  });

  it("preserves acceptance of a cutoff clip when no continuation has invalidated it", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    await client.start();
    platform.calibrate();
    platform.feed(0.08, 225);
    const cut = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(cut, "existing-cutoff-gesture", "protego"));
    platform.feed(0.001, 25);
    platform.transcriptions[0].resolve(Response.json({ utteranceId: cut.get("X-Wand-Utterance-Id"),
      generation: Number(cut.get("X-Wand-Generation")), text: "Protego", spell: "protego" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["existing-cutoff-gesture"]);
    client.stop();
  });

  it("does not turn a cutoff tail into a new command after a fast result clears the pending job", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const onsets = vi.fn();
    client.onOnset(onsets);
    await client.start();
    platform.calibrate();
    platform.feed(0.08, 225);
    const first = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(first, "first-cutoff", "protego"));
    // The first result wins the race against the endpoint's 60ms onset delay.
    platform.transcriptions[0].resolve(Response.json({ utteranceId: first.get("X-Wand-Utterance-Id"),
      generation: Number(first.get("X-Wand-Generation")), text: "Protego", spell: "protego" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["first-cutoff"]);
    platform.feed(0.08, 300);
    expect(onsets).toHaveBeenCalledOnce();
    expect(platform.transcriptions).toHaveLength(1);
    platform.feed(0.001, 25);
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(2);
    const fresh = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(fresh, "after-quiet", "protego"));
    platform.transcriptions[1].resolve(Response.json({ utteranceId: fresh.get("X-Wand-Utterance-Id"),
      generation: Number(fresh.get("X-Wand-Generation")), text: "Protego", spell: "protego" }));
    await flush();
    expect(casts.map(cast => cast.gestureId)).toEqual(["first-cutoff", "after-quiet"]);
    expect(onsets).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it("still learns a neural-confirmed steady noise floor after a forced clip", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const onsets = vi.fn();
    client.onOnset(onsets);
    await client.start();
    platform.calibrate();
    platform.feed(0.03, 225);
    const noise = new Headers(platform.requests.at(-1)!.init?.headers);
    platform.transcriptions[0].resolve(Response.json({ utteranceId: noise.get("X-Wand-Utterance-Id"),
      generation: Number(noise.get("X-Wand-Generation")), text: "", spell: null, accepted: false, reason: "no-speech" }));
    await flush();
    platform.feed(0.03, 125);
    expect(platform.transcriptions).toHaveLength(1);
    expect(onsets).toHaveBeenCalledOnce();
    platform.feed(0.08, 20);
    platform.feed(0.03, 25);
    expect(platform.transcriptions).toHaveLength(2);
    expect(onsets).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it.each([1, 20])(
    "keeps capture warm but discards speech begun %i quanta before recognition resumes",
    async (beforeResume) => {
      const platform = new FakePlatform();
      const client = new SpeechClient(platform);
      const evidence: SpeechEvidence[] = [];
      const onset = vi.fn();
      const diagnostic = vi.fn();
      client.onDiagnostic(diagnostic);
      client.onSpeech((item) => evidence.push(item));
      client.onOnset(onset);
      client.setRecognitionEnabled(false);
      await client.start();
      platform.calibrate();
      const calibrated = client.getSnapshot();
      platform.utterance();
      expect(platform.transcriptions).toHaveLength(0);
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ type: "discard", detail: "recognition-paused", voiceStartMs: expect.any(Number), voiceEndMs: expect.any(Number) }));
      expect(client.getSnapshot()).toEqual(calibrated);

      platform.feed(0.08, beforeResume);
      client.setRecognitionEnabled(true);
      platform.feed(0.08, 20);
      platform.feed(0.001, 25);
      expect(platform.transcriptions).toHaveLength(0);
      expect(onset).not.toHaveBeenCalled();
      expect(platform.stopped).toBe(false);
      expect(client.getSnapshot()).toEqual(calibrated);

      platform.utterance();
      expect(platform.transcriptions).toHaveLength(1);
      expect(onset).toHaveBeenCalledOnce();
      const headers = new Headers(platform.requests.at(-1)!.init?.headers);
      platform.transcriptions[0].resolve(Response.json({
        utteranceId: headers.get("X-Wand-Utterance-Id"),
        generation: Number(headers.get("X-Wand-Generation")),
        text: "Stupefy",
        spell: "stupefy",
      }));
      await flush();
      expect(evidence).toHaveLength(1);
      expect(client.getSnapshot().phase).toBe("listening");
      client.stop();
    },
  );

  it("silently discards an in-flight result when recognition is paused", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const evidence: SpeechEvidence[] = [];
    client.onSpeech((item) => evidence.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    client.setRecognitionEnabled(false);
    client.setRecognitionEnabled(true);
    platform.transcriptions[0].resolve(Response.json({
      utteranceId: headers.get("X-Wand-Utterance-Id"),
      generation: Number(headers.get("X-Wand-Generation")),
      text: "ordinary calibration chatter",
      spell: null,
    }));
    await flush();
    expect(evidence).toEqual([]);
    expect(client.getSnapshot()).toMatchObject({ phase: "listening", issue: "" });
    expect(platform.stopped).toBe(false);

    platform.feed(0.001, 25);
    platform.utterance();
    const freshHeaders = new Headers(platform.requests.at(-1)!.init?.headers);
    platform.transcriptions[1].resolve(Response.json({
      utteranceId: freshHeaders.get("X-Wand-Utterance-Id"),
      generation: Number(freshHeaders.get("X-Wand-Generation")),
      text: "not a spell",
      spell: null,
    }));
    await flush();
    expect(client.getSnapshot().issue).toBe("");
    client.stop();
  });

  it("does not recognize a continuation split from calibration speech at the clip limit", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    client.setRecognitionEnabled(false);
    await client.start();
    platform.calibrate();
    platform.feed(0.08, 20);
    client.setRecognitionEnabled(true);
    platform.feed(0.08, 250);
    platform.feed(0.001, 25);
    expect(platform.transcriptions).toHaveLength(0);
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(1);
    client.stop();
  });

  it("recovers a transient helper failure silently while paused but surfaces invalid PCM", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    await client.start();
    platform.calibrate();
    platform.utterance();
    client.setRecognitionEnabled(false);
    platform.transcriptions[0].resolve(new Response(null, { status: 503 }));
    await flush();
    expect(client.getSnapshot()).toMatchObject({
      phase: "listening",
      issue: "",
    });
    expect(platform.stopped).toBe(false);

    platform.stopped = false;
    await client.start();
    platform.feed(Number.NaN, 1);
    client.setRecognitionEnabled(true);
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Microphone produced invalid PCM",
    });
    expect(platform.stopped).toBe(true);
  });

  it("still rejects inconsistent helper payloads for a paused utterance", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    await client.start();
    platform.calibrate();
    platform.utterance();
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    client.setRecognitionEnabled(false);
    platform.transcriptions[0].resolve(Response.json({
      utteranceId: headers.get("X-Wand-Utterance-Id"),
      generation: Number(headers.get("X-Wand-Generation")),
      text: "Stupefy",
      spell: "protego",
    }));
    await flush();
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Local speech helper returned inconsistent evidence",
    });
    expect(platform.stopped).toBe(true);
  });

  it("discards a timed-out result even after a fresh utterance starts, then accepts the fresh result", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const evidence: SpeechEvidence[] = [];
    client.onSpeech((item) => evidence.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const firstRequest = platform.requests.at(-1)!;
    const firstHeaders = new Headers(firstRequest.init?.headers);
    fusion.pushGesture(matchingGesture(firstHeaders, "old-gesture"));
    const generation = client.getSnapshot().generation;
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getSnapshot()).toMatchObject({
      phase: "listening",
      issue: "",
      generation,
    });
    expect(platform.stopped).toBe(false);
    expect(firstRequest.init?.signal?.aborted).toBe(true);
    expect(fusion.getState()).toMatchObject({ activeUtterance: undefined, pendingGesture: undefined });
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(2);
    platform.transcriptions[0].resolve(Response.json({
      utteranceId: firstHeaders.get("X-Wand-Utterance-Id"),
      generation,
      text: "Stupefy",
      spell: "stupefy",
    }));
    await flush();
    expect(evidence).toEqual([]);
    expect(client.getSnapshot().phase).toBe("busy");
    const freshHeaders = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.cancelUtterance(firstHeaders.get("X-Wand-Utterance-Id")!, generation);
    expect(fusion.getState().activeUtterance?.id).toBe(freshHeaders.get("X-Wand-Utterance-Id"));
    fusion.pushGesture(matchingGesture(freshHeaders, "fresh-gesture", "protego"));
    platform.transcriptions[1].resolve(Response.json({
      utteranceId: freshHeaders.get("X-Wand-Utterance-Id"),
      generation,
      text: "Episkey",
      spell: "episkey",
    }));
    await flush();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ id: freshHeaders.get("X-Wand-Utterance-Id"), spell: "episkey" });
    expect(casts).toHaveLength(1);
    expect(casts[0]).toMatchObject({ spell: "episkey", gestureId: "fresh-gesture" });
    expect(client.getSnapshot()).toMatchObject({ phase: "listening", issue: "", generation });
    client.stop();
  });

  it.each([409, 504, "", "ordinary words"])("retires discarded speech (%s), and the next voice plus gesture casts once", async (result) => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const evidence: SpeechEvidence[] = [];
    client.onSpeech((item) => evidence.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const firstHeaders = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(firstHeaders, "old-gesture"));
    platform.transcriptions[0].resolve(typeof result === "number"
      ? new Response(null, { status: result })
      : Response.json({
        utteranceId: firstHeaders.get("X-Wand-Utterance-Id"),
        generation: Number(firstHeaders.get("X-Wand-Generation")),
        text: result,
        spell: null,
      }));
    await flush();
    expect(client.getSnapshot().phase).toBe("listening");
    expect(platform.stopped).toBe(false);
    expect(platform.transcriptions).toHaveLength(1);
    expect(evidence).toEqual([]);
    expect(fusion.getState()).toMatchObject({ activeUtterance: undefined, pendingGesture: undefined });
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(2);
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(headers, "fresh-gesture"));
    platform.transcriptions[1].resolve(Response.json({
      utteranceId: headers.get("X-Wand-Utterance-Id"),
      generation: Number(headers.get("X-Wand-Generation")),
      text: "Incendio",
      spell: "incendio",
    }));
    await flush();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].spell).toBe("incendio");
    expect(casts).toHaveLength(1);
    expect(casts[0]).toMatchObject({ spell: "incendio", gestureId: "fresh-gesture" });
    expect(client.getSnapshot()).toMatchObject({ phase: "listening", issue: "" });
    client.stop();
  });

  it.each([
    ["no-speech", "silence", true],
    ["not-an-incantation", "silence", true],
    ["low-confidence", "silence", false],
    [undefined, "silence", false],
    ["not-an-incantation", "cutoff", false],
    ["no-speech", "cutoff", false],
    ["no-speech", "paused", false],
    ["no-speech", "timeout", false],
  ] as const)("allows prior-word fallback only for confirmed nonspell (%s, %s)", async (reason, ending, mayFallback) => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const { fusion, casts } = fuseSpeech(client);
    const discards: SpeechDiscard[] = [];
    client.onDiscard(event => discards.push(event));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const first = new Headers(platform.requests.at(-1)!.init?.headers);
    platform.transcriptions[0].resolve(Response.json({ utteranceId: first.get("X-Wand-Utterance-Id"),
      generation: Number(first.get("X-Wand-Generation")), text: "Stupefy", spell: "stupefy" }));
    await flush();
    expect(fusion.getState().pendingUtterance?.spell).toBe("stupefy");
    if (ending === "cutoff") platform.feed(0.08, 225);
    else platform.utterance();
    const newer = new Headers(platform.requests.at(-1)!.init?.headers);
    fusion.pushGesture(matchingGesture(newer, "movement-during-new-sound"));
    expect(casts).toEqual([]);
    if (ending === "paused") client.setRecognitionEnabled(false);
    if (ending === "timeout") await vi.advanceTimersByTimeAsync(1_000);
    platform.transcriptions[1].resolve(Response.json({ utteranceId: newer.get("X-Wand-Utterance-Id"),
      generation: Number(newer.get("X-Wand-Generation")), text: reason === "not-an-incantation" ? "ordinary words" : "",
      spell: null, accepted: false, reason }));
    await flush();
    expect(discards).toEqual([{ id: newer.get("X-Wand-Utterance-Id"), generation: client.getSnapshot().generation,
      disposition: mayFallback ? "confirmed-nonspell" : "ambiguous" }]);
    expect(casts.map(cast => cast.gestureId)).toEqual(mayFallback ? ["movement-during-new-sound"] : []);
    if (!mayFallback) expect(fusion.getState()).toMatchObject({ pendingUtterance: undefined, pendingGesture: undefined });
    client.stop();
  });

  it("rejects stale callbacks after stop and invalidates immediately when hidden", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const evidence: SpeechEvidence[] = [];
    client.onSpeech((item) => evidence.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    client.stop();
    platform.transcriptions[0].resolve(
      Response.json({
        utteranceId: headers.get("X-Wand-Utterance-Id"),
        generation: Number(headers.get("X-Wand-Generation")),
        text: "Stupefy",
        spell: "stupefy",
      }),
    );
    await flush();
    expect(evidence).toEqual([]);
    expect(client.getSnapshot().phase).toBe("off");

    platform.stopped = false;
    await client.start();
    platform.hide();
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Page hidden or suspended; speech evidence was cleared",
    });
    expect(platform.stopped).toBe(true);
  });
});

describe("browser speech capture ownership", () => {
  afterEach(() => vi.unstubAllGlobals());

  function clockHarness() {
    let wallMs = 1000;
    const stopTrack = vi.fn();
    const track = { addEventListener: vi.fn(), removeEventListener: vi.fn(), stop: stopTrack };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    const listeners = new Set<() => void>();
    let audio!: Context;
    let worklet!: Worklet;
    class Context {
      sampleRate = SPEECH_SAMPLE_RATE;
      currentTime = 0;
      state = "running";
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      source = { connect: vi.fn(), disconnect: vi.fn() };
      constructor() { audio = this; }
      setState(state: string) { this.state = state; for (const listener of [...listeners]) listener(); }
      suspend = vi.fn(async () => this.setState("suspended"));
      resume = vi.fn(async () => this.setState("running"));
      close = vi.fn(async () => this.setState("closed"));
      createMediaStreamSource = () => this.source;
      addEventListener(type: string, listener: () => void) { if (type === "statechange") listeners.add(listener); }
      removeEventListener(type: string, listener: () => void) { if (type === "statechange") listeners.delete(listener); }
    }
    class Worklet {
      port: { onmessage: ((message: MessageEvent<CapturedAudioFrame>) => void) | null } = { onmessage: null };
      onprocessorerror = null;
      disconnect = vi.fn();
      constructor() { worklet = this; }
    }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("AudioWorkletNode", Worklet);
    vi.stubGlobal("performance", { now: () => wallMs });
    return {
      get audio() { return audio; }, get worklet() { return worklet; }, listeners, stopTrack,
      advance: (ms: number) => { wallMs += ms; },
    };
  }

  it.each(["suspended", "interrupted", "closed"])("retires the fixed capture clock when a visible audio context becomes %s", async state => {
    const test = clockHarness();
    const onLost = vi.fn();
    const onFrame = vi.fn();
    const capture = await browserSpeechPlatform().openCapture(4, "/worklet", onFrame, onLost);
    expect(onLost).not.toHaveBeenCalled();
    const lateFrame = test.worklet.port.onmessage!;
    lateFrame({ data: { generation: 4, startFrame: 0 } } as MessageEvent<CapturedAudioFrame>);
    expect(onFrame).toHaveBeenCalledWith({ generation: 4, startFrame: 0 }, 1000);
    test.audio.setState(state);
    expect(onLost).toHaveBeenCalledExactlyOnceWith("Microphone audio clock stopped; enable speech again");
    expect(test.stopTrack).toHaveBeenCalledOnce();
    expect(test.audio.close).toHaveBeenCalledOnce();
    expect(test.listeners.size).toBe(0);
    test.advance(4000);
    test.audio.setState("running");
    // A queued frame with contiguous currentFrame cannot revive the old clock.
    lateFrame({ data: { generation: 4, startFrame: 128 } } as MessageEvent<CapturedAudioFrame>);
    expect(onFrame).toHaveBeenCalledOnce();
    capture.stop();
    expect(onLost).toHaveBeenCalledOnce();
  });

  it("permits the startup suspension and removes clock listeners before intentional cleanup", async () => {
    const test = clockHarness();
    const onLost = vi.fn();
    const capture = await browserSpeechPlatform().openCapture(4, "/worklet", vi.fn(), onLost);
    expect(test.audio.suspend).toHaveBeenCalledOnce();
    expect(test.audio.resume).toHaveBeenCalledOnce();
    expect(test.listeners.size).toBe(1);
    expect(onLost).not.toHaveBeenCalled();
    capture.stop();
    capture.stop();
    expect(test.listeners.size).toBe(0);
    expect(test.audio.close).toHaveBeenCalledOnce();
    expect(test.stopTrack).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
  });

  it.each(["suspend", "addModule", "resume"] as const)(
    "releases the microphone and context when %s fails",
    async (failure) => {
      const stopTrack = vi.fn();
      const track = {
        getSettings: () => ({ channelCount: 1 }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        stop: stopTrack,
      };
      const stream = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(stream),
        },
      });
      const close = vi.fn().mockResolvedValue(undefined);
      const suspend =
        failure === "suspend"
          ? vi.fn().mockRejectedValue(new Error("suspend failed"))
          : vi.fn().mockResolvedValue(undefined);
      const addModule =
        failure === "addModule"
          ? vi.fn().mockRejectedValue(new Error("addModule failed"))
          : vi.fn().mockResolvedValue(undefined);
      const resume =
        failure === "resume"
          ? vi.fn().mockRejectedValue(new Error("resume failed"))
          : vi.fn().mockResolvedValue(undefined);
      const source = {
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      vi.stubGlobal(
        "AudioContext",
        class {
          readonly sampleRate = SPEECH_SAMPLE_RATE;
          readonly currentTime = 0;
          readonly audioWorklet = { addModule };
          readonly suspend = suspend;
          readonly resume = resume;
          readonly close = close;
          readonly createMediaStreamSource = vi.fn(() => source);
        },
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        class {
          readonly port = { onmessage: null };
          onprocessorerror = null;
          readonly disconnect = vi.fn();
        },
      );

      await expect(
        browserSpeechPlatform().openCapture(
          4,
          "/worklets/speech-capture.js",
          vi.fn(),
          vi.fn(),
        ),
      ).rejects.toThrow(`${failure} failed`);
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );
});
