import {
  SPEECH_SAMPLE_RATE,
  SpeechEndpoint,
  type CapturedAudioFrame,
  type SpeechEndpointEvent,
} from "./endpoint";

import { INCANTATIONS, type SpellName } from "../game/spells";

export type SpeechSpell = SpellName;
export type SpeechPhase =
  | "off"
  | "starting"
  | "calibrating"
  | "listening"
  | "busy"
  | "fault";

export type SpeechSnapshot = {
  phase: SpeechPhase;
  issue: string;
  generation: number;
  noiseFloor?: number;
};

export type SpeechEvidence = {
  id: string;
  generation: number;
  startMs: number;
  endMs: number;
  arrivedMs: number;
  spell: SpeechSpell;
};

export type SpeechOnset = {
  id: string;
  generation: number;
  startMs: number;
};

type Capture = {
  stop: () => void;
};

export type SpeechClientPlatform = {
  now: () => number;
  request: typeof fetch;
  createId: () => string;
  isHidden: () => boolean;
  watchLifecycle: (onInvalidated: (issue: string) => void) => () => void;
  openCapture: (
    generation: number,
    workletUrl: string,
    onFrame: (frame: CapturedAudioFrame, timeOriginMs: number) => void,
    onLost: (issue: string) => void,
  ) => Promise<Capture>;
};

type Draft = SpeechOnset & { suppressed: boolean };
type Pending = {
  id: string;
  generation: number;
  startMs: number;
  endMs: number;
  invalidated: boolean;
  discardSilently: boolean;
  overlapActive: boolean;
  settled: boolean;
  abort: AbortController;
  deadlineTimer: ReturnType<typeof setTimeout>;
};

type HelperHealth = {
  status: string;
  ready: boolean;
  warm: boolean;
  busy: boolean;
  workerAvailable: boolean;
  issue?: string;
};

type HelperResult = {
  utteranceId: string;
  generation: number;
  text: string;
  spell: SpeechSpell | null;
};

// faster-whisper base.en int8 on a laptop CPU takes ~500-900 ms per clip regardless of
// clip length; 1 s left no headroom. Mirrors MAX_DEADLINE_MS in speech_app.py.
const MAX_RESULT_DELAY_MS = 1500;
const LATE_RESULT_ISSUE = "Speech result arrived too late; say it again";
const MAX_PCM_BYTES = SPEECH_SAMPLE_RATE * 3 * 2;
const FIRST_AUDIO_FRAME_TIMEOUT_MS = 2000;

export class SpeechClient {
  private snapshot: SpeechSnapshot = {
    phase: "off",
    issue: "",
    generation: 0,
  };
  private generation = 0;
  private endpoint?: SpeechEndpoint;
  private capture?: Capture;
  private unwatch?: () => void;
  private draft?: Draft;
  private pending?: Pending;
  private recognitionEnabled = true;
  private recognitionFromMs = -Infinity;
  private speechListeners = new Set<(evidence: SpeechEvidence) => void>();
  private onsetListeners = new Set<(onset: SpeechOnset) => void>();

  constructor(
    private readonly platform: SpeechClientPlatform = browserSpeechPlatform(),
    private readonly workletUrl = "/worklets/speech-capture.js",
  ) {}

  getSnapshot(): SpeechSnapshot {
    return { ...this.snapshot };
  }

  setRecognitionEnabled(enabled: boolean): void {
    if (enabled === this.recognitionEnabled) return;
    this.recognitionEnabled = enabled;
    if (enabled) {
      this.recognitionFromMs = this.platform.now();
      this.draft = undefined;
      this.endpoint?.requireQuiet();
      if (this.pending) this.pending.overlapActive = false;
      this.finishInvalidatedWhenIdle();
      return;
    }
    if (this.draft) this.draft.suppressed = true;
    if (this.pending) {
      this.pending.invalidated = true;
      this.pending.discardSilently = true;
    }
    if (["listening", "busy"].includes(this.snapshot.phase))
      this.snapshot = { ...this.snapshot, issue: "" };
  }

  onSpeech(listener: (evidence: SpeechEvidence) => void): () => void {
    this.speechListeners.add(listener);
    return () => this.speechListeners.delete(listener);
  }

  onOnset(listener: (onset: SpeechOnset) => void): () => void {
    this.onsetListeners.add(listener);
    return () => this.onsetListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.teardown("off", "");
    const generation = this.generation;
    this.snapshot = { phase: "starting", issue: "", generation };
    if (this.platform.isHidden()) {
      this.fail("Page is hidden; return to the game before enabling speech");
      return;
    }
    this.unwatch = this.platform.watchLifecycle((issue) => {
      if (generation === this.generation) this.fail(issue);
    });

    try {
      const health = await this.readHealth();
      this.assertCurrent(generation);
      if (
        health.status !== "ok" ||
        !health.ready ||
        !health.warm ||
        health.busy ||
        !health.workerAvailable
      ) {
        throw new Error(
          health.issue || "Local speech helper is not warm and idle",
        );
      }
      this.snapshot = { phase: "calibrating", issue: "", generation };
      const capture = await this.platform.openCapture(
        generation,
        this.workletUrl,
        (frame, timeOriginMs) => this.frame(generation, frame, timeOriginMs),
        (issue) => {
          if (generation === this.generation) this.fail(issue);
        },
      );
      if (generation !== this.generation) {
        capture.stop();
        return;
      }
      this.capture = capture;
    } catch (error) {
      if (generation === this.generation) {
        this.fail(
          error instanceof Error ? error.message : "Speech setup failed",
        );
      }
    }
  }

  stop(): void {
    this.teardown("off", "");
  }

  private async readHealth(): Promise<HelperHealth> {
    const response = await this.platform.request("/api/speech/health", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Local speech helper is unavailable");
    return (await response.json()) as HelperHealth;
  }

  private frame(
    generation: number,
    frame: CapturedAudioFrame,
    timeOriginMs: number,
  ): void {
    if (generation !== this.generation) return;
    this.endpoint ??= new SpeechEndpoint(generation, timeOriginMs);
    for (const event of this.endpoint.push(frame)) this.endpointEvent(event);
  }

  private endpointEvent(event: SpeechEndpointEvent): void {
    if (event.type === "fault") {
      this.fail(event.issue);
      return;
    }
    if (event.type === "calibrated") {
      this.snapshot = {
        phase: "listening",
        issue: "",
        generation: this.generation,
        noiseFloor: event.noiseFloor,
      };
      return;
    }
    if (event.type === "onset") {
      const onset: SpeechOnset = {
        id: this.platform.createId(),
        generation: this.generation,
        startMs: event.startMs,
      };
      const recognitionAllowed =
        this.recognitionEnabled && event.startMs >= this.recognitionFromMs;
      const suppressed = !recognitionAllowed || this.pending !== undefined;
      if (this.pending) {
        this.pending.invalidated = true;
        this.pending.overlapActive = true;
        this.snapshot = {
          ...this.snapshot,
          phase: "busy",
          issue: recognitionAllowed && !this.pending.discardSilently
            ? "Overlapping speech invalidated the pending utterance"
            : "",
        };
      }
      this.draft = { ...onset, suppressed };
      if (recognitionAllowed)
        for (const listener of this.onsetListeners) listener(onset);
      return;
    }
    this.clip(event);
  }

  private clip(event: Extract<SpeechEndpointEvent, { type: "clip" }>): void {
    const draft = this.draft;
    this.draft = undefined;
    if (!draft || draft.generation !== this.generation) return;
    if (draft.suppressed) {
      if (this.pending) this.pending.overlapActive = false;
      else this.endpoint?.resolve();
      this.finishInvalidatedWhenIdle();
      return;
    }
    if (this.pending) {
      this.pending.invalidated = true;
      this.finishInvalidatedWhenIdle();
      return;
    }

    const remaining = event.endMs + MAX_RESULT_DELAY_MS - this.platform.now();
    if (remaining <= 0) {
      this.fail("Speech result deadline elapsed before transcription started");
      return;
    }
    const body = pcm16(event.samples);
    if (body.byteLength === 0 || body.byteLength > MAX_PCM_BYTES) {
      this.fail("Captured speech clip exceeded the three-second PCM bound");
      return;
    }
    const abort = new AbortController();
    const pending: Pending = {
      id: draft.id,
      generation: draft.generation,
      startMs: event.startMs,
      endMs: event.endMs,
      invalidated: false,
      discardSilently: false,
      overlapActive: false,
      settled: false,
      abort,
      deadlineTimer: setTimeout(
        () => this.deadline(draft.id, draft.generation),
        remaining,
      ),
    };
    this.pending = pending;
    this.snapshot = { ...this.snapshot, phase: "busy", issue: "" };
    void this.transcribe(pending, body, Math.floor(remaining));
  }

  private async transcribe(
    pending: Pending,
    body: ArrayBuffer,
    deadlineBudgetMs: number,
  ): Promise<void> {
    try {
      const response = await this.platform.request("/api/speech/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Wand-Audio-Format": "pcm_s16le",
          "X-Wand-Sample-Rate": String(SPEECH_SAMPLE_RATE),
          "X-Wand-Channels": "1",
          "X-Wand-Utterance-Id": pending.id,
          "X-Wand-Generation": String(pending.generation),
          "X-Wand-Voice-Start-Ms": pending.startMs.toFixed(3),
          "X-Wand-Voice-End-Ms": pending.endMs.toFixed(3),
          "X-Wand-Deadline-Budget-Ms": String(
            Math.max(1, deadlineBudgetMs),
          ),
        },
        body,
        signal: pending.abort.signal,
      });
      if (response.status === 504) {
        this.late(pending);
        return;
      }
      if (!response.ok) throw new Error("Local speech transcription failed");
      const result = (await response.json()) as HelperResult;
      this.result(pending, result);
    } catch (error) {
      if (!pending.abort.signal.aborted && this.isPending(pending)) {
        this.fail(
          error instanceof Error
            ? error.message
            : "Local speech transcription failed",
        );
      }
    } finally {
      pending.settled = true;
      this.finishInvalidatedWhenIdle();
    }
  }

  private result(pending: Pending, result: HelperResult): void {
    if (!this.isPending(pending)) return;
    const arrivedMs = this.platform.now();
    if (arrivedMs > pending.endMs + MAX_RESULT_DELAY_MS) {
      this.late(pending);
      return;
    }
    clearTimeout(pending.deadlineTimer);
    if (
      result.utteranceId !== pending.id ||
      result.generation !== pending.generation
    ) {
      this.fail("Local speech helper returned stale evidence");
      return;
    }
    const spell = canonicalSpell(result.text);
    if (result.spell !== spell) {
      this.fail("Local speech helper returned inconsistent evidence");
      return;
    }
    if (pending.invalidated) return;
    if (spell) {
      const evidence: SpeechEvidence = {
        id: pending.id,
        generation: pending.generation,
        startMs: pending.startMs,
        endMs: pending.endMs,
        arrivedMs,
        spell,
      };
      for (const listener of this.speechListeners) listener(evidence);
      this.snapshot = { ...this.snapshot, issue: "" };
    } else {
      this.snapshot = {
        ...this.snapshot,
        issue: "Speech was not one exact incantation",
      };
    }
    pending.settled = true;
    this.completePending(pending);
  }

  private deadline(id: string, generation: number): void {
    if (
      this.pending?.id === id &&
      this.pending.generation === generation &&
      generation === this.generation
    ) {
      this.late(this.pending);
    }
  }

  /** A late or 504 result drops that one utterance; the microphone keeps listening. */
  private late(pending: Pending): void {
    if (!this.isPending(pending)) return;
    pending.abort.abort();
    pending.settled = true;
    this.snapshot = { ...this.snapshot, issue: LATE_RESULT_ISSUE };
    this.completePending(pending);
  }

  private finishInvalidatedWhenIdle(): void {
    const pending = this.pending;
    if (
      pending?.invalidated &&
      pending.settled &&
      !pending.overlapActive &&
      this.isPending(pending)
    ) {
      clearTimeout(pending.deadlineTimer);
      this.completePending(pending);
    }
  }

  private completePending(pending: Pending): void {
    if (!this.isPending(pending)) return;
    clearTimeout(pending.deadlineTimer);
    this.pending = undefined;
    this.endpoint?.resolve();
    this.snapshot = {
      ...this.snapshot,
      phase: "listening",
      issue: pending.discardSilently
        ? ""
        : pending.invalidated
          ? "Overlapping speech was discarded; try again from silence"
          : this.snapshot.issue,
    };
  }

  private isPending(pending: Pending): boolean {
    return (
      this.pending === pending && pending.generation === this.generation
    );
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error("Speech session ended");
  }

  private fail(issue: string): void {
    this.teardown("fault", issue);
  }

  private teardown(phase: "off" | "fault", issue: string): void {
    this.generation++;
    this.pending?.abort.abort();
    if (this.pending) clearTimeout(this.pending.deadlineTimer);
    this.pending = undefined;
    this.draft = undefined;
    this.endpoint = undefined;
    this.capture?.stop();
    this.capture = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
    this.snapshot = { phase, issue, generation: this.generation };
  }
}

/** Case, punctuation and whitespace normalization only: never an alias or fuzzy match. */
function canonicalSpell(text: string): SpeechSpell | null {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/\s+/)
    .map((word) => word.replace(/^[.,!?;:'"“”‘’-]+|[.,!?;:'"“”‘’-]+$/g, ""))
    .filter((word) => word.length > 0)
    .join(" ");
  return INCANTATIONS.get(normalized) ?? null;
}

function pcm16(samples: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(samples.length * 2);
  const view = new DataView(output);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    view.setInt16(index * 2, value, true);
  }
  return output;
}

export function browserSpeechPlatform(): SpeechClientPlatform {
  return {
    now: () => performance.now(),
    request: (input, init) => fetch(input, init),
    createId: () => crypto.randomUUID(),
    isHidden: () => document.visibilityState !== "visible",
    watchLifecycle: (onInvalidated) => {
      const visibility = () => {
        if (document.visibilityState !== "visible")
          onInvalidated("Page hidden or suspended; speech evidence was cleared");
      };
      const device = () =>
        onInvalidated("Microphone devices changed; enable speech again");
      document.addEventListener("visibilitychange", visibility);
      navigator.mediaDevices.addEventListener("devicechange", device);
      return () => {
        document.removeEventListener("visibilitychange", visibility);
        navigator.mediaDevices.removeEventListener("devicechange", device);
      };
    },
    openCapture: async (generation, workletUrl, onFrame, onLost) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { exact: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      let context: AudioContext | undefined;
      let source: MediaStreamAudioSourceNode | undefined;
      let node: AudioWorkletNode | undefined;
      let firstFrameTimeout: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let ended: (() => void) | undefined;
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        if (firstFrameTimeout !== undefined) clearTimeout(firstFrameTimeout);
        if (node) {
          node.port.onmessage = null;
          node.onprocessorerror = null;
          try {
            node.disconnect();
          } catch {
            // The node may not have reached the connected setup step.
          }
        }
        if (source) {
          try {
            source.disconnect();
          } catch {
            // The source may not have reached the connected setup step.
          }
        }
        const track = stream.getAudioTracks()[0];
        if (track && ended) track.removeEventListener("ended", ended);
        for (const item of stream.getTracks()) item.stop();
        if (context) void context.close().catch(() => undefined);
      };
      const lost = (issue: string) => {
        if (!stopped) onLost(issue);
      };
      try {
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error("No laptop microphone track was provided");

        context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
        if (context.sampleRate !== SPEECH_SAMPLE_RATE)
          throw new Error(
            `Browser opened ${context.sampleRate} Hz audio; exact 16000 Hz is required`,
          );
        await context.suspend();
        await context.audioWorklet.addModule(workletUrl);
        source = context.createMediaStreamSource(stream);
        node = new AudioWorkletNode(context, "wand-speech-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          processorOptions: { generation },
        });
        ended = () =>
          lost("Laptop microphone track ended; enable speech again");
        track.addEventListener("ended", ended, { once: true });
        node.onprocessorerror = () =>
          lost("Audio worklet stopped; enable speech again");
        // Assemble the graph while its clock is explicitly suspended. Starting
        // the clock before the source and processor are connected can skip an
        // initial render quantum in Chrome.
        source.connect(node);
        await context.resume();
        const timeOriginMs = performance.now() - context.currentTime * 1000;
        node.port.onmessage = (message: MessageEvent<CapturedAudioFrame>) => {
          if (firstFrameTimeout !== undefined) {
            clearTimeout(firstFrameTimeout);
            firstFrameTimeout = undefined;
          }
          onFrame(message.data, timeOriginMs);
        };
        firstFrameTimeout = setTimeout(
          () => lost("Microphone produced no audio; enable speech again"),
          FIRST_AUDIO_FRAME_TIMEOUT_MS,
        );
        return { stop: cleanup };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  };
}
