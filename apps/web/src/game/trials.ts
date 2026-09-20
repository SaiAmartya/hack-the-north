import type { Spell, Source } from "./contracts";
import type { TelemetryEntry } from "./telemetry";
import type { SpeechPhase } from "../speech/client";

export type TrialLabel = Spell | "still" | "fidget";
export type TrialPhase = "countdown" | "move" | "settle" | "rest";
export const TRIAL_PHASES: readonly { phase: TrialPhase; durationMs: number }[] = [
  { phase: "countdown", durationMs: 3000 },
  { phase: "move", durationMs: 3000 },
  { phase: "settle", durationMs: 2000 },
  { phase: "rest", durationMs: 2000 },
];
export const TRIAL_DURATION_MS = 10_000;
export const TRIAL_COUNT = 10;
const MAX_EVENTS_PER_TRIAL = 6000;

export type TrialContext = {
  source?: Source;
  inputGeneration: number;
  wandGeneration?: number;
  bootId?: number;
  profile: string;
  streaming: boolean;
  hidden: boolean;
  enabled: boolean;
  inRoom: boolean;
  speechPhase: SpeechPhase;
  speechGeneration: number;
};
export type GestureTrial = {
  number: number;
  intendedLabel: TrialLabel;
  status: "pending" | "recording" | "completed" | "interrupted";
  startedAtMs: number;
  endedAtMs: number;
  phases: { phase: TrialPhase; startMs: number; endMs: number }[];
  interruption?: { atMs: number; reason: string };
  observation: string;
  entries: TelemetryEntry[];
};

function withoutSpeech(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpeech);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/speech|transcript|utterance|voice|microphone/i.test(key))
    .map(([key, item]) => [key, withoutSpeech(item)]));
}

export function microphoneReady(phase: SpeechPhase): boolean {
  return phase === "listening" || phase === "busy";
}

/** Labels and recording windows never depend on a successful classification. */
export class GestureTrialRecorder {
  trials: GestureTrial[] = [];
  running = false;
  label: TrialLabel = "protego";
  speak = true;
  notes = "";
  stoppedReason = "";
  capturedAt = "";
  metadata: Record<string, unknown> = {};
  private context?: TrialContext;
  private lastTick = 0;
  private lastId = 0;

  get includesSpeech(): boolean {
    return this.speak && this.label !== "still" && this.label !== "fidget";
  }

  start(now: number, context: TrialContext, lastId: number, metadata: Record<string, unknown>): void {
    if (this.trials.length || !context.streaming || context.hidden || !context.enabled || !context.source || context.inRoom) return;
    if (this.includesSpeech && !microphoneReady(context.speechPhase)) return;
    this.context = { ...context };
    this.lastTick = now;
    this.lastId = lastId;
    this.metadata = metadata;
    this.capturedAt = new Date().toISOString();
    this.stoppedReason = "";
    this.running = true;
    this.trials = Array.from({ length: TRIAL_COUNT }, (_, index) => {
      const start = now + index * TRIAL_DURATION_MS;
      let cursor = start;
      return {
        number: index + 1, intendedLabel: this.label,
        status: index === 0 ? "recording" : "pending",
        startedAtMs: start, endedAtMs: start + TRIAL_DURATION_MS,
        phases: TRIAL_PHASES.map(({ phase, durationMs }) => {
          const boundary = { phase, startMs: cursor, endMs: cursor + durationMs };
          cursor += durationMs;
          return boundary;
        }),
        observation: "", entries: [],
      };
    });
  }

  update(now: number, context: TrialContext, entries: readonly TelemetryEntry[]): void {
    if (!this.running || !this.context) return;
    const reason = context.hidden ? "page_hidden"
      : context.inRoom ? "duel_opened"
      : !context.enabled ? "dev_mode_disabled"
      : context.source !== this.context.source ? "source_changed"
      : !context.streaming ? "wand_not_streaming"
      : context.inputGeneration !== this.context.inputGeneration || context.wandGeneration !== this.context.wandGeneration
        || context.bootId !== this.context.bootId || context.profile !== this.context.profile ? "input_context_changed"
      : this.includesSpeech && context.speechGeneration !== this.context.speechGeneration ? "speech_generation_changed"
      : this.includesSpeech && !microphoneReady(context.speechPhase) ? "microphone_not_ready"
      : now - this.lastTick > 500 ? "capture_timer_gap" : "";
    const firstUnseen = entries.find(entry => entry.id > this.lastId);
    const bufferGap = firstUnseen && firstUnseen.id > this.lastId + 1;
    // Stop before advancing across an unobserved interval. Never declare it completed.
    if (reason || bufferGap) {
      // Preserve the final received tail, but only inside the already active window.
      // New or pending windows cannot become evidence after a lifecycle or timing gap.
      this.capture(entries, now, true);
      this.interrupt(now, bufferGap ? "telemetry_buffer_gap" : reason);
      return;
    }
    this.capture(entries, now);
    if (!this.running) return;
    for (const trial of this.trials) {
      if (trial.status === "completed") continue;
      if (trial.endedAtMs <= now) {
        if (!trial.entries.some(entry => entry.kind === "wand.sample")) {
          this.interrupt(now, "no_motion_samples");
          return;
        }
        trial.status = "completed";
      }
      else if (trial.startedAtMs <= now) trial.status = "recording";
    }
    this.lastTick = now;
    if (now >= this.trials.at(-1)!.endedAtMs) this.running = false;
  }

  private capture(entries: readonly TelemetryEntry[], now: number, activeOnly = false) {
    for (const entry of entries) {
      if (entry.id <= this.lastId) continue;
      this.lastId = entry.id;
      const trial = this.trials.find(item => entry.atMs >= item.startedAtMs && entry.atMs < item.endedAtMs
        && (!activeOnly || item.status === "recording"));
      if (!trial || entry.atMs > now) continue;
      if (!this.includesSpeech && entry.kind.startsWith("speech.")) continue;
      if (trial.entries.length >= MAX_EVENTS_PER_TRIAL) {
        this.interrupt(now, "trial_event_limit");
        return;
      }
      trial.entries.push(this.includesSpeech ? entry : { ...entry, data: withoutSpeech(entry.data) });
    }
  }

  interrupt(now: number, reason: string) {
    if (!this.running) return;
    const current = this.trials.find(trial => trial.status === "recording");
    if (current) {
      current.status = "interrupted";
      current.interruption = { atMs: now, reason };
    }
    this.stoppedReason = reason;
    this.running = false;
  }

  reset(): void {
    if (this.running) return;
    this.trials = [];
    this.notes = this.stoppedReason = this.capturedAt = "";
    this.metadata = {};
    this.context = undefined;
    this.lastTick = this.lastId = 0;
  }

  export(): string {
    return JSON.stringify({
      format: "wandduel-gesture-trials-v1",
      capturedAt: this.capturedAt,
      exportedAt: new Date().toISOString(),
      intendedLabel: this.label,
      expectedGesture: this.label === "protego" || this.label === "episkey" ? "raise"
        : this.label === "still" || this.label === "fidget" ? "none" : "jab",
      speakDuringMovement: this.includesSpeech,
      notes: this.notes,
      context: this.includesSpeech ? this.context : withoutSpeech(this.context),
      metadata: this.includesSpeech ? this.metadata : withoutSpeech(this.metadata),
      clock: "All window boundaries and entry atMs use this page's performance.now() milliseconds. Device captureMs uses its separate clock. Phase boundaries are scheduled; interruption.atMs is actual stop time.",
      limits: { trials: TRIAL_COUNT, eventsPerTrial: MAX_EVENTS_PER_TRIAL },
      completed: this.trials.filter(trial => trial.status === "completed").length,
      stoppedReason: this.stoppedReason || null,
      trials: this.trials,
    }, null, 2);
  }
}
