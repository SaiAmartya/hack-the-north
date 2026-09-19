// Web Bluetooth client for the wand GATT service (BADGE-FIRMWARE-CONTRACT.md sections 3, 5, 6).
//
// One connection = one session: fresh nonce, OPEN, five SYNC exchanges, then motion. Commands go
// one at a time; every write consumes a sequence number even if it fails, so a lost ACK cannot
// desynchronise the link. Callbacks are scoped to a connection generation so a late notification
// from an old connection is ignored.
import {
  CONTROL_UUID,
  cueArgs,
  decodeInfo,
  decodeMotion,
  decodeStatus,
  encodeControl,
  HEALTH,
  INFO_UUID,
  MOTION_UUID,
  OP,
  RC,
  RC_NAMES,
  seqAdvances,
  SERVICE_UUID,
  setStateArgs,
  STATUS_UUID,
  type Info,
  type Motion,
  type Status,
} from "./wandProtocol";

// Minimal Web Bluetooth typings (no extra @types package).
type GattCharacteristic = {
  readValue(): Promise<DataView>;
  writeValueWithResponse(data: BufferSource): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
  stopNotifications(): Promise<GattCharacteristic>;
  addEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
  value: DataView | null;
};
type GattService = { getCharacteristic(uuid: string): Promise<GattCharacteristic> };
type GattServer = { connected: boolean; connect(): Promise<GattServer>; disconnect(): void; getPrimaryService(uuid: string): Promise<GattService> };
type BluetoothDeviceLike = {
  name?: string;
  gatt?: GattServer;
  addEventListener(type: "gattserverdisconnected", listener: () => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: () => void): void;
};
type BluetoothLike = { requestDevice(options: { filters: { services: string[] }[]; optionalServices: string[] }): Promise<BluetoothDeviceLike> };

export type LinkState = {
  supported: boolean;
  connected: boolean;
  name?: string;
  info?: Info;
  opened: boolean;
  nonce: number;
  epoch: number;
  health?: Status;
  lastResult?: Status;
  lastResultText?: string;
  offsetMs?: number;        // browser - device, from the best SYNC
  uncertaintyMs?: number;   // half the best round trip
  syncRttMs?: number;
  syncAt?: number;          // performance.now() of the last good sync
  generation: number;
  motionCount: number;
  motionLost: number;
  motionRateHz: number;
  error?: string;
};

export type MotionEvent = {
  motion: Motion;
  receivedAt: number;       // performance.now()
  captureAt: number | null; // capture mapped into performance.now() terms, null before sync
  ageMs: number | null;     // estimated sample age at receipt
  lost: number;             // sequence gap before this sample
};

export interface WandTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  open(): Promise<boolean>;
  sync(rounds?: number): Promise<boolean>;
  setState(phase: number, hp: number, status?: number): Promise<Status | null>;
  cue(effect: number, spell: number, durationMs: number): Promise<Status | null>;
  newEpoch(): void;
  state(): LinkState;
}

type Listener = { onMotion: (e: MotionEvent) => void; onState: (s: LinkState) => void };

const COMMAND_TIMEOUT_MS = 1000;
const STATE_LEASE_MS = 1200;
const CUE_LEAD_MS = 300;
const RATE_WINDOW = 50;

export function healthText(bits: number): string {
  const parts = [];
  parts.push(bits & HEALTH.SENSOR ? "sensor ok" : "SENSOR FAULT");
  parts.push(bits & HEALTH.STREAM ? "streaming" : "stream off");
  parts.push(bits & HEALTH.PRESENTATION ? "screen ok" : "SCREEN FAULT");
  if (bits & HEALTH.STATE_STALE) parts.push("state stale");
  return parts.join(", ");
}

function randomNonzero(): number {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a);
  while (a[0] === 0);
  return a[0];
}

export class WandLink implements WandTransport {
  private device: BluetoothDeviceLike | null = null;
  private control: GattCharacteristic | null = null;
  private motion: GattCharacteristic | null = null;
  private statusChar: GattCharacteristic | null = null;
  private st: LinkState = { supported: WandLink.supported(), connected: false, opened: false, nonce: 0, epoch: 0, generation: 0, motionCount: 0, motionLost: 0, motionRateHz: 0 };
  private seq = 0;
  private pending: { seq: number; resolve: (s: Status | null) => void; timer: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSeq = -1;
  private arrivals: number[] = [];
  private onDisconnected = () => this.handleDisconnect();

  constructor(private readonly listener: Listener) {}

  static supported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  state(): LinkState {
    return this.st;
  }

  private emit(patch: Partial<LinkState>): void {
    this.st = { ...this.st, ...patch };
    this.listener.onState(this.st);
  }

  /** Estimated device clock right now (ms), valid after sync. */
  deviceNow(): number | null {
    return this.st.offsetMs === undefined ? null : (performance.now() - this.st.offsetMs) >>> 0;
  }

  async connect(): Promise<void> {
    if (!WandLink.supported()) {
      this.emit({ error: "Web Bluetooth needs desktop Chrome or Edge" });
      return;
    }
    try {
      const bt = (navigator as unknown as { bluetooth: BluetoothLike }).bluetooth;
      const device = await bt.requestDevice({ filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] });
      const server = await device.gatt!.connect();
      const generation = this.st.generation + 1;
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      const service = await server.getPrimaryService(SERVICE_UUID);
      const infoChar = await service.getCharacteristic(INFO_UUID);
      const info = decodeInfo(new Uint8Array((await infoChar.readValue()).buffer));
      if (!info) throw new Error("INFO record is not protocol v1");
      if (info.caps !== 0x0f) throw new Error(`wand capabilities 0x${info.caps.toString(16)}: completed MVP needs 0x0f`);
      if (info.sampleHz !== 50 || info.rangeG !== 8 || info.axisConvention !== 1) throw new Error(`unexpected stream profile ${info.sampleHz} Hz +/-${info.rangeG} g axes ${info.axisConvention}`);
      this.statusChar = await service.getCharacteristic(STATUS_UUID);
      this.motion = await service.getCharacteristic(MOTION_UUID);
      this.control = await service.getCharacteristic(CONTROL_UUID);
      // Subscribe STATUS first, then MOTION (contract section 6).
      const gen = generation;
      this.statusChar.addEventListener("characteristicvaluechanged", (ev) => {
        if (this.st.generation !== gen) return;
        const dv = (ev.target as unknown as GattCharacteristic).value;
        if (dv) this.handleStatus(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)));
      });
      await this.statusChar.startNotifications();
      this.motion.addEventListener("characteristicvaluechanged", (ev) => {
        if (this.st.generation !== gen) return;
        const dv = (ev.target as unknown as GattCharacteristic).value;
        if (dv) this.handleMotion(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)), performance.now());
      });
      await this.motion.startNotifications();
      this.seq = 0;
      this.lastSeq = -1;
      this.arrivals = [];
      this.emit({ connected: true, name: device.name, info, opened: false, nonce: 0, epoch: 0, generation, motionCount: 0, motionLost: 0, motionRateHz: 0, offsetMs: undefined, uncertaintyMs: undefined, error: undefined });
    } catch (e) {
      this.emit({ error: e instanceof Error ? e.message : String(e) });
      await this.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    if (device) {
      device.removeEventListener("gattserverdisconnected", this.onDisconnected);
      try {
        device.gatt?.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.handleDisconnect();
  }

  private handleDisconnect(): void {
    if (this.pending) {
      window.clearTimeout(this.pending.timer);
      this.pending.resolve(null);
      this.pending = null;
    }
    this.control = this.motion = this.statusChar = null;
    if (this.st.connected) this.emit({ connected: false, opened: false, generation: this.st.generation + 1, offsetMs: undefined, uncertaintyMs: undefined });
  }

  private handleStatus(buf: Uint8Array): void {
    const s = decodeStatus(buf);
    if (!s) return;
    if (s.kind === 0) {
      this.emit({ health: s });
      return;
    }
    const p = this.pending;
    if (p && s.seq === p.seq && (s.nonce === this.st.nonce || (s.detail0 === OP.OPEN && s.detail1 !== RC.OK))) {
      window.clearTimeout(p.timer);
      this.pending = null;
      p.resolve(s);
    }
  }

  private handleMotion(buf: Uint8Array, receivedAt: number): void {
    const m = decodeMotion(buf);
    if (!m || !this.st.info || m.bootId !== this.st.info.bootId) return;
    let lost = 0;
    if (this.lastSeq >= 0) {
      if (!seqAdvances(m.seq, this.lastSeq)) return; // duplicate or late
      lost = (m.seq - this.lastSeq + 65536) % 65536 - 1;
    }
    this.lastSeq = m.seq;
    this.arrivals.push(receivedAt);
    if (this.arrivals.length > RATE_WINDOW) this.arrivals.shift();
    const span = this.arrivals.length > 1 ? this.arrivals[this.arrivals.length - 1] - this.arrivals[0] : 0;
    this.st.motionCount++;
    this.st.motionLost += lost;
    this.st.motionRateHz = span > 0 ? ((this.arrivals.length - 1) * 1000) / span : 0;
    const captureAt = this.st.offsetMs === undefined ? null : m.captureMs + this.st.offsetMs;
    const ageMs = captureAt === null ? null : receivedAt - captureAt;
    this.listener.onMotion({ motion: m, receivedAt, captureAt, ageMs, lost });
  }

  /** Serialised command: build, write with response, await the matching STATUS result. */
  private command(opcode: number, arg0 = 0, arg1 = 0, arg2 = 0): Promise<Status | null> {
    const run = async (): Promise<Status | null> => {
      if (!this.control || !this.st.connected) return null;
      const seq = this.seq;
      this.seq = (this.seq + 1) & 0xffff; // consumed even if the write fails
      const raw = encodeControl({ opcode, seq, nonce: this.st.nonce, arg0, arg1, arg2 });
      const result = new Promise<Status | null>((resolve) => {
        const timer = window.setTimeout(() => {
          if (this.pending && this.pending.seq === seq) {
            this.pending = null;
            resolve(null);
          }
        }, COMMAND_TIMEOUT_MS);
        this.pending = { seq, resolve, timer };
      });
      try {
        await this.control.writeValueWithResponse(raw);
      } catch (e) {
        if (this.pending && this.pending.seq === seq) {
          window.clearTimeout(this.pending.timer);
          this.pending = null;
        }
        this.emit({ error: e instanceof Error ? e.message : String(e) });
        return null;
      }
      const s = await result;
      this.emit({ lastResult: s ?? undefined, lastResultText: s ? `${["", "OPEN", "SYNC", "SET_STATE", "CUE"][s.detail0] ?? s.detail0} -> ${RC_NAMES[s.detail1] ?? s.detail1}` : `${opcode}: no ACK within 1 s` });
      return s;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async open(): Promise<boolean> {
    this.seq = 0;
    this.st.nonce = randomNonzero();
    this.st.epoch = randomNonzero();
    const r = await this.command(OP.OPEN);
    const ok = !!r && r.detail1 === RC.OK;
    this.emit({ opened: ok, nonce: this.st.nonce, epoch: this.st.epoch });
    return ok;
  }

  async sync(rounds = 5): Promise<boolean> {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now();
      const r = await this.command(OP.SYNC);
      const t1 = performance.now();
      if (!r || r.detail1 !== RC.OK) continue;
      const rtt = t1 - t0;
      // offset (browser - device) lies within [t0 - d, t1 - d]; take the midpoint
      const offset = (t0 + t1) / 2 - r.deviceMs;
      if (!best || rtt < best.rtt) best = { rtt, offset };
    }
    if (!best) return false;
    this.emit({ offsetMs: best.offset, uncertaintyMs: best.rtt / 2, syncRttMs: best.rtt, syncAt: performance.now() });
    return true;
  }

  newEpoch(): void {
    this.emit({ epoch: randomNonzero() });
  }

  async setState(phase: number, hp: number, status = 0): Promise<Status | null> {
    const now = this.deviceNow();
    if (now === null) return null;
    return this.command(OP.SET_STATE, setStateArgs(phase, hp, status), this.st.epoch, (now + STATE_LEASE_MS) >>> 0);
  }

  async cue(effect: number, spell: number, durationMs: number): Promise<Status | null> {
    const now = this.deviceNow();
    if (now === null) return null;
    return this.command(OP.CUE, cueArgs(effect, spell, durationMs), this.st.epoch, (now + CUE_LEAD_MS) >>> 0);
  }
}
