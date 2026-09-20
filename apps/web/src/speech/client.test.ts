import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserSpeechPlatform,
  SpeechClient,
  type SpeechClientPlatform,
  type SpeechEvidence,
} from "./client";
import {
  SPEECH_SAMPLE_RATE,
  type CapturedAudioFrame,
} from "./endpoint";

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
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

describe("speech client lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("calibrates, sends bounded raw PCM headers, and emits exact evidence", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
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
        text: "Stupefy!",
        spell: "stupefy",
      }),
    );
    await flush();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      id: utteranceId,
      generation,
      spell: "stupefy",
    });
    expect(evidence[0].endMs).toBeLessThan(evidence[0].arrivedMs);
    expect(client.getSnapshot().phase).toBe("listening");
  });

  it("invalidates the first result on a second onset and never queues the second", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const evidence: SpeechEvidence[] = [];
    const onsets: string[] = [];
    client.onSpeech((item) => evidence.push(item));
    client.onOnset((item) => onsets.push(item.id));
    await client.start();
    platform.calibrate();
    platform.utterance();
    expect(platform.transcriptions).toHaveLength(1);

    platform.utterance();
    expect(onsets).toHaveLength(2);
    expect(platform.transcriptions).toHaveLength(1);
    const headers = new Headers(platform.requests.at(-1)!.init?.headers);
    platform.transcriptions[0].resolve(
      Response.json({
        utteranceId: headers.get("X-Wand-Utterance-Id"),
        generation: Number(headers.get("X-Wand-Generation")),
        text: "Protego",
        spell: "protego",
      }),
    );
    await flush();
    expect(evidence).toEqual([]);
    expect(client.getSnapshot()).toMatchObject({
      phase: "listening",
      issue: "Overlapping speech was discarded; try again from silence",
    });
  });

  it.each([1, 20])(
    "keeps capture warm but discards speech begun %i quanta before recognition resumes",
    async (beforeResume) => {
      const platform = new FakePlatform();
      const client = new SpeechClient(platform);
      const evidence: SpeechEvidence[] = [];
      const onset = vi.fn();
      client.onSpeech((item) => evidence.push(item));
      client.onOnset(onset);
      client.setRecognitionEnabled(false);
      await client.start();
      platform.calibrate();
      const calibrated = client.getSnapshot();
      platform.utterance();
      expect(platform.transcriptions).toHaveLength(0);
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
    expect(client.getSnapshot().issue).toBe("Speech was not one exact incantation");
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

  it("still surfaces helper and PCM failures while recognition is paused", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    await client.start();
    platform.calibrate();
    platform.utterance();
    client.setRecognitionEnabled(false);
    platform.transcriptions[0].resolve(new Response(null, { status: 503 }));
    await flush();
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Local speech transcription failed",
    });
    expect(platform.stopped).toBe(true);

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

  it("drops the utterance but keeps listening when the helper misses the final deadline", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    const evidence: SpeechEvidence[] = [];
    client.onSpeech((item) => evidence.push(item));
    await client.start();
    platform.calibrate();
    platform.utterance();
    expect(client.getSnapshot().phase).toBe("busy");
    await vi.advanceTimersByTimeAsync(1500);
    expect(client.getSnapshot()).toMatchObject({
      phase: "listening",
      issue: "Speech result arrived too late; say it again",
    });
    expect(platform.stopped).toBe(false);
    expect(platform.requests.at(-1)!.init?.signal?.aborted).toBe(true);
    expect(evidence).toEqual([]);
  });

  it("treats a helper 504 as one late utterance, not a fault", async () => {
    const platform = new FakePlatform();
    const client = new SpeechClient(platform);
    await client.start();
    platform.calibrate();
    platform.utterance();
    platform.transcriptions[0].resolve(new Response("late", { status: 504 }));
    await flush();
    expect(client.getSnapshot()).toMatchObject({
      phase: "listening",
      issue: "Speech result arrived too late; say it again",
    });
    expect(platform.stopped).toBe(false);
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
