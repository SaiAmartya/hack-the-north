export type TelemetryEntry = {
  id: number;
  atMs: number;
  kind: string;
  data: unknown;
};

const CAPACITY = 30_000;

/** Opt-in local ring: retain every received sample without rendering thousands of rows. */
export class DuelTelemetry {
  enabled = false;
  private entries: TelemetryEntry[] = [];
  private nextId = 0;
  private cursor = 0;
  private evicted = 0;

  record(kind: string, data: unknown, atMs = performance.now()): void {
    if (!this.enabled) return;
    const entry = { id: ++this.nextId, atMs, kind, data };
    if (this.entries.length < CAPACITY) this.entries.push(entry);
    else {
      this.entries[this.cursor] = entry;
      this.cursor = (this.cursor + 1) % CAPACITY;
      this.evicted++;
    }
  }

  snapshot(limit = 80): { entries: readonly TelemetryEntry[]; total: number; dropped: number } {
    const count = Math.min(this.entries.length, Math.max(0, Math.floor(limit)));
    const start = this.entries.length === CAPACITY ? this.cursor : 0;
    return {
      entries: Array.from({ length: count }, (_, index) =>
        this.entries[(start + this.entries.length - count + index) % this.entries.length]),
      total: this.entries.length,
      dropped: this.evicted,
    };
  }

  clear(): void {
    this.entries = [];
    this.cursor = this.evicted = 0;
  }

  export(metadata: Record<string, unknown>): string {
    return JSON.stringify({
      format: "wandduel-telemetry-v1",
      capturedAt: new Date().toISOString(),
      clock: {
        entries: "atMs is browser performance.now() in milliseconds (receive time for game.event)",
        device: "captureMs is a separate device clock",
        referee: "game.event data.atMs is referee monotonic time; estimatedBrowserAtMs subtracts that entry's serverMinusBrowserMs estimate; roundTripMs is null until ping synchronization",
      },
      ...metadata,
      ...this.snapshot(CAPACITY),
    }, null, 2);
  }
}
