import { MotionFlag, type MotionRecord } from "../wand/protocol";

const GRAVITY = 9.80665;
/** Observation clock stays on the phone, just like its SYNC clock. */
export class PhoneSampler {
  private observation?: {
    serial: number;
    at: number;
    x: number;
    y: number;
    z: number;
  };
  private serial = 0;
  private used = 0;
  private sequence = 0;
  private lastCapture?: number;
  intentionalDecimation = 0;
  observations = 0;
  selected = 0;
  observe(x: number | null, y: number | null, z: number | null, at: number) {
    if (
      ![x, y, z, at].every((n) => typeof n === "number" && Number.isFinite(n))
    )
      return;
    if (this.observation && this.observation.serial !== this.used)
      this.intentionalDecimation++;
    this.observation = { serial: ++this.serial, at, x: x!, y: y!, z: z! };
    this.observations++;
  }
  select(now: number, bootId: number): MotionRecord | undefined {
    const value = this.observation;
    if (
      !value ||
      value.serial === this.used ||
      now - value.at > 200 ||
      now < value.at
    )
      return;
    this.used = value.serial;
    const axes = [value.x, value.y, value.z].map((n) =>
      Math.round((n * 1000) / GRAVITY),
    );
    const saturated = axes.some((n) => Math.abs(n) >= 8000);
    const broken =
      this.lastCapture === undefined || value.at - this.lastCapture > 150;
    this.lastCapture = value.at;
    this.selected++;
    return {
      version: 1,
      flags:
        MotionFlag.Valid |
        (saturated ? MotionFlag.Saturated : 0) |
        (broken ? MotionFlag.Discontinuity : 0),
      seq: this.sequence++ & 0xffff,
      captureMs: Math.floor(value.at) >>> 0,
      bootId,
      axMg: Math.max(-8000, Math.min(8000, axes[0])),
      ayMg: Math.max(-8000, Math.min(8000, axes[1])),
      azMg: Math.max(-8000, Math.min(8000, axes[2])),
    };
  }
}
