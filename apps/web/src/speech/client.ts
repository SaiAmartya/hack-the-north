import { SPELLS, type Spell } from "../game/contracts";
import {
  SPEECH_SAMPLE_RATE,
  SpeechEndpoint,
  type CapturedAudioFrame,
  type SpeechEndpointEvent,
} from "./endpoint";

export type SpeechSpell = Spell;
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

export type SpeechDiscard = Pick<SpeechOnset, "id" | "generation"> & {
  disposition: "confirmed-nonspell" | "ambiguous";
};

export type SpeechDiagnostic = {
  type: "calibrated" | "onset" | "result" | "discard" | "recovered" | "capture-reset" | "fault";
  atMs: number;
  generation: number;
  utteranceId?: string;
  detail?: string;
  spell?: SpeechSpell;
  inferenceMs?: number;
  noiseFloor?: number;
  transcript?: string;
  voiceStartMs?: number;
  voiceEndMs?: number;
  speechDurationMs?: number;
  avgLogProbability?: number;
  noSpeechProbability?: number;
  endReason?: "silence" | "voice-limit" | "clip-limit";
  busyStartMs?: number;
  busyEndMs?: number;
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
    onLost: (issue: string, recoverable?: boolean) => void,
  ) => Promise<Capture>;
};

type Draft = SpeechOnset & { suppressed: boolean; suppression?: "recognition-paused" | "inference-busy" | "inference-busy-delayed" | "ambiguous-continuation" };
type Pending = {
  id: string;
  generation: number;
  startMs: number;
  endMs: number;
  inferenceStartedAtMs: number;
  invalidated: boolean;
  endReason: "silence" | "voice-limit" | "clip-limit";
  overlapActive: boolean;
  settled: boolean;
  backgroundOnly: boolean;
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
  inferenceMs?: number;
  accepted?: boolean;
  transcript?: string;
  reason?: string;
  speechDurationMs?: number | null;
  avgLogProbability?: number | null;
  noSpeechProbability?: number | null;
};

const MAX_RESULT_DELAY_MS = 1000;
const LATE_RESULT_ISSUE = "Speech result arrived too late; say it again";
const MAX_PCM_BYTES = SPEECH_SAMPLE_RATE * 3 * 2;
const AUDIO_FRAME_TIMEOUT_MS = 2000;

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
  private completedInference?: { generation: number; startMs: number; endMs: number };
  private recognitionEnabled = true;
  private recognitionFromMs = -Infinity;
  private requestFailures = 0;
  private captureRecoveries = 0;
  private captureRestarts: number[] = [];
  private restartTimer?: ReturnType<typeof setTimeout>;
  private recoveryUntilMs = 0;
  private speechListeners = new Set<(evidence: SpeechEvidence) => void>();
  private onsetListeners = new Set<(onset: SpeechOnset) => void>();
  private discardListeners = new Set<(utterance: SpeechDiscard) => void>();
  private diagnosticListeners = new Set<(event: SpeechDiagnostic) => void>();

  constructor(
    private readonly platform: SpeechClientPlatform = browserSpeechPlatform(),
    private readonly workletUrl = "/worklets/speech-capture.js",
  ) {}

  getSnapshot(): SpeechSnapshot {
    return { ...this.snapshot };
  }

  isRecoveringCapture(): boolean {
    return this.platform.now() < this.recoveryUntilMs &&
      ["starting", "calibrating"].includes(this.snapshot.phase);
  }

  setRecognitionEnabled(enabled: boolean): void {
    if (enabled === this.recognitionEnabled) return;
    this.recognitionEnabled = enabled;
    this.completedInference = undefined;
    if (enabled) {
      this.recognitionFromMs = this.platform.now();
      this.draft = undefined;
      this.endpoint?.requireQuiet();
      if (this.pending) this.pending.overlapActive = false;
      this.finishInvalidatedWhenIdle();
      return;
    }
    if (this.draft) {
      this.draft.suppressed = true;
      this.draft.suppression = "recognition-paused";
    }
    if (this.pending) {
      this.pending.invalidated = true;
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

  onDiscard(listener: (utterance: SpeechDiscard) => void): () => void {
    this.discardListeners.add(listener);
    return () => this.discardListeners.delete(listener);
  }

  onDiagnostic(listener: (event: SpeechDiagnostic) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.captureRestarts = [];
    await this.startSession();
  }

  private async startSession(recoveryUntilMs = 0): Promise<void> {
    this.teardown("off", "");
    this.recoveryUntilMs = recoveryUntilMs;
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
        !health.workerAvailable
      ) {
        throw new Error(
          health.issue || "Local speech helper is not ready",
        );
      }
      this.snapshot = { phase: "calibrating", issue: "", generation };
      const capture = await this.platform.openCapture(
        generation,
        this.workletUrl,
        (frame, timeOriginMs) => this.frame(generation, frame, timeOriginMs),
        (issue, recoverable) => {
          if (generation !== this.generation) return;
          if (recoverable) this.recoverCapture(issue);
          else this.fail(issue);
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
    for (const event of this.endpoint.push(frame)) {
      if (event.type === "fault" && event.issue === "Audio frame continuity was lost" && this.captureRecoveries < 2) {
        this.captureRecoveries++;
        if (this.draft) this.notifyDiscard(this.draft);
        if (this.pending) {
          this.pending.abort.abort();
          clearTimeout(this.pending.deadlineTimer);
          this.notifyDiscard(this.pending);
        }
        this.pending = undefined;
        this.draft = undefined;
        this.completedInference = undefined;
        this.endpoint = new SpeechEndpoint(generation, timeOriginMs);
        this.recoveryUntilMs = this.platform.now() + 5_000;
        this.snapshot = { phase: "calibrating", issue: "", generation };
        this.diagnostic({ type: "capture-reset", detail: "Interrupted PCM discarded" });
        this.diagnostic({ type: "recovered", detail: "Audio gap cleared; recalibrating fresh capture" });
      } else this.endpointEvent(event);
    }
  }

  private endpointEvent(event: SpeechEndpointEvent): void {
    if (event.type === "fault") {
      this.fail(event.issue);
      return;
    }
    if (event.type === "calibrated") {
      this.captureRecoveries = 0;
      this.recoveryUntilMs = 0;
      this.snapshot = {
        phase: "listening",
        issue: "",
        generation: this.generation,
        noiseFloor: event.noiseFloor,
      };
      this.diagnostic({ type: "calibrated", noiseFloor: event.noiseFloor });
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
      // Endpoint confirmation trails capture by at least 60ms. A result may
      // finish during that delay, but must not make the same busy-time sound
      // into fresh speech. One prior interval is enough for the ordered stream.
      const previous = this.completedInference;
      const delayedBusy = this.pending === undefined && previous?.generation === this.generation
        && event.startMs >= previous.startMs && event.startMs < previous.endMs;
      if (previous && event.startMs >= previous.endMs) this.completedInference = undefined;
      const suppressed = !recognitionAllowed || this.pending !== undefined || delayedBusy;
      const ambiguousContinuation = this.pending !== undefined && this.pending.endReason !== "silence";
      if (this.pending) {
        if (ambiguousContinuation) {
          this.pending.invalidated = true;
          this.pending.overlapActive = true;
          this.diagnostic({ type: "discard", utteranceId: this.pending.id,
            detail: "Ambiguous continuation invalidated cutoff utterance", endReason: this.pending.endReason });
        }
        this.snapshot = {
          ...this.snapshot,
          phase: "busy",
          issue: "",
        };
      }
      this.draft = { ...onset, suppressed,
        suppression: !recognitionAllowed ? "recognition-paused" : ambiguousContinuation ? "ambiguous-continuation"
          : delayedBusy ? "inference-busy-delayed" : suppressed ? "inference-busy" : undefined };
      // Energy after a completed quiet interval is a later sound, not proof
      // that the first utterance overlapped. Keep the single request and never
      // expose that later onset to fusion or queue another inference. A forced
      // cutoff has no such quiet boundary and keeps the prior invalidation rule.
      if (recognitionAllowed && (!suppressed || ambiguousContinuation))
        for (const listener of this.onsetListeners) listener(onset);
      if (recognitionAllowed) this.diagnostic({ type: "onset", utteranceId: onset.id,
        voiceStartMs: onset.startMs, detail: ambiguousContinuation ? "ambiguous-continuation: cutoff speech resumed"
          : delayedBusy ? "inference-busy-delayed: onset captured before prior result"
            : suppressed ? "inference-busy: later onset ignored" : undefined,
        busyStartMs: delayedBusy ? previous?.startMs : undefined,
        busyEndMs: delayedBusy ? previous?.endMs : undefined });
      return;
    }
    this.clip(event);
  }

  private clip(event: Extract<SpeechEndpointEvent, { type: "clip" }>): void {
    const draft = this.draft;
    this.draft = undefined;
    if (!draft || draft.generation !== this.generation) return;
    if (draft.suppressed) {
      this.diagnostic({ type: "discard", utteranceId: draft.id, detail: draft.suppression,
        voiceStartMs: draft.startMs, voiceEndMs: event.endMs, endReason: event.endReason });
      this.notifyDiscard(draft);
      if (this.pending) this.pending.overlapActive = false;
      else this.endpoint?.resolve();
      this.finishInvalidatedWhenIdle();
      // Suppression applies to the whole sound, including a tail beyond the
      // bounded clip. Never reinterpret that tail as a new command.
      if (event.endReason !== "silence") this.endpoint?.requireQuiet(true);
      return;
    }
    if (this.pending) {
      this.pending.invalidated = true;
      this.finishInvalidatedWhenIdle();
      return;
    }

    const remaining = event.endMs + MAX_RESULT_DELAY_MS - this.platform.now();
    if (remaining <= 0) {
      this.notifyDiscard(draft);
      this.endpoint?.resolve();
      this.snapshot = {
        ...this.snapshot,
        phase: "listening",
        issue: "",
      };
      this.diagnostic({ type: "discard", utteranceId: draft.id, detail: LATE_RESULT_ISSUE });
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
      inferenceStartedAtMs: this.platform.now(),
      invalidated: false,
      endReason: event.endReason,
      overlapActive: false,
      settled: false,
      backgroundOnly: false,
      abort,
      deadlineTimer: setTimeout(
        () => this.deadline(draft.id, draft.generation),
        remaining,
      ),
    };
    this.pending = pending;
    this.snapshot = { ...this.snapshot, phase: "busy" };
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
      if (!this.isPending(pending)) return;
      if (response.status === 504 || response.status === 409) {
        this.discardPending(
          pending,
          response.status === 409
            ? "Wait a moment, then say your spell again"
            : LATE_RESULT_ISSUE,
        );
        return;
      }
      if (response.status >= 500) {
        this.requestFailures++;
        this.discardPending(pending, "Local speech helper temporarily unavailable");
        if (this.requestFailures >= 3)
          this.snapshot = { ...this.snapshot, issue: "Speech helper unavailable; retrying with your next spell." };
        return;
      }
      if (!response.ok) throw new Error("Local speech transcription failed");
      this.requestFailures = 0;
      const result = (await response.json()) as HelperResult;
      this.result(pending, result);
    } catch (error) {
      if (!pending.abort.signal.aborted && this.isPending(pending)) {
        if (error instanceof TypeError) {
          this.requestFailures++;
          this.discardPending(pending, "Local speech request interrupted");
          if (this.requestFailures >= 3)
            this.snapshot = { ...this.snapshot, issue: "Speech helper unavailable; retrying with your next spell." };
        } else this.fail("Microphone recognition is unavailable. Try reconnecting it.");
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
      this.discardPending(pending, LATE_RESULT_ISSUE);
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
    const spell = result.accepted === false ? null : canonicalSpell(result.text);
    if (result.spell !== spell) {
      this.fail("Local speech helper returned inconsistent evidence");
      return;
    }
    this.diagnostic({ type: "result", utteranceId: pending.id, spell: spell ?? undefined,
      inferenceMs: result.inferenceMs, transcript: (result.transcript ?? result.text).slice(0, 512),
      voiceStartMs: pending.startMs, voiceEndMs: pending.endMs,
      speechDurationMs: result.speechDurationMs ?? undefined, avgLogProbability: result.avgLogProbability ?? undefined,
      noSpeechProbability: result.noSpeechProbability ?? undefined,
      endReason: pending.endReason,
      detail: pending.invalidated ? pending.endReason !== "silence" ? "Ambiguous continuation or paused cutoff discarded"
        : "Paused utterance discarded" : result.reason ?? (spell ? "Incantation accepted" : "Non-spell or uncertain audio ignored") });
    if (pending.invalidated) return;
    pending.backgroundOnly = result.reason === "no-speech";
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
        issue: "",
      };
    }
    pending.settled = true;
    const disposition = pending.endReason === "silence" &&
      (result.reason === "no-speech" || result.reason === "not-an-incantation")
      ? "confirmed-nonspell" : "ambiguous";
    this.completePending(pending, spell !== null, disposition);
  }

  private deadline(id: string, generation: number): void {
    if (
      this.pending?.id === id &&
      this.pending.generation === generation &&
      generation === this.generation
    ) {
      this.discardPending(this.pending, LATE_RESULT_ISSUE);
    }
  }

  /** A late or busy response consumes its utterance without queuing or stopping capture. */
  private discardPending(pending: Pending, issue: string): void {
    if (!this.isPending(pending)) return;
    pending.abort.abort();
    pending.settled = true;
    this.diagnostic({ type: "discard", utteranceId: pending.id, detail: issue });
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

  private notifyDiscard(utterance: Pick<SpeechDiscard, "id" | "generation">,
    disposition: SpeechDiscard["disposition"] = "ambiguous"): void {
    for (const listener of this.discardListeners)
      listener({ id: utterance.id, generation: utterance.generation, disposition });
  }

  private completePending(pending: Pending, emitted = false,
    disposition: SpeechDiscard["disposition"] = "ambiguous"): void {
    if (!this.isPending(pending)) return;
    clearTimeout(pending.deadlineTimer);
    this.pending = undefined;
    this.completedInference = pending.endReason === "silence" && !pending.invalidated && this.recognitionEnabled
      ? { generation: pending.generation, startMs: pending.inferenceStartedAtMs, endMs: this.platform.now() }
      : undefined;
    if (!emitted) this.notifyDiscard(pending, disposition);
    this.endpoint?.resolve(pending.backgroundOnly);
    // A fast result can finish before a continuing sound reaches its 60ms
    // onset. Keep the cutoff tail suppressed after this request is gone, while
    // preserving both its first result and quiet already observed during ASR.
    if (pending.endReason !== "silence") this.endpoint?.requireQuiet(true);
    this.snapshot = {
      ...this.snapshot,
      phase: "listening",
      issue: this.requestFailures >= 3 ? this.snapshot.issue : "",
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
    this.diagnostic({ type: "capture-reset", detail: issue });
    this.diagnostic({ type: "fault", detail: issue });
    this.teardown("fault", issue);
  }

  private recoverCapture(issue: string): void {
    const now = this.platform.now();
    this.captureRestarts = this.captureRestarts.filter(atMs => now - atMs < 30_000);
    if (this.platform.isHidden() || this.captureRestarts.length >= 2) {
      this.fail(issue);
      return;
    }
    this.captureRestarts.push(now);
    this.diagnostic({ type: "capture-reset", detail: issue });
    this.teardown("off", "");
    const generation = this.generation;
    const recoveryUntilMs = now + 5_000;
    this.recoveryUntilMs = recoveryUntilMs;
    this.snapshot = { phase: "starting", issue: "", generation };
    this.diagnostic({ type: "recovered", detail: "Restarting interrupted microphone with a fresh audio clock" });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (generation !== this.generation) return;
      if (this.platform.isHidden()) this.fail("Page is hidden; return to the game before enabling speech");
      else void this.startSession(recoveryUntilMs);
    }, 250);
  }

  private diagnostic(event: Omit<SpeechDiagnostic, "atMs" | "generation">): void {
    for (const listener of this.diagnosticListeners)
      listener({ ...event, atMs: this.platform.now(), generation: this.generation });
  }

  private teardown(phase: "off" | "fault", issue: string): void {
    this.generation++;
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.recoveryUntilMs = 0;
    this.requestFailures = 0;
    this.captureRecoveries = 0;
    this.pending?.abort.abort();
    if (this.pending) clearTimeout(this.pending.deadlineTimer);
    this.pending = undefined;
    this.completedInference = undefined;
    this.draft = undefined;
    this.endpoint = undefined;
    this.capture?.stop();
    this.capture = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
    this.snapshot = { phase, issue, generation: this.generation };
  }
}

function canonicalSpell(text: string): SpeechSpell | null {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/^[\s.,!?;:'"“”‘’]+|[\s.,!?;:'"“”‘’]+$/g, "")
    .trim();
  return SPELLS.some((spell) => spell === normalized)
    ? (normalized as SpeechSpell)
    : null;
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
      document.addEventListener("visibilitychange", visibility);
      return () => {
        document.removeEventListener("visibilitychange", visibility);
      };
    },
    openCapture: async (generation, workletUrl, onFrame, onLost) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { exact: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      let context: AudioContext | undefined;
      let source: MediaStreamAudioSourceNode | undefined;
      let node: AudioWorkletNode | undefined;
      let audioWatchdog: ReturnType<typeof setInterval> | undefined;
      let stopped = false;
      let ended: (() => void) | undefined;
      let contextStateChanged: (() => void) | undefined;
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        if (audioWatchdog !== undefined) clearInterval(audioWatchdog);
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
        if (context && contextStateChanged) context.removeEventListener("statechange", contextStateChanged);
        for (const item of stream.getTracks()) item.stop();
        if (context) void context.close().catch(() => undefined);
      };
      const lost = (issue: string, recoverable = false) => {
        if (stopped) return;
        cleanup();
        onLost(issue, recoverable);
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
          lost("Audio worklet stopped; enable speech again", true);
        // Assemble the graph while its clock is explicitly suspended. Starting
        // the clock before the source and processor are connected can skip an
        // initial render quantum in Chrome.
        source.connect(node);
        await context.resume();
        // currentFrame can remain contiguous across a suspended audio clock
        // while performance.now() advances. Retire this mapping instead of
        // assigning stale timestamps to resumed or already queued microphone data.
        contextStateChanged = () => {
          if (context?.state !== "running")
            lost("Microphone audio clock stopped; enable speech again", true);
        };
        context.addEventListener("statechange", contextStateChanged);
        if (context.state !== "running")
          throw new Error("Microphone audio clock stopped; enable speech again");
        const timeOriginMs = performance.now() - context.currentTime * 1000;
        let lastAudioAtMs = performance.now();
        node.port.onmessage = (message: MessageEvent<CapturedAudioFrame>) => {
          if (stopped) return;
          if (message.data.samples.length && !message.data.discontinuity)
            lastAudioAtMs = performance.now();
          onFrame(message.data, timeOriginMs);
        };
        audioWatchdog = setInterval(() => {
          if (performance.now() - lastAudioAtMs >= AUDIO_FRAME_TIMEOUT_MS)
            lost("Microphone produced no audio; enable speech again", true);
        }, 500);
        return { stop: cleanup };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  };
}
