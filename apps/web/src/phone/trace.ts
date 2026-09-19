import { isPhoneCalibrationDiagnostics, type PhoneCalibrationDiagnostics } from "../../../../shared/phone-v2";
export type PhoneTraceEntry = { at: number; event: string; generation: number; count?: number; ageMs?: number; x?: number; y?: number; z?: number; seq?: number; captureMs?: number; flags?: number; reason?: string; calibration?: PhoneCalibrationDiagnostics };
/** An allowlisted, bounded trace: never serializes envelopes or network/session IDs. */
export class PhoneTrace {
  private entries: PhoneTraceEntry[] = [];
  private calibration?: { generation: number; value: PhoneCalibrationDiagnostics };
  constructor(private now = () => performance.now()) {}
  add(entry: Omit<PhoneTraceEntry, "at">) {
    const at = this.now();
    const calibration = isPhoneCalibrationDiagnostics(entry.calibration) ? structuredClone(entry.calibration) : undefined;
    if (calibration) this.calibration = { generation: entry.generation, value: calibration };
    this.entries.push({ at, event: entry.event, generation: entry.generation, count: entry.count, ageMs: entry.ageMs, x: entry.x, y: entry.y, z: entry.z, seq: entry.seq, captureMs: entry.captureMs, flags: entry.flags, reason: entry.reason, calibration });
    while (this.entries.length > 10000 || (this.entries[0] && this.entries[0].at < at - 60_000)) this.entries.shift();
  }
  export() { return JSON.stringify({ version: 2, source: "phone", calibration: this.calibration, clocks: { at: "phone-monotonic-ms", captureMs: "phone-monotonic-ms-uint32", candidate: "laptop-monotonic-ms" }, units: { observation: "m/s2", selected: "mg", calibration: "mg" }, entries: this.entries.filter(x => x.at >= this.now() - 60_000) }); }
}
