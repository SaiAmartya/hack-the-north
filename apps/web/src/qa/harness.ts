import { GameClient } from "../game/client";
import type { Snapshot } from "../game/contracts";
import { CastFusion, type CastAttempt } from "../input/fusion";
import {
  MotionRecognizer,
  type GestureEvidence,
  type SpellName,
} from "../input/motion";
import { RawMotionTraceBuilder } from "../input/traceFixtures";
import { WandClient, type CapturedMotion } from "../wand/client";
import { VirtualWandTransport } from "../wand/virtual";
import type {
  ByteListener,
  NotificationKind,
} from "../wand/transport";
import { MotionFlag, formatDeviceId, type InfoRecord, type MotionRecord } from "../wand/protocol";

export type GameQaReport = {
  stage: "idle" | "running" | "complete" | "failed";
  detail: string;
  firstRound?: number;
  attackAccepted?: boolean;
  defenseAccepted?: boolean;
  blocked?: boolean;
  defenderHp?: number;
  abortOutcome?: string;
  rematchRound?: number;
};

class ScriptedVirtualTransport extends VirtualWandTransport {
  private idleTimer?: ReturnType<typeof setInterval>;
  private replaying = false;
  private captureSequence = 0;
  private playbackGeneration = 0;
  private previousCapture?: number;

  constructor(info: InfoRecord) {
    super(() => performance.now(), info);
  }

  override async connect(_onDisconnect: () => void): Promise<void> {
    this.disconnect();
    this.idleTimer = setInterval(() => {
      this.endpoint.tick();
      if (!this.replaying)
        this.emit({
          version: 1,
          flags: MotionFlag.Valid,
          seq: 0,
          captureMs: Math.floor(performance.now()) >>> 0,
          bootId: this.endpoint.info.bootId,
          axMg: 0,
          ayMg: 0,
          azMg: 1000,
        });
    }, 20);
  }

  override async readInfo(): Promise<Uint8Array> {
    return this.endpoint.readInfo();
  }

  override async readStatus(): Promise<Uint8Array> {
    return this.endpoint.readStatus();
  }

  override async subscribe(
    kind: NotificationKind,
    listener: ByteListener,
  ): Promise<void> {
    if (kind === "motion") this.endpoint.subscribeMotion(listener);
    else this.endpoint.subscribeStatus(listener);
  }

  override async writeControl(bytes: Uint8Array): Promise<void> {
    this.endpoint.writeControl(bytes);
  }

  override disconnect(): void {
    this.playbackGeneration++;
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    this.endpoint.disconnect();
  }

  async playTrace(samples: readonly CapturedMotion[]): Promise<void> {
    if (this.replaying || !samples.length)
      throw new Error("Invalid concurrent or empty QA replay");
    const generation = this.playbackGeneration;
    const startedAt = Math.ceil(performance.now()) + 20;
    this.replaying = true;
    try {
      for (const sample of samples) {
        const captureAt = startedAt + sample.browserMs - samples[0].browserMs;
        await delay(Math.max(0, Math.ceil(captureAt - performance.now())));
        if (generation !== this.playbackGeneration)
          throw new Error("QA replay connection ended");
        if (performance.now() - captureAt > 100)
          throw new Error("QA replay fell behind; refusing catch-up input");
        if (!this.emit({ ...sample, captureMs: Math.floor(captureAt) >>> 0 }))
          throw new Error("Scripted virtual wand is not streaming");
      }
    } finally {
      this.replaying = false;
    }
  }

  private emit(sample: MotionRecord): boolean {
    if (sample.captureMs === this.previousCapture) return false;
    this.previousCapture = sample.captureMs;
    return this.endpoint.emitMotion({
      ...sample,
      seq: this.captureSequence++ & 0xffff,
    });
  }
}

type CastAck = {
  accepted: boolean;
  reason?: string;
};

class QaPlayer {
  readonly game = new GameClient();
  readonly motion: MotionRecognizer;
  readonly fusion: CastFusion;
  readonly wand: WandClient;
  private readonly transport: ScriptedVirtualTransport;
  private readonly traces = new RawMotionTraceBuilder();
  private readonly generation = 1;
  private readonly castAcks = new Map<string, CastAck>();
  private latestGesture?: GestureEvidence;
  private latestAttempt?: CastAttempt;
  private speechSequence = 0;
  private unsubscribe?: () => void;

  constructor(private readonly playerNumber: 1 | 2) {
    const info: InfoRecord = {
      version: 1,
      capabilities: 15,
      sampleHz: 50,
      rangeG: 8,
      deviceId: [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf0 + playerNumber],
      bootId: 11,
      firmware: { major: 0, minor: 1, patch: 0 },
      axisConvention: 1,
    };
    this.transport = new ScriptedVirtualTransport(info);
    this.wand = new WandClient(this.transport);
    this.fusion = new CastFusion((attempt) => this.submitAttempt(attempt));
    this.motion = new MotionRecognizer((evidence) => {
      this.latestGesture = evidence;
      this.fusion.pushGesture(evidence);
    });
    this.game.getHealth = () => ({
      healthy: this.isHealthy(),
      inputGeneration: this.generation,
    });
    this.game.onAck = (message) => {
      if (message.command !== "cast" || typeof message.requestId !== "string")
        return;
      this.castAcks.set(message.requestId, {
        accepted: message.accepted === true,
        reason: typeof message.reason === "string" ? message.reason : undefined,
      });
    };
  }

  async connect(): Promise<void> {
    await this.game.connect("replay");
    this.unsubscribe = this.wand.onSample((sample) =>
      this.motion.push(sample, this.generation),
    );
    await this.wand.connect();
    if (this.wand.getSnapshot().phase !== "streaming")
      throw new Error(`Player ${this.playerNumber} virtual wand did not stream`);
  }

  async calibrate(): Promise<void> {
    this.motion.beginCalibration();
    await this.transport.playTrace(this.traces.stillness());
    this.motion.beginGestureCalibration("stupefy");
    await this.transport.playTrace(this.traces.jab(820));
    this.requireCalibrationExample("stupefy", 1);
    await this.transport.playTrace(this.traces.jab(900));
    this.requireCalibrationExample("stupefy", 2);
    await this.transport.playTrace(this.traces.jab(980));
    this.requireCalibrationExample("stupefy", 3);
    this.motion.beginGestureCalibration("protego");
    await this.transport.playTrace(this.traces.shake(650));
    this.requireCalibrationExample("protego", 1);
    await this.transport.playTrace(this.traces.shake(700));
    this.requireCalibrationExample("protego", 2);
    await this.transport.playTrace(this.traces.shake(750));
    const motion = this.motion.getState();
    if (motion.phase !== "ready")
      throw new Error(
        `Player ${this.playerNumber} raw calibration did not finish: ${motion.phase}, ${motion.lastIssue}, examples ${JSON.stringify(motion.examplesBySpell)}, wand ${this.wand.getSnapshot().issue}`,
      );
  }

  ready(): void {
    const info = this.wand.getSnapshot().info;
    if (!info || !this.isHealthy())
      throw new Error(`Player ${this.playerNumber} is not input healthy`);
    this.game.send({
      type: "ready",
      ready: true,
      inputGeneration: this.generation,
      healthy: true,
      deviceId: formatDeviceId(info.deviceId),
      bootId: info.bootId,
    });
  }

  async cast(spell: "stupefy" | "protego"): Promise<CastAck> {
    if (this.game.snapshot?.phase !== "playing")
      throw new Error("Scripted cast requires an active round");
    this.fusion.reset(this.generation);
    this.motion.clearPending("scripted QA attempt");
    this.latestGesture = undefined;
    this.latestAttempt = undefined;
    await this.transport.playTrace(
      spell === "stupefy" ? this.traces.jab(780) : this.traces.shake(680),
    );
    const gesture = this.requireGesture(spell);

    const utteranceId = `P${this.playerNumber}-speech-${++this.speechSequence}`;
    const startMs = gesture.startMs + 20;
    const endMs = Math.max(startMs + 20, gesture.endMs);
    this.fusion.beginUtterance({
      id: utteranceId,
      generation: this.generation,
      startMs,
    });
    this.fusion.pushUtterance({
      id: utteranceId,
      generation: this.generation,
      spell,
      startMs,
      endMs,
      finalAtMs: Math.max(endMs, performance.now()),
    });
    const attempt = this.requireAttempt(spell);
    await waitFor(
      `${spell} cast acknowledgement`,
      () => this.castAcks.has(attempt.id),
      2_000,
    );
    return this.castAcks.get(attempt.id)!;
  }

  forceInputUnhealthy(): void {
    this.game.send({
      type: "heartbeat",
      clientMs: performance.now(),
      inputGeneration: this.generation,
      healthy: false,
    });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.wand.disconnect();
    this.game.disconnect();
  }

  private isHealthy(): boolean {
    return (
      this.wand.getSnapshot().phase === "streaming" &&
      this.motion.getState().phase === "ready"
    );
  }

  private submitAttempt(attempt: CastAttempt): void {
    this.latestAttempt = attempt;
    const snapshot = this.game.snapshot;
    if (!snapshot || snapshot.phase !== "playing") return;
    this.game.send({
      type: "cast",
      roundId: snapshot.roundId,
      attemptId: attempt.id,
      spell: attempt.spell,
      gestureId: attempt.gestureId,
      speechId: attempt.utteranceId,
      inputGeneration: this.generation,
    });
  }

  private requireCalibrationExample(spell: SpellName, count: number): void {
    const state = this.motion.getState();
    if (state.examplesBySpell[spell] !== count)
      throw new Error(
        `QA ${spell} example ${count}: ${state.lastIssue}; wand ${this.wand.getSnapshot().issue}, rejected ${this.wand.getSnapshot().rejected}`,
      );
  }

  private requireGesture(spell: SpellName): GestureEvidence {
    const gesture = this.latestGesture;
    if (!gesture || gesture.spell !== spell)
      throw new Error(`Raw ${spell} trace did not produce gesture evidence`);
    return gesture;
  }

  private requireAttempt(spell: SpellName): CastAttempt {
    const attempt = this.latestAttempt;
    if (!attempt) throw new Error(`${spell} evidence did not fuse`);
    return attempt;
  }
}

export class GameQaHarness {
  private readonly first = new QaPlayer(1);
  private readonly second = new QaPlayer(2);
  private report: GameQaReport = {
    stage: "idle",
    detail: "Ready to run",
  };

  constructor(private readonly onReport: (report: GameQaReport) => void) {}

  async run(): Promise<GameQaReport> {
    try {
      this.update({ stage: "running", detail: "Connecting two QA players" });
      await this.first.connect();
      await this.second.connect();
      if (this.first.game.slot !== "P1" || this.second.game.slot !== "P2")
        throw new Error("QA players did not receive ordinary P1/P2 slots");
      this.update({ detail: "Calibrating two paced raw-motion replays" });
      await Promise.all([this.first.calibrate(), this.second.calibrate()]);

      this.update({ detail: "Starting the first round" });
      this.first.ready();
      this.second.ready();
      await waitFor(
        "first round",
        () => this.sharedSnapshot()?.phase === "playing",
        7_000,
      );
      const firstRound = this.sharedSnapshot()!.roundId;
      this.update({ detail: "Casting Stupefy through raw motion", firstRound });
      const attack = await this.first.cast("stupefy");
      if (!attack.accepted)
        throw new Error(`Stupefy was rejected: ${attack.reason ?? "unknown"}`);
      await waitFor(
        "projectile launch",
        () => this.eventSeen("projectileLaunched", firstRound),
        2_000,
      );
      const projectile = this.sharedSnapshot()!.projectiles[0];
      if (!projectile) throw new Error("Accepted Stupefy produced no projectile");

      const guardDelay = Math.max(
        0,
        projectile.impactAtMs - this.second.game.now() - 1_600,
      );
      await delay(guardDelay);
      this.update({ detail: "Casting Protego through raw motion" });
      const defense = await this.second.cast("protego");
      if (!defense.accepted)
        throw new Error(`Protego was rejected: ${defense.reason ?? "unknown"}`);
      await waitFor(
        "blocked impact",
        () => this.eventSeen("impactBlocked", firstRound),
        2_500,
      );
      const defenderHp = this.sharedSnapshot()!.players.P2?.hp;
      if (defenderHp !== 100) throw new Error("Blocked projectile changed health");
      this.update({
        detail: "Aborting on unhealthy input",
        attackAccepted: true,
        defenseAccepted: true,
        blocked: true,
        defenderHp,
      });

      this.second.forceInputUnhealthy();
      await waitFor(
        "aborted result",
        () => this.sharedSnapshot()?.result?.outcome === "aborted",
        2_000,
      );
      const abortOutcome = this.sharedSnapshot()!.result!.outcome;

      this.update({ detail: "Readying an authoritative rematch", abortOutcome });
      this.first.ready();
      this.second.ready();
      await waitFor(
        "rematch countdown",
        () => {
          const snapshot = this.sharedSnapshot();
          return (
            snapshot !== undefined &&
            snapshot.roundId > firstRound &&
            snapshot.phase === "countdown"
          );
        },
        2_000,
      );
      const rematchRound = this.sharedSnapshot()!.roundId;
      this.update({
        stage: "complete",
        detail: "Raw motion, fusion, block, abort and rematch passed",
        rematchRound,
      });
      return this.report;
    } catch (error) {
      this.update({
        stage: "failed",
        detail: error instanceof Error ? error.message : "QA flow failed",
      });
      throw error;
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.first.destroy();
    this.second.destroy();
  }

  private sharedSnapshot(): Snapshot | undefined {
    const first = this.first.game.snapshot;
    const second = this.second.game.snapshot;
    if (!first || !second || first.stateVersion !== second.stateVersion)
      return undefined;
    return first;
  }

  private eventSeen(type: string, roundId: number): boolean {
    return (
      this.sharedSnapshot()?.recentEvents.some(
        (event) => event.type === type && event.roundId === roundId,
      ) ?? false
    );
  }

  private update(next: Partial<GameQaReport>): void {
    this.report = { ...this.report, ...next };
    this.onReport({ ...this.report });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
