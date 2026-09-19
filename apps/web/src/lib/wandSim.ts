// DEVELOPMENT-ONLY virtual wand. Implements the same transport interface as the real GATT link
// and emits the same MOTION records at 50 Hz, with synthetic jab / guard / sweep movements, so
// the browser pipeline can be exercised without hardware. It is visibly labelled in the UI and
// must never stand in for a real wand in a duel.
import { EFFECT, MOTION_FLAG, OP, PHASE, RC, SPELL, encodeMotion, decodeMotion, type Motion, type Status } from "./wandProtocol";
import type { LinkState, MotionEvent, WandTransport } from "./wandBle";

const RATE_HZ = 50;
const G = 1000;
export const SIM_BOOT_ID = 0x51d0c0de;

export type SimGesture = "jab" | "guard" | "sweep";
type Phase = { kind: SimGesture | "idle"; t: number; total: number };

type Listener = { onMotion: (e: MotionEvent) => void; onState: (s: LinkState) => void };

export class VirtualWand implements WandTransport {
  private seq = 0;
  private ms = 0;
  private timer: number | undefined;
  private phase: Phase = { kind: "idle", t: 0, total: 0 };
  private tilt = 0; // 0 = grip at rest, 1 = raised guard pose
  private holdUntil = 0;
  private noise = 12;
  private cmdSeq = 0;
  private st: LinkState = { supported: true, connected: false, opened: false, nonce: 0, epoch: 0, generation: 0, motionCount: 0, motionLost: 0, motionRateHz: 0 };
  private lastPhase: number = PHASE.IDLE;

  constructor(private readonly listener?: Listener) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  private emit(patch: Partial<LinkState>): void {
    this.st = { ...this.st, ...patch };
    this.listener?.onState(this.st);
  }

  state(): LinkState {
    return this.st;
  }

  async connect(): Promise<void> {
    this.emit({
      connected: true,
      name: "WAND-SIM0 (virtual)",
      info: { caps: 0x0f, sampleHz: 50, rangeG: 8, deviceId: new Uint8Array([2, 0, 0, 0, 0x51, 0x4d]), bootId: SIM_BOOT_ID, fw: [0, 1, 0], axisConvention: 1 },
      generation: this.st.generation + 1,
      motionCount: 0,
      motionLost: 0,
      error: undefined,
    });
    if (this.timer === undefined) this.timer = window.setInterval(() => this.tick(), 1000 / RATE_HZ);
  }

  async disconnect(): Promise<void> {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.emit({ connected: false, opened: false, generation: this.st.generation + 1 });
  }

  private result(opcode: number, code: number): Status {
    const s: Status = { kind: 1, seq: this.cmdSeq++, nonce: this.st.nonce, deviceMs: Math.round(this.ms), detail0: opcode, detail1: code };
    this.emit({ lastResult: s, lastResultText: `${["", "OPEN", "SYNC", "SET_STATE", "CUE"][opcode]} -> ${code === RC.OK ? "ok" : "rejected"} (virtual)` });
    return s;
  }

  async open(): Promise<boolean> {
    this.emit({ opened: true, nonce: 0x51d0c0de, epoch: 0x0badf00d, health: { kind: 0, seq: 0, nonce: 0x51d0c0de, deviceMs: Math.round(this.ms), detail0: 0, detail1: 0x0f } });
    this.result(OP.OPEN, RC.OK);
    return true;
  }

  async sync(): Promise<boolean> {
    this.emit({ offsetMs: performance.now() - this.ms, uncertaintyMs: 1, syncRttMs: 2, syncAt: performance.now() });
    this.result(OP.SYNC, RC.OK);
    return true;
  }

  newEpoch(): void {
    this.emit({ epoch: (this.st.epoch + 1) >>> 0 });
  }

  async setState(phase: number, hp: number, status = 0): Promise<Status | null> {
    void hp;
    void status;
    this.lastPhase = phase;
    return this.result(OP.SET_STATE, RC.OK);
  }

  async cue(effect: number, spell: number, durationMs: number): Promise<Status | null> {
    void durationMs;
    const bad = (effect === EFFECT.ACCEPTED_CAST && spell === SPELL.NONE) || (effect === EFFECT.RESULT && (spell !== SPELL.NONE || this.lastPhase < PHASE.WON || this.lastPhase > PHASE.DRAW));
    return this.result(OP.CUE, bad ? RC.INVALID_ARG : RC.OK);
  }

  /** Queue one synthetic movement; it plays out over the next ~0.5 s. */
  perform(kind: SimGesture): void {
    if (this.phase.kind !== "idle") return;
    this.phase = { kind, t: 0, total: kind === "guard" ? 26 : kind === "sweep" ? 24 : 18 };
  }

  private gravity(): [number, number, number] {
    // Resting grip: gravity on +Z (screen facing up). Raised guard: gravity swings toward +Y.
    const a = this.tilt * (Math.PI / 3);
    return [0, Math.sin(a) * G, Math.cos(a) * G];
  }

  /** One sample as {x, y, z, ms}; public so tests can drive the model deterministically. */
  next(): { x: number; y: number; z: number; ms: number; moving: boolean } {
    this.ms += 1000 / RATE_HZ;
    let dyn: [number, number, number] = [0, 0, 0];
    const p = this.phase;
    if (p.kind !== "idle") {
      const u = p.t / p.total;
      const bump = Math.sin(Math.PI * u);
      if (p.kind === "jab") dyn = [bump * 1500 * (u < 0.5 ? 1 : -0.9), 0, 0];
      else if (p.kind === "sweep") dyn = [bump * 300, bump * 1300 * (u < 0.5 ? 1 : -0.8), 0];
      else {
        dyn = [0, bump * 700, bump * 500];
        this.tilt = u * u * (3 - 2 * u);
      }
      p.t++;
      if (p.t >= p.total) {
        this.phase = { kind: "idle", t: 0, total: 0 };
        if (p.kind === "guard") this.holdUntil = this.ms + 1500;
      }
    } else if (this.tilt > 0 && this.ms > this.holdUntil) {
      this.tilt = Math.max(0, this.tilt - 0.02);
    }
    const g = this.gravity();
    const n = () => (Math.random() - 0.5) * 2 * this.noise;
    return { x: Math.round(g[0] + dyn[0] + n()), y: Math.round(g[1] + dyn[1] + n()), z: Math.round(g[2] + dyn[2] + n()), ms: Math.round(this.ms), moving: p.kind !== "idle" };
  }

  /** The same sample as a contract MOTION record. */
  nextMotion(): Motion {
    const s = this.next();
    return { flags: MOTION_FLAG.VALID, seq: this.seq++ & 0xffff, captureMs: s.ms >>> 0, bootId: SIM_BOOT_ID, ax: s.x, ay: s.y, az: s.z };
  }

  private tick(): void {
    // round-trip through the codec so the virtual wand exercises the same decoder as a real one
    const m = decodeMotion(encodeMotion(this.nextMotion()));
    if (!m || !this.st.opened) return;
    const receivedAt = performance.now();
    this.st.motionCount++;
    this.st.motionRateHz = RATE_HZ;
    const captureAt = this.st.offsetMs === undefined ? null : m.captureMs + this.st.offsetMs;
    this.listener?.onMotion({ motion: m, receivedAt, captureAt, ageMs: captureAt === null ? null : receivedAt - captureAt, lost: 0 });
  }
}
