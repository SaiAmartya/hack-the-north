import { VirtualWandEndpoint } from "./endpoint";
import { MotionFlag, type InfoRecord, type MotionRecord } from "./protocol";
import type {
  ByteListener,
  NotificationKind,
  WandTransport,
  DisconnectListener,
} from "./transport";

export type ReplayName = "rest" | "jab" | "guard" | "sweep";

export function replayAxes(
  name: ReplayName,
  elapsed: number,
): Pick<MotionRecord, "axMg" | "ayMg" | "azMg"> {
  const rest = { axMg: 0, ayMg: 0, azMg: 1000 };
  if (elapsed < 200 || elapsed > 1000 || name === "rest") return rest;
  const t = elapsed - 200;
  const impulse =
    t < 400 ? Math.round(Math.sin((t / 400) * Math.PI * 2) * 1500) : 0;
  if (name === "jab") return { ...rest, azMg: 1000 + impulse };
  if (name === "sweep") return { ...rest, axMg: impulse };
  const angle = (Math.min(t / 300, 1) * Math.PI) / 4;
  return {
    axMg: 0,
    ayMg: Math.round(Math.sin(angle) * 1000),
    azMg: Math.round(Math.cos(angle) * 1000),
  };
}

export class VirtualWandTransport implements WandTransport {
  get source(): WandTransport["source"] { return this.channel?.source ?? "REPLAY"; }
  readonly endpoint: VirtualWandEndpoint;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private sequence = 0;
  private healthAt = 0;
  private pausedUntil = 0;
  private replay: ReplayName = "rest";
  private replayAt = 0;
  private connected = false;
  private dropAck = false;
  private duplicate = false;
  private stale = false;
  private discontinuity = false;
  readonly recover?: (onDisconnect: DisconnectListener) => Promise<void>;

  constructor(
    private readonly now = () => performance.now(),
    info?: InfoRecord,
    private readonly channel?: WandTransport,
  ) {
    if (channel?.recover) this.recover = (listener) => channel.recover!(listener);
    this.endpoint = new VirtualWandEndpoint({
      nowMs: now,
      info: info ?? {
        version: 1,
        capabilities: 15,
        sampleHz: 50,
        rangeG: 8,
        deviceId: [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6],
        bootId: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
        firmware: { major: 0, minor: 1, patch: 0 },
        axisConvention: 1,
      },
    });
  }

  async connect(_onDisconnect: DisconnectListener): Promise<void> {
    if (this.channel) return this.channel.connect(_onDisconnect);
    this.disconnect();
    this.connected = true;
    this.pausedUntil = 0;
    this.healthAt = this.now();
    this.replay = "rest";
    this.timer = setInterval(() => {
      this.endpoint.tick();
      if (this.now() - this.healthAt >= 1000) {
        this.healthAt = this.now();
        this.endpoint.notifyHealth();
      }
      const seq = this.sequence++ & 0xffff;
      if (this.now() < this.pausedUntil) {
        this.endpoint.recordDroppedSamples(1);
        this.discontinuity = true;
        return;
      }
      this.endpoint.emitMotion({
        version: 1,
        flags:
          MotionFlag.Valid |
          (this.discontinuity ? MotionFlag.Discontinuity : 0),
        seq,
        captureMs: (Math.floor(this.now()) - (this.stale ? 350 : 0)) >>> 0,
        bootId: this.endpoint.info.bootId,
        ...replayAxes(this.replay, this.now() - this.replayAt),
      });
      this.stale = false;
      this.discontinuity = false;
    }, 20);
  }

  async readInfo() {
    if (this.channel) return this.channel.readInfo();
    this.requireConnection();
    return this.endpoint.readInfo();
  }
  async readStatus() {
    if (this.channel) return this.channel.readStatus();
    this.requireConnection();
    return this.endpoint.readStatus();
  }

  async subscribe(
    kind: NotificationKind,
    listener: ByteListener,
  ): Promise<void> {
    if (this.channel) return this.channel.subscribe(kind, listener);
    this.requireConnection();
    const generation = this.generation;
    const deliver = (bytes: Uint8Array) => {
      if (kind === "status" && bytes[1] === 1 && this.dropAck) {
        this.dropAck = false;
        return;
      }
      const duplicate = kind === "motion" && this.duplicate;
      if (duplicate) this.duplicate = false;
      queueMicrotask(() => {
        if (generation !== this.generation) return;
        listener(bytes.slice());
        if (duplicate) listener(bytes.slice());
      });
    };
    if (kind === "motion") this.endpoint.subscribeMotion(deliver);
    else this.endpoint.subscribeStatus(deliver);
  }

  async writeControl(bytes: Uint8Array): Promise<void> {
    if (this.channel) return this.channel.writeControl(bytes);
    this.requireConnection();
    this.endpoint.writeControl(bytes);
  }

  disconnect(): void {
    if (this.channel) { this.channel.disconnect(); return; }
    this.generation++;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.connected = false;
    this.endpoint.disconnect();
    this.duplicate = this.stale = this.dropAck = this.discontinuity = false;
  }

  play(name: ReplayName): void {
    this.replay = name;
    this.replayAt = this.now();
  }
  injectOutage(): void {
    this.pausedUntil = this.now() + 600;
  }
  injectDuplicate(): void {
    this.duplicate = true;
  }
  injectStale(): void {
    this.stale = true;
  }
  injectLostAck(): void {
    this.dropAck = true;
  }

  private requireConnection(): void {
    if (!this.connected) throw new Error("Virtual wand disconnected");
  }
}
