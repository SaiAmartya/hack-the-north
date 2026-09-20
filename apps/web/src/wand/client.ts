import {
  ControlOpcode,
  StatusKind,
  CommandResultCode,
  HealthFlag,
  MotionFlag,
  decodeInfo,
  decodeMotion,
  decodeStatus,
  encodeControl,
  isSupportedDuelProfile,
  classifySequence16,
  unsignedDelta32,
  type ControlCommand,
  type InfoRecord,
  type MotionRecord,
  type StatusRecord,
  type SetStateCommand,
  type CueCommand,
} from "./protocol";
import type { WandTransport, TransportFailure } from "./transport";

type Ack = Extract<StatusRecord, { kind: StatusKind.CommandResult }>;
type Header = "version" | "commandSeq" | "linkNonce";
type CommandBody<T = ControlCommand> = T extends ControlCommand
  ? Omit<T, Header>
  : never;
export type FeedbackState = Pick<
  SetStateCommand,
  "phase" | "hp" | "maxHp" | "statusFlags" | "presentationEpoch"
>;
type FeedbackCue = Pick<
  CueCommand,
  "effect" | "spell" | "durationMs" | "presentationEpoch"
>;
type Sync = {
  deviceMs: number;
  browserMs: number;
  measuredAt: number;
  rttMs: number;
};
export type CapturedMotion = MotionRecord & {
  browserMs: number;
  ageUpperMs: number;
  breaksGesture: boolean;
};
export type WandDiagnostic = { kind: string; atMs: number; data: unknown };

export type WandSnapshot = {
  source: WandTransport["source"];
  phase:
    | "disconnected"
    | "connecting"
    | "synchronizing"
    | "recovering"
    | "suspended"
    | "validating"
    | "streaming"
    | "unsupported"
    | "fault";
  generation: number;
  info?: InfoRecord;
  issue: string;
  failureCode?: string;
  canRetry?: boolean;
  feedbackWarning: string;
  accepted: number;
  rejected: number;
  lost: number;
  deviceDropped: number;
  maxGapMs: number;
  observedHz?: number;
  healthFlags: number;
  uncertaintyMs?: number;
  rttMs?: number;
  ackMs?: number;
  lastSample?: CapturedMotion;
};

const BROWSER_STALL_MS = 200;
const BROWSER_PAUSE_MS = 2000;
const RECOVERY_LIMIT = 3;
const RECOVERY_WINDOW_MS = 60_000;

function signedDelta32(next: number, previous: number): number {
  const delta = unsignedDelta32(next, previous);
  return delta >= 0x80000000 ? delta - 0x100000000 : delta;
}

function randomNonzero(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
}

export class WandClient {
  onDiagnostic?: (event: WandDiagnostic) => void;
  private snapshot: WandSnapshot;
  private generation = 0;
  private nonce = 0;
  private sequence = 0;
  private sync?: Sync;
  private pending?: {
    command: ControlCommand;
    received: (ack: Ack, time: number) => void;
    reject: (error: Error) => void;
  };
  private timer?: ReturnType<typeof setInterval>;
  private lastTick = 0;
  private lastValid = 0;
  private previous?: MotionRecord;
  private broken = true;
  private samples: CapturedMotion[] = [];
  private listeners = new Set<(sample: CapturedMotion) => void>();
  private desired?: FeedbackState;
  private acknowledged?: FeedbackState;
  private stateDue = 0;
  private syncDue = 0;
  private cues: (FeedbackCue & { expiresAt: number })[] = [];
  private pumping = false;
  private recovering = false;
  private carrierGeneration = 0;
  private carrierRecovering = 0;
  private carrierOperation?: Promise<unknown>;
  private resuming?: Promise<void>;
  private carrierSession?: { nonce: number; sequence: number };
  private recoveryTimes: number[] = [];
  private validation?: { startedAt: number; since?: number; resolve: () => void; reject: (error: Error) => void };

  constructor(
    private readonly transport: WandTransport,
    private readonly now = () => performance.now(),
  ) {
    this.snapshot = this.emptySnapshot("disconnected");
  }

  getSnapshot(): WandSnapshot {
    const span =
      this.samples.length > 1
        ? this.samples.at(-1)!.browserMs - this.samples[0].browserMs
        : 0;
    return {
      ...this.snapshot,
      uncertaintyMs: this.sync ? this.uncertainty() : undefined,
      observedHz:
        span > 0 ? ((this.samples.length - 1) * 1000) / span : undefined,
    };
  }

  onSample(listener: (sample: CapturedMotion) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSamples(): readonly CapturedMotion[] {
    return this.samples.slice();
  }

  async connect(): Promise<void> {
    this.disconnect();
    const generation = this.generation;
    this.snapshot = this.emptySnapshot("connecting");
    try {
      await this.runCarrier(this.transport.connect(this.disconnected(++this.carrierGeneration)));
      await this.handshake(generation);
    } catch (error) {
      if (generation === this.generation)
        this.fail(error instanceof Error ? error.message : "Connection failed", false);
    }
  }

  private disconnected(generation: number) {
    return (failure?: TransportFailure) => {
      if (generation !== this.carrierGeneration || this.carrierRecovering === generation || this.snapshot.phase === "suspended") return;
      this.fail(failure?.message ?? "Device connection ended", failure?.recoverable ?? false,
        failure?.code ?? "device_disconnected");
    };
  }

  private canRecover(): boolean {
    return Boolean(this.transport.recover) && (this.transport.canRecover ? this.transport.canRecover() : true);
  }

  private async runCarrier<T>(operation: Promise<T>): Promise<T> {
    this.carrierOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.carrierOperation === operation) this.carrierOperation = undefined;
    }
  }

  private async handshake(generation: number, requireValidation = Boolean(this.transport.recover), session?: { nonce: number; sequence: number }): Promise<void> {
      this.assertGeneration(generation);
      const info = decodeInfo(await this.transport.readInfo());
      this.assertGeneration(generation);
      this.snapshot.info = info;
      if (!isSupportedDuelProfile(info)) {
        this.snapshot.phase = "unsupported";
        this.snapshot.issue =
          this.transport.source === "REAL BLE"
            ? "This badge’s firmware needs repair. Use your iPhone while it is qualified."
            : "This input does not report a supported sensor profile.";
        return;
      }
      await this.transport.subscribe("status", (bytes) => {
        if (generation === this.generation) this.status(bytes);
      });
      this.assertGeneration(generation);
      await this.transport.subscribe("motion", (bytes) => {
        if (generation === this.generation) this.motion(bytes);
      });
      this.assertGeneration(generation);
      this.nonce = session?.nonce ?? randomNonzero();
      this.snapshot.phase = "synchronizing";
      if (session) this.sequence = session.sequence;
      else await this.command({ opcode: ControlOpcode.Open }, true);
      this.assertGeneration(generation);
      this.carrierSession = { nonce: this.nonce, sequence: this.sequence };
      let best: Sync | undefined;
      for (let i = 0; i < 5; i++) {
        const candidate = await this.probe();
        this.assertGeneration(generation);
        if (!best || candidate.rttMs < best.rttMs) best = candidate;
      }
      this.assertGeneration(generation);
      if (!best || best.rttMs > 100)
        throw new Error("Clock sync RTT exceeds 100 ms");
      this.sync = best;
      this.snapshot.rttMs = best.rttMs;
      const health = await this.transport.readStatus();
      this.assertGeneration(generation);
      this.status(health);
      const inputFault = this.inputFault(this.snapshot.healthFlags);
      if (inputFault) throw new Error(inputFault);
      this.snapshot.phase = requireValidation ? "validating" : "streaming";
      this.lastTick = this.lastValid = this.now();
      this.syncDue = this.now() + 5000;
      this.timer = setInterval(() => this.tick(), 25);
      if (requireValidation) {
        await new Promise<void>((resolve, reject) => { this.validation = { startedAt: this.now(), resolve, reject }; });
        this.assertGeneration(generation);
      }
  }

  disconnect(): void {
    this.carrierGeneration++;
    this.carrierSession = undefined;
    this.clearProtocol();
    this.recovering = false;
    this.transport.disconnect();
  }

  private clearProtocol(): void {
    this.generation++;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.pending?.reject(new Error("Session ended"));
    this.pending = undefined;
    this.validation?.reject(new Error("Input validation interrupted"));
    this.validation = undefined;
    this.sync = this.previous = this.desired = this.acknowledged = undefined;
    this.samples = [];
    this.cues = [];
    this.sequence = 0;
    this.broken = true;
    this.pumping = false;
    this.snapshot = this.emptySnapshot("disconnected");
  }

  suspend(): void {
    if (["disconnected", "fault", "unsupported", "suspended"].includes(this.snapshot.phase)) return;
    const info = this.snapshot.info;
    this.clearProtocol();
    this.recovering = false;
    this.resuming = undefined;
    this.snapshot = { ...this.snapshot, phase: "suspended", info, issue: "Return to the duel to resume your wand." };
  }

  async resume(): Promise<void> {
    if (this.resuming) return this.resuming;
    if (this.snapshot.phase !== "suspended") return;
    const generation = this.generation;
    const operation = (async () => {
      // A chooser or carrier recovery already in flight still owns its physical link.
      try { await this.carrierOperation; } catch { /* The fresh handshake reports the remaining failure. */ }
      if (generation !== this.generation) return;
      const session = this.carrierSession;
      if (this.canRecover()) {
        await this.recover("Restoring your wand connection", undefined, session);
      } else {
        try {
          await this.handshake(generation, true, session);
        } catch (error) {
          if (generation === this.generation)
            this.fail(error instanceof Error ? error.message : "Wand connection failed", false);
        }
      }
    })();
    this.resuming = operation;
    try { await operation; }
    finally { if (this.resuming === operation) this.resuming = undefined; }
  }

  /** Explicit retry after bounded automatic carrier recovery. Never resumes combat. */
  async retryRecovery(): Promise<void> {
    if (!this.canRecover() || this.recovering) return;
    this.recoveryTimes = [];
    await this.recover(this.snapshot.issue || "Restoring wand connection", this.snapshot.failureCode);
  }

  setState(state: FeedbackState): void {
    if (this.snapshot.phase !== "streaming") return;
    if (this.desired?.presentationEpoch !== state.presentationEpoch)
      this.cues = [];
    this.desired = { ...state };
    this.stateDue = 0;
    void this.pump();
  }

  cue(cue: FeedbackCue): void {
    if (
      this.snapshot.phase !== "streaming" ||
      cue.presentationEpoch !== this.desired?.presentationEpoch
    )
      return;
    this.cues = this.cues
      .filter((item) => item.expiresAt > this.now())
      .slice(-3);
    this.cues.push({ ...cue, expiresAt: this.now() + 300 });
    void this.pump();
  }

  stopFeedback(): void {
    this.desired = this.acknowledged = undefined;
    this.cues = [];
  }

  private emptySnapshot(phase: WandSnapshot["phase"]): WandSnapshot {
    return {
      source: this.transport.source,
      phase,
      generation: this.generation,
      issue: "",
      feedbackWarning: "",
      accepted: 0,
      rejected: 0,
      lost: 0,
      deviceDropped: 0,
      maxGapMs: 0,
      healthFlags: 0,
    };
  }

  private fail(reason: string, recoverable = true, code = "input_interrupted"): void {
    this.diagnose("wand.fault", { reason, recoverable, code, generation: this.generation });
    if (this.snapshot.phase === "fault" && this.snapshot.issue) return;
    if (recoverable && this.canRecover() && !this.recovering &&
        this.live()) {
      // Bounded automatic recovery: a link that keeps dropping needs the player, not a loop.
      const now = this.now();
      this.recoveryTimes = this.recoveryTimes.filter((at) => now - at < RECOVERY_WINDOW_MS);
      if (this.recoveryTimes.length < RECOVERY_LIMIT) {
        this.recoveryTimes.push(now);
        void this.recover(reason, code);
        return;
      }
      reason = "Your wand keeps dropping out. Reconnect it to continue.";
      code = "unstable_link";
    }
    const last = this.snapshot;
    // Keep an approved phone pair available for an explicit retry. A badge link is dropped so the
    // badge advertises again and stops streaming into the void; the chosen device is remembered,
    // so an explicit retry still needs no chooser.
    this.clearProtocol();
    if (!this.transport.recover || this.transport.source === "REAL BLE") this.transport.disconnect();
    this.snapshot = {
      ...last,
      generation: this.generation,
      phase: "fault",
      issue: reason,
      failureCode: code,
      canRetry: this.canRecover(),
      lastSample: undefined,
    };
  }

  private async recover(reason: string, code?: string, session?: { nonce: number; sequence: number }): Promise<void> {
    const info = this.snapshot.info;
    this.carrierSession = session;
    this.clearProtocol();
    const generation = this.generation;
    this.recovering = true;
    this.snapshot = { ...this.snapshot, phase: "recovering", info, issue: reason,
      failureCode: code, canRetry: false };
    try {
      const carrierGeneration = ++this.carrierGeneration;
      this.carrierRecovering = carrierGeneration;
      let retained: boolean | void;
      try {
        retained = await this.runCarrier(this.transport.recover!(this.disconnected(carrierGeneration), Boolean(session)).then(retained => {
          if (carrierGeneration === this.carrierGeneration && !retained) this.carrierSession = undefined;
          return retained;
        }));
      } finally {
        if (this.carrierRecovering === carrierGeneration) this.carrierRecovering = 0;
      }
      this.assertGeneration(generation);
      // The carrier is back; a fault during the new handshake's validation may recover again
      // (within the budget) instead of ending in a manual fault.
      this.recovering = false;
      await this.handshake(generation, true, retained ? session : undefined);
    } catch (error) {
      if (generation === this.generation) {
        this.fail(error instanceof Error ? error.message : reason, false, code);
      }
    } finally {
      if (generation === this.generation || this.snapshot.phase === "fault") this.recovering = false;
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("Session superseded");
  }

  /** The link carries motion: streaming, or validating the first second after a handshake. */
  private live(): boolean {
    return this.snapshot.phase === "streaming" || this.snapshot.phase === "validating";
  }

  private async command(
    body: CommandBody,
    retryOpen = false,
  ): Promise<{ ack: Ack; sent: number; received: number }> {
    if (this.pending) throw new Error("Only one command may be outstanding");
    const generation = this.generation;
    const command: ControlCommand = {
      ...body,
      version: 1,
      commandSeq: this.sequence,
      linkNonce: this.nonce,
    };
    this.sequence = (this.sequence + 1) & 0xffff;
    if (this.carrierSession?.nonce === this.nonce) this.carrierSession.sequence = this.sequence;
    const bytes = encodeControl(command);
    for (let attempt = 0; ; attempt++) {
      this.assertGeneration(generation);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const sent = this.now();
      this.diagnose("wand.control", { ...body, commandSeq: command.commandSeq, attempt });
      let rejectOperation: (error: Error) => void = () => undefined;
      const result = new Promise<{ ack: Ack; sent: number; received: number }>(
        (resolve, reject) => {
          rejectOperation = reject;
          this.pending = {
            command,
            reject,
            received: (ack, received) => resolve({ ack, sent, received }),
          };
        },
      );
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Command acknowledgement timed out")),
          1000,
        );
      });
      try {
        const [reply] = await Promise.race([
          Promise.all([result, this.transport.writeControl(bytes)]),
          deadline,
        ]);
        this.assertGeneration(generation);
        if (reply.ack.resultCode !== CommandResultCode.Ok)
          throw new Error(`Command rejected (${reply.ack.resultCode})`);
        this.snapshot.ackMs = reply.received - sent;
        return reply;
      } catch (error) {
        rejectOperation(new Error("Command ended"));
        if (
          !(
            retryOpen &&
            attempt === 0 &&
            error instanceof Error &&
            error.message === "Command acknowledgement timed out"
          )
        )
          throw error;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (generation === this.generation) this.pending = undefined;
      }
    }
  }

  private async probe(): Promise<Sync> {
    const { ack, sent, received } = await this.command({
      opcode: ControlOpcode.Sync,
    });
    return {
      deviceMs: ack.deviceMs,
      browserMs: (sent + received) / 2,
      measuredAt: received,
      rttMs: received - sent,
    };
  }

  private uncertainty(): number {
    return this.sync
      ? this.sync.rttMs / 2 + 1 + // Two integer-ms device stamps can differ by one rounding interval.
          Math.max(0, this.now() - this.sync.measuredAt) * 0.005
      : Infinity;
  }

  private deviceAt(browserMs: number): number {
    if (!this.sync) throw new Error("Clock unavailable");
    return (
      (this.sync.deviceMs + Math.floor(browserMs - this.sync.browserMs)) >>> 0
    );
  }

  private status(bytes: Uint8Array): void {
    let record: StatusRecord;
    try {
      record = decodeStatus(bytes);
    } catch {
      this.diagnose("wand.status_rejected", { reason: "Malformed STATUS" });
      this.snapshot.feedbackWarning = "Malformed STATUS";
      return;
    }
    if (this.onDiagnostic) {
      const { linkNonce: _nonce, ...status } = record;
      this.diagnose("wand.status", status);
    }
    if (record.linkNonce !== this.nonce) return;
    if (record.kind === StatusKind.CommandResult) {
      if (
        record.commandSeq === this.pending?.command.commandSeq &&
        record.opcode === this.pending.command.opcode
      ) {
        this.pending.received(record, this.now());
      }
      return;
    }
    this.snapshot.healthFlags = record.healthFlags;
    this.snapshot.deviceDropped = record.droppedCount;
    this.snapshot.feedbackWarning =
      record.healthFlags & HealthFlag.PresentationHealthy
        ? ""
        : "Device presentation unhealthy";
    const inputFault = this.inputFault(record.healthFlags);
    if (this.live() && inputFault)
      this.fail(inputFault);
  }

  private inputFault(flags: number): string | undefined {
    if (!(flags & HealthFlag.SensorHealthy)) return "Sensor unhealthy";
    if (!(flags & HealthFlag.StreamEnabled)) return "Device stream disabled";
  }

  private rejectSample(reason: string): void {
    this.diagnose("wand.sample_rejected", { reason, generation: this.generation, seq: this.previous?.seq });
    this.snapshot.rejected++;
    this.snapshot.issue = reason;
    this.broken = true;
    this.samples = [];
    if (this.validation) this.validation.since = undefined;
  }

  private motion(bytes: Uint8Array): void {
    if (this.onDiagnostic) this.diagnose("wand.raw_motion", {
      hex: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" "),
      generation: this.generation, phase: this.snapshot.phase,
    });
    if (!this.sync || !this.live()) return;
    if (!this.checkTiming(this.now())) return;
    let record: MotionRecord;
    try {
      record = decodeMotion(bytes);
    } catch {
      this.rejectSample("Malformed MOTION");
      return;
    }
    if (record.bootId !== this.snapshot.info?.bootId) {
      this.fail("Device rebooted; new handshake required");
      return;
    }
    if (this.previous) {
      const order = classifySequence16(record.seq, this.previous.seq);
      if (order !== "newer") {
        this.diagnose("wand.sample_rejected", { reason: order, seq: record.seq, generation: this.generation });
        this.snapshot.rejected++;
        return;
      }
      const delta = unsignedDelta32(record.captureMs, this.previous.captureMs);
      if (delta === 0 || delta >= 0x80000000) {
        this.fail("Capture clock went backwards or repeated");
        return;
      }
      this.snapshot.lost +=
        ((record.seq - this.previous.seq + 65536) % 65536) - 1;
      this.snapshot.maxGapMs = Math.max(this.snapshot.maxGapMs, delta);
      if (delta > 150) this.broken = true;
    }
    this.previous = record;
    const bound = (this.snapshot.info?.rangeG ?? 8) * 1000;
    if ([record.axMg, record.ayMg, record.azMg].some(value => Math.abs(value) > bound)) {
      this.rejectSample("Motion exceeds the reported sensor range");
      return;
    }
    const browserMs =
      this.sync.browserMs + signedDelta32(record.captureMs, this.sync.deviceMs);
    const age = this.now() - browserMs;
    const uncertainty = this.uncertainty();
    if (age + uncertainty > 200 || age < -uncertainty) {
      this.rejectSample("Stale or future motion sample");
      return;
    }
    if (
      !(record.flags & MotionFlag.Valid) ||
      record.flags & (MotionFlag.Saturated | MotionFlag.Discontinuity)
    ) {
      this.rejectSample("Invalid, clipped or discontinuous sample");
      return;
    }
    const sample: CapturedMotion = {
      ...record,
      browserMs,
      ageUpperMs: age + uncertainty,
      breaksGesture: this.broken,
    };
    if (this.onDiagnostic)
      this.diagnose("wand.sample", { ...sample, generation: this.generation, phase: this.snapshot.phase });
    if (this.broken) this.samples = [];
    this.broken = false;
    this.lastValid = this.now();
    this.samples = this.samples
      .filter((item) => browserMs - item.browserMs <= 2000)
      .slice(-100);
    this.samples.push(sample);
    this.snapshot.accepted++;
    this.snapshot.lastSample = sample;
    this.snapshot.issue = "";
    if (this.validation) {
      if (sample.breaksGesture || this.validation.since === undefined)
        this.validation.since = sample.browserMs;
      if (sample.browserMs - this.validation.since < 1000) return;
      const validation = this.validation;
      this.validation = undefined;
      this.snapshot.phase = "streaming";
      sample.breaksGesture = true;
      validation.resolve();
    }
    for (const listener of this.listeners) listener(sample);
  }

  private diagnose(kind: string, data: unknown): void {
    this.onDiagnostic?.({ kind, atMs: this.now(), data });
  }

  private checkTiming(now: number): boolean {
    const stall = now - this.lastTick;
    if (stall > BROWSER_PAUSE_MS) {
      this.fail("The page paused for too long; reconnecting your wand", true, "browser_paused");
      return false;
    }
    if (stall > BROWSER_STALL_MS) {
      // Contract section 6: a stall clears pending evidence and requires a fresh baseline. The
      // link stays up; buffered samples fail the age check and the next fresh one breaks gestures.
      this.broken = true;
      this.samples = [];
      this.lastTick = now;
      this.lastValid = now;  // the wand was not silent; the page was. Give fresh motion its full 500 ms.
      if (this.validation) this.validation.since = undefined;
      this.syncDue = Math.min(this.syncDue, now);
    }
    if (
      !this.sync ||
      now - this.sync.measuredAt > 10000 ||
      this.uncertainty() > 100
    ) {
      this.fail("Clock synchronization expired");
      return false;
    }
    return true;
  }

  private tick(): void {
    if (!this.live()) return;
    const now = this.now();
    if (!this.checkTiming(now)) return;
    this.lastTick = now;
    if (now - this.lastValid >= 500) {
      this.fail("No fresh motion for 500 ms", true, "motion_silent");
      return;
    }
    if (this.validation && now - this.validation.startedAt >= 10_000) {
      this.fail("Motion keeps arriving with gaps. Check the connection and retry.", false, "unstable_input");
      return;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.pending || !this.live())
      return;
    const generation = this.generation;
    const syncing = this.now() >= this.syncDue;
    this.pumping = true;
    try {
      if (syncing) {
        const candidate = await this.probe();
        this.assertGeneration(generation);
        if (!this.checkTiming(this.now())) return;
        // A missed probe must not postpone the next attempt past the 10 s lease.
        this.syncDue = this.now() + (candidate.rttMs <= 100 ? 5000 : 500);
        if (candidate.rttMs <= 100) {
          const oldMapped = this.sync
            ? this.sync.browserMs +
              signedDelta32(candidate.deviceMs, this.sync.deviceMs)
            : candidate.browserMs;
          if (Math.abs(oldMapped - candidate.browserMs) > this.uncertainty()) {
            this.broken = true;
            this.samples = [];
          }
          this.sync = candidate;
          this.snapshot.rttMs = candidate.rttMs;
        }
      } else if (this.snapshot.phase === "validating") {
        // A continuity check still owns a live clock. Do not let waiting for
        // clean motion masquerade as expired clock sync; no game feedback yet.
        return;
      } else if (this.desired && this.now() >= this.stateDue) {
        const state = this.desired;
        this.stateDue = this.now() + 500;
        await this.command({
          opcode: ControlOpcode.SetState,
          ...state,
          validUntilMs: this.deviceAt(this.now() + 1200),
        });
        this.assertGeneration(generation);
        this.acknowledged = state;
      } else {
        this.cues = this.cues.filter(
          (cue) => cue.expiresAt > this.now() + this.uncertainty(),
        );
        if (this.cues.length && this.acknowledged === this.desired) {
          const cue = this.cues.shift()!;
          await this.command({
            opcode: ControlOpcode.Cue,
            effect: cue.effect,
            spell: cue.spell,
            durationMs: cue.durationMs,
            presentationEpoch: cue.presentationEpoch,
            startBeforeMs: this.deviceAt(cue.expiresAt),
          });
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        if (syncing) this.syncDue = this.now() + 500;
        this.snapshot.feedbackWarning =
          error instanceof Error ? error.message : "Feedback unavailable";
      }
    } finally {
      if (generation === this.generation) this.pumping = false;
    }
  }
}
