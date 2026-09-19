import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WandClient } from "./client";
import { VirtualWandTransport } from "./virtual";
import type { DisconnectListener, WandTransport } from "./transport";
import {
  CueEffect,
  PresentationPhase,
  SpellCode,
  HealthFlag,
  decodeStatus,
  encodeStatus,
  StatusKind,
  ControlOpcode,
  decodeControl,
  MotionFlag,
  decodeMotion,
  encodeMotion,
} from "./protocol";

describe("shared wand lifecycle", () => {
  const clients: WandClient[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
  });
  afterEach(() => {
    clients.splice(0).forEach((client) => client.disconnect());
    vi.useRealTimers();
  });
  async function setup() {
    const transport = new VirtualWandTransport(() => Date.now());
    const client = new WandClient(transport, () => Date.now());
    clients.push(client);
    await client.connect();
    return { client, transport };
  }
  it("handshakes through STATUS and accepts fresh raw samples", async () => {
    const { client } = await setup();
    expect(client.getSnapshot().phase).toBe("streaming");
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getSnapshot().accepted).toBe(5);
    expect(client.getSnapshot().lastSample?.azMg).toBe(1000);
    expect(client.getSnapshot().observedHz).toBe(50);
    expect(client.getSnapshot().maxGapMs).toBe(20);
    expect(client.getSamples()[0].breaksGesture).toBe(true);
  });
  it("retains an approved recoverable carrier but rebuilds protocol and waits for fresh input", async () => {
    const endpoint = new VirtualWandTransport(() => Date.now());
    let lost: DisconnectListener = () => {};
    const transport: WandTransport = {
      source: "PHONE",
      connect: async cb => { lost = cb; await endpoint.connect(cb); },
      recover: vi.fn(async cb => { lost = cb; await endpoint.connect(cb); }),
      readInfo: () => endpoint.readInfo(), readStatus: () => endpoint.readStatus(),
      subscribe: (kind, cb) => endpoint.subscribe(kind, cb),
      writeControl: data => endpoint.writeControl(data),
      disconnect: vi.fn(() => endpoint.disconnect()),
    };
    const client = new WandClient(transport, () => Date.now()); clients.push(client);
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(1100); await connecting;
    expect(client.getSnapshot().phase).toBe("streaming");
    const generation = client.getSnapshot().generation;
    const closes = vi.mocked(transport.disconnect).mock.calls.length;
    const listener = vi.fn(); client.onSample(listener);
    lost({ code: "congestion", message: "Network is delayed", recoverable: true });
    expect(client.getSnapshot()).toMatchObject({ phase: "recovering", failureCode: "congestion", issue: "Network is delayed" });
    expect(client.getSnapshot().generation).toBeGreaterThan(generation);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getSnapshot().phase).toBe("validating");
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(transport.recover).toHaveBeenCalledOnce();
    expect(transport.disconnect).toHaveBeenCalledTimes(closes);
    expect(listener.mock.calls[0][0].breaksGesture).toBe(true);
  });
  it("keeps the specific failure when a generic socket close follows and allows explicit retry", async () => {
    const endpoint = new VirtualWandTransport(() => Date.now());
    let lost: DisconnectListener = () => {};
    const transport: WandTransport = {
      source: "PHONE", connect: async cb => { lost = cb; await endpoint.connect(cb); },
      recover: vi.fn(async () => { throw new Error("Recovery window expired"); }),
      readInfo: () => endpoint.readInfo(), readStatus: () => endpoint.readStatus(),
      subscribe: (kind, cb) => endpoint.subscribe(kind, cb), writeControl: data => endpoint.writeControl(data),
      disconnect: () => endpoint.disconnect(),
    };
    const client = new WandClient(transport, () => Date.now()); clients.push(client);
    const connecting = client.connect(); await vi.advanceTimersByTimeAsync(1100); await connecting;
    lost({ code: "orientation", message: "Return to portrait and tap Resume", recoverable: false });
    lost();
    expect(client.getSnapshot()).toMatchObject({ phase: "fault", failureCode: "orientation", issue: "Return to portrait and tap Resume", canRetry: true });
    await client.retryRecovery();
    expect(client.getSnapshot()).toMatchObject({ phase: "fault", issue: "Recovery window expired" });
  });
  it("refreshes clocks while validating and reports interrupted input instead of clock expiry", async () => {
    const endpoint = new VirtualWandTransport(() => Date.now());
    const writes = vi.fn((data: Uint8Array) => endpoint.writeControl(data));
    const transport: WandTransport = {
      source: "PHONE", connect: cb => endpoint.connect(cb), recover: cb => endpoint.connect(cb),
      readInfo: () => endpoint.readInfo(), readStatus: () => endpoint.readStatus(),
      subscribe: (kind, cb) => endpoint.subscribe(kind, kind === "motion" ? bytes => {
        const record = decodeMotion(bytes);
        cb(encodeMotion({ ...record, flags: record.flags | (record.seq % 20 === 0 ? MotionFlag.Discontinuity : 0) }));
      } : cb),
      writeControl: writes, disconnect: () => endpoint.disconnect(),
    };
    const client = new WandClient(transport, () => Date.now()); clients.push(client);
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(6000);
    expect(client.getSnapshot().phase).toBe("validating");
    expect(writes.mock.calls.filter(([data]) => decodeControl(data).opcode === ControlOpcode.Sync)).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(4100); await connecting;
    expect(client.getSnapshot()).toMatchObject({ phase: "fault", failureCode: "unstable_input", canRetry: true });
    expect(client.getSnapshot().issue).not.toContain("Clock");
  });
  it("starts the clock lease after human pairing, not while waiting for approval", async () => {
    const transport = new VirtualWandTransport(() => Date.now());
    const connect = transport.connect.bind(transport);
    vi.spyOn(transport, "connect").mockImplementation(async (onDisconnect) => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await connect(onDisconnect);
    });
    const client = new WandClient(transport, () => Date.now());
    clients.push(client);
    const pending = client.connect();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(client.getSnapshot().phase).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1100);
    await pending;
    expect(client.getSnapshot()).toMatchObject({
      phase: "streaming",
      accepted: 5,
    });
  });
  it("bounds integer device timestamp quantization against fractional browser time", async () => {
    let fractionalMs = 0.8;
    const now = () => Date.now() + fractionalMs;
    const transport = new VirtualWandTransport(now);
    const client = new WandClient(transport, now);
    clients.push(client);
    await client.connect();
    fractionalMs = 0.1;
    await vi.advanceTimersByTimeAsync(20);
    expect(client.getSnapshot()).toMatchObject({
      phase: "streaming",
      accepted: 1,
      rejected: 0,
    });
    expect(client.getSnapshot().lastSample!.ageUpperMs).toBeLessThan(2);
  });
  it("refuses a setup health record without an enabled stream", async () => {
    const transport = new VirtualWandTransport(() => Date.now());
    const read = transport.readStatus.bind(transport);
    vi.spyOn(transport, "readStatus").mockImplementation(async () => {
      const status = decodeStatus(await read());
      if (status.kind !== StatusKind.Health) throw new Error("Expected health");
      return encodeStatus({
        ...status,
        healthFlags: status.healthFlags & ~HealthFlag.StreamEnabled,
      });
    });
    const client = new WandClient(transport, () => Date.now());
    clients.push(client);
    await client.connect();
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Device stream disabled",
    });
    expect(client.getSamples()).toHaveLength(0);
  });
  it("invalidates immediately on a reported stream loss, not presentation failure", async () => {
    const transport = new VirtualWandTransport(() => Date.now());
    let unsubscribeMotion = () => {};
    const subscribe = transport.endpoint.subscribeMotion.bind(
      transport.endpoint,
    );
    vi.spyOn(transport.endpoint, "subscribeMotion").mockImplementation(
      (listener) => {
        unsubscribeMotion = subscribe(listener);
        return unsubscribeMotion;
      },
    );
    const client = new WandClient(transport, () => Date.now());
    clients.push(client);
    await client.connect();
    await vi.advanceTimersByTimeAsync(100);
    transport.endpoint.setPresentationHealthy(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(client.getSnapshot().feedbackWarning).toBe(
      "Device presentation unhealthy",
    );
    unsubscribeMotion();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Device stream disabled",
    });
    expect(client.getSamples()).toHaveLength(0);
  });
  it("ignores duplicates and requires new handshake on backward captures", async () => {
    const { client, transport } = await setup();
    await vi.advanceTimersByTimeAsync(40);
    transport.injectDuplicate();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.getSnapshot()).toMatchObject({ accepted: 3, rejected: 1 });
    transport.injectStale();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.getSnapshot().phase).toBe("fault");
    expect(client.getSamples()).toHaveLength(0);
  });
  it("outage clears evidence and cannot recover from queued samples", async () => {
    const { client, transport } = await setup();
    await vi.advanceTimersByTimeAsync(100);
    const before = client.getSnapshot().generation;
    transport.injectOutage();
    await vi.advanceTimersByTimeAsync(600);
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      lastSample: undefined,
    });
    await client.connect();
    await vi.advanceTimersByTimeAsync(40);
    expect(client.getSnapshot().generation).toBeGreaterThan(before);
    expect(client.getSnapshot()).toMatchObject({
      phase: "streaming",
      accepted: 2,
    });
  });
  it("clears evidence after a browser stall, drops buffered samples and keeps the link", async () => {
    const { client, transport } = await setup();
    await vi.advanceTimersByTimeAsync(100);
    const delivered = vi.fn();
    client.onSample(delivered);
    const previous = client.getSnapshot().lastSample!;
    expect(client.getSamples().length).toBeGreaterThan(1);
    vi.setSystemTime(Date.now() + 250);
    // A sample captured before the stall was buffered by the OS: too old to be fresh.
    transport.endpoint.emitMotion({ ...previous, flags: MotionFlag.Valid, seq: previous.seq + 1, captureMs: Date.now() - 240 });
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(client.getSamples()).toHaveLength(0);
    // A genuinely fresh sample resumes the stream but starts a new gesture baseline.
    transport.endpoint.emitMotion({ ...previous, flags: MotionFlag.Valid, seq: previous.seq + 2, captureMs: Date.now() });
    await Promise.resolve();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0][0].breaksGesture).toBe(true);
    expect(client.getSnapshot().phase).toBe("streaming");
  });

  it("treats a page pause over two seconds as an interruption", async () => {
    const { client, transport } = await setup();
    await vi.advanceTimersByTimeAsync(100);
    const previous = client.getSnapshot().lastSample!;
    vi.setSystemTime(Date.now() + 2500);
    transport.endpoint.emitMotion({ ...previous, flags: MotionFlag.Valid, seq: previous.seq + 1, captureMs: Date.now() });
    await Promise.resolve();
    expect(client.getSnapshot()).toMatchObject({ phase: "fault", failureCode: "browser_paused" });
  });
  it("refreshes state, sends one cue, and lets stopped feedback expire", async () => {
    const { client, transport } = await setup();
    client.setState({
      phase: PresentationPhase.Practice,
      hp: 100,
      maxHp: 100,
      statusFlags: 0,
      presentationEpoch: 9,
    });
    client.cue({
      effect: CueEffect.AcceptedCast,
      spell: SpellCode.Stupefy,
      durationMs: 300,
      presentationEpoch: 9,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.endpoint.getPresentation().cueRevision).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.endpoint.getPresentation().state?.presentationEpoch).toBe(
      9,
    );
    expect(transport.endpoint.getPresentation().cueRevision).toBe(1);
    client.stopFeedback();
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.endpoint.getPresentation().state).toBeNull();
    expect(client.getSnapshot().phase).toBe("streaming");
  });
  it("keeps motion alive when only a presentation ACK is lost", async () => {
    const { client, transport } = await setup();
    transport.injectLostAck();
    client.setState({
      phase: PresentationPhase.Practice,
      hp: 100,
      maxHp: 100,
      statusFlags: 0,
      presentationEpoch: 1,
    });
    await vi.advanceTimersByTimeAsync(1050);
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(client.getSnapshot().accepted).toBeGreaterThan(40);
  });
  it("resynchronizes across device clock wrap without accepting old callbacks", async () => {
    vi.setSystemTime(0xfffffff0);
    const { client } = await setup();
    await vi.advanceTimersByTimeAsync(5500);
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(client.getSnapshot().accepted).toBe(275);
    client.suspend();
    expect(client.getSnapshot().phase).toBe("fault");
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getSnapshot().phase).toBe("fault");
  });
  it.each([
    { failure: "slow", count: 1 },
    { failure: "lost", count: 1 },
    { failure: "slow", count: 7 },
  ] as const)(
    "recovers from $count $failure refreshes before the existing clock mapping expires",
    async ({ failure, count }) => {
      const { client, transport } = await setup();
      const write = transport.writeControl.bind(transport);
      let refreshes = 0;
      vi.spyOn(transport, "writeControl").mockImplementation(async (bytes) => {
        if (decodeControl(bytes).opcode === ControlOpcode.Sync) {
          refreshes++;
          if (refreshes <= count && failure === "lost")
            transport.injectLostAck();
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              refreshes <= count && failure === "slow" ? 120 : 40,
            ),
          );
        }
        await write(bytes);
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.getSnapshot()).toMatchObject({ phase: "streaming" });
      expect(client.getSnapshot().accepted).toBe(1500);
      expect(client.getSnapshot().rttMs).toBe(40);
      expect(refreshes).toBeGreaterThanOrEqual(6);
    },
  );
  it("still expires the clock when every refresh exceeds the qualification limit", async () => {
    const { client, transport } = await setup();
    const write = transport.writeControl.bind(transport);
    vi.spyOn(transport, "writeControl").mockImplementation(async (bytes) => {
      if (decodeControl(bytes).opcode === ControlOpcode.Sync)
        await new Promise((resolve) => setTimeout(resolve, 120));
      await write(bytes);
    });
    await vi.advanceTimersByTimeAsync(10_100);
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Clock synchronization expired",
    });
    expect(client.getSamples()).toHaveLength(0);
  });
  it("does not revive an expired mapping when a good probe beats the next watchdog tick", async () => {
    const { client, transport } = await setup();
    const write = transport.writeControl.bind(transport);
    let refreshes = 0;
    vi.spyOn(transport, "writeControl").mockImplementation(async (bytes) => {
      if (decodeControl(bytes).opcode === ControlOpcode.Sync) {
        refreshes++;
        await new Promise((resolve) =>
          setTimeout(resolve, refreshes <= 8 ? 120 : 10),
        );
      }
      await write(bytes);
    });
    await vi.advanceTimersByTimeAsync(10_100);
    expect(refreshes).toBe(9);
    expect(client.getSnapshot()).toMatchObject({
      phase: "fault",
      issue: "Clock synchronization expired",
    });
    expect(client.getSamples()).toHaveLength(0);
  });
  it("keeps sync and expiring feedback alive together for a ten-minute software soak", async () => {
    const { client, transport } = await setup();
    const write = transport.writeControl.bind(transport);
    let refreshes = 0;
    vi.spyOn(transport, "writeControl").mockImplementation(async (bytes) => {
      const command = decodeControl(bytes);
      const delayed =
        command.opcode === ControlOpcode.Sync && ++refreshes % 4 === 0;
      await new Promise((resolve) => setTimeout(resolve, delayed ? 120 : 20));
      await write(bytes);
    });
    client.setState({
      phase: PresentationPhase.Practice,
      hp: 100,
      maxHp: 100,
      statusFlags: 0,
      presentationEpoch: 9,
    });
    const cues = setInterval(() => {
      client.cue({
        effect: CueEffect.AcceptedCast,
        spell: SpellCode.Stupefy,
        durationMs: 300,
        presentationEpoch: 9,
      });
    }, 1000);
    try {
      await vi.advanceTimersByTimeAsync(600_000);
      expect(client.getSnapshot()).toMatchObject({
        phase: "streaming",
        accepted: 30_000,
        rejected: 0,
      });
      expect(transport.endpoint.getPresentation().state?.presentationEpoch).toBe(9);
      expect(transport.endpoint.getPresentation().cueRevision).toBeGreaterThan(590);
      expect(refreshes).toBeGreaterThan(100);
    } finally {
      clearInterval(cues);
    }
  });

  it("recovers a quiet badge link automatically, at most three times a minute", async () => {
    const endpoint = new VirtualWandTransport(() => Date.now());
    const transport: WandTransport = {
      source: "REAL BLE",
      connect: cb => endpoint.connect(cb),
      recover: vi.fn(async cb => { endpoint.disconnect(); await endpoint.connect(cb); }),
      readInfo: () => endpoint.readInfo(), readStatus: () => endpoint.readStatus(),
      subscribe: (kind, cb) => endpoint.subscribe(kind, cb), writeControl: data => endpoint.writeControl(data),
      disconnect: () => endpoint.disconnect(),
    };
    const client = new WandClient(transport, () => Date.now()); clients.push(client);
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(1200); await connecting;
    expect(client.getSnapshot().phase).toBe("streaming");
    for (let outage = 1; outage <= 3; outage++) {
      endpoint.injectOutage();
      await vi.advanceTimersByTimeAsync(600);
      expect(client.getSnapshot().phase).not.toBe("fault");
      expect(transport.recover).toHaveBeenCalledTimes(outage);
      await vi.advanceTimersByTimeAsync(1500);
      expect(client.getSnapshot().phase).toBe("streaming");
    }
    endpoint.injectOutage();
    await vi.advanceTimersByTimeAsync(600);
    expect(client.getSnapshot()).toMatchObject({ phase: "fault", failureCode: "unstable_link", canRetry: true });
    expect(transport.recover).toHaveBeenCalledTimes(3);
    // An explicit retry by the player resets the budget.
    const retry = client.retryRecovery();
    await vi.advanceTimersByTimeAsync(1500); await retry;
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(transport.recover).toHaveBeenCalledTimes(4);
  });

  it("keeps the link through a 600 ms page stall even when the watchdog tick runs first", async () => {
    const { client, transport } = await setup();
    await vi.advanceTimersByTimeAsync(100);
    const delivered = vi.fn();
    client.onSample(delivered);
    const previous = client.getSnapshot().lastSample!;
    // The page freezes for 600 ms while the badge keeps streaming into the OS buffer.
    vi.setSystemTime(Date.now() + 600);
    transport.endpoint.emitMotion({ ...previous, flags: MotionFlag.Valid, seq: previous.seq + 1, captureMs: Date.now() - 590 });
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();
    // The overdue watchdog tick runs before any fresh sample arrives: the wand was not silent.
    vi.advanceTimersByTime(26);
    expect(client.getSnapshot().phase).toBe("streaming");
    transport.endpoint.emitMotion({ ...previous, flags: MotionFlag.Valid, seq: previous.seq + 2, captureMs: Date.now() });
    await Promise.resolve();
    expect(client.getSnapshot().phase).toBe("streaming");
    expect(delivered).toHaveBeenCalled();
    expect(delivered.mock.calls[0][0].breaksGesture).toBe(true);
  });

  it("offers a retry only when the transport has something to recover", async () => {
    const endpoint = new VirtualWandTransport(() => Date.now());
    const transport: WandTransport = {
      source: "REAL BLE",
      connect: vi.fn(async () => { throw new Error("Chooser cancelled"); }),
      recover: vi.fn(async cb => endpoint.connect(cb)),
      canRecover: () => false,
      readInfo: () => endpoint.readInfo(), readStatus: () => endpoint.readStatus(),
      subscribe: (kind, cb) => endpoint.subscribe(kind, cb), writeControl: data => endpoint.writeControl(data),
      disconnect: () => endpoint.disconnect(),
    };
    const client = new WandClient(transport, () => Date.now()); clients.push(client);
    await client.connect();
    expect(client.getSnapshot()).toMatchObject({ phase: "fault", issue: "Chooser cancelled", canRetry: false });
    await client.retryRecovery();
    expect(transport.recover).not.toHaveBeenCalled();
  });

  it("ignores link loss reported while the carrier's own retry loop is running, and recovers again during validation", async () => {
    const endpoint = new VirtualWandTransport(() => Date.now());
    let lost: DisconnectListener = () => {};
    const transport: WandTransport = {
      source: "REAL BLE",
      connect: async cb => { lost = cb; await endpoint.connect(cb); },
      recover: vi.fn(async cb => {
        lost = cb;
        cb({ code: "device_disconnected", message: "Badge connection lost.", recoverable: true });  // mid-attach drop
        endpoint.disconnect();
        await endpoint.connect(cb);
      }),
      readInfo: () => endpoint.readInfo(), readStatus: () => endpoint.readStatus(),
      subscribe: (kind, cb) => endpoint.subscribe(kind, cb), writeControl: data => endpoint.writeControl(data),
      disconnect: () => endpoint.disconnect(),
    };
    const client = new WandClient(transport, () => Date.now()); clients.push(client);
    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(1200); await connecting;
    expect(client.getSnapshot().phase).toBe("streaming");
    lost({ code: "device_disconnected", message: "Badge connection lost.", recoverable: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(transport.recover).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().phase).toBe("validating");
    // A second outage inside the recovery's own validation window recovers again.
    endpoint.injectOutage();
    await vi.advanceTimersByTimeAsync(700);
    expect(transport.recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(client.getSnapshot().phase).toBe("streaming");
  });
});
