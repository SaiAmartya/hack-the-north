import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WandClient } from "./client";
import { VirtualWandTransport } from "./virtual";
import {
  CueEffect,
  PresentationPhase,
  SpellCode,
  HealthFlag,
  decodeStatus,
  encodeStatus,
  StatusKind,
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
});
