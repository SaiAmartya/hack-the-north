import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneRelayChannel, parseHostedPair } from "./relay";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("phone relay lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it("rejects a pending pair immediately when its owner disconnects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "wand.test",
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const relay = new PhoneRelayChannel("session-token");

    const connecting = relay.connect(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);
    relay.disconnect();

    await expect(connecting).rejects.toThrow("Phone connection cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances[0].readyState).toBe(3);
  });

  it("accepts the relay's null data for operations with no byte response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "wand.test",
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const relay = new PhoneRelayChannel("session-token");

    const connecting = relay.connect(() => undefined);
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({ v: 1, type: "paired", generation: 1 }),
    });
    await connecting;

    const subscribed = relay.subscribe("status", () => undefined);
    const operation = JSON.parse(socket.sent.at(-1)!);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "reply",
        id: operation.id,
        data: null,
        error: null,
      }),
    });
    await expect(subscribed).resolves.toBeUndefined();
    relay.disconnect();
  });

  it("keeps hosted authority out of URLs and requires the matching claim approval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T16:00:00Z"));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const roomId = "1".repeat(32);
    const ownerToken = "2".repeat(64);
    const pair = parseHostedPair({
      roomId,
      ownerToken,
      expiresAtMs: Date.now() + 120_000,
      socketUrl: `wss://wand.example/ws/${roomId}`,
      phoneUrl: `https://wand.example/phone?room=${roomId}`,
    });
    const claims: { claimId: string; challenge: string }[] = [];
    const relay = new PhoneRelayChannel({
      mode: "hosted",
      pair,
      onClaim: (claim) => claims.push(claim),
    });

    const connecting = relay.connect(() => undefined);
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe(pair.socketUrl);
    expect(socket.url).not.toContain(ownerToken);
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0])).toEqual({
      v: 1,
      type: "owner",
      token: ownerToken,
    });

    const claimId = "3".repeat(32);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "claim",
        claimId,
        challenge: "482193",
      }),
    });
    expect(claims).toEqual([{ claimId, challenge: "482193" }]);
    expect(() => relay.approve("4".repeat(32))).toThrow(
      "Phone claim is no longer pending",
    );
    relay.approve(claimId);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      v: 1,
      type: "approve",
      claimId,
    });

    socket.onmessage?.({
      data: JSON.stringify({ v: 1, type: "paired", generation: 1 }),
    });
    await expect(connecting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    const observed: number[][] = [];
    const subscribed = relay.subscribe("motion", (bytes) =>
      observed.push([...bytes]),
    );
    const operation = JSON.parse(socket.sent.at(-1)!);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "reply",
        id: operation.id,
        data: null,
        error: null,
      }),
    });
    await expect(subscribed).resolves.toBeUndefined();

    const motion = Array.from({ length: 20 }, (_, index) => index);
    const deliveryId = "4".repeat(32);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "notify",
        kind: "motion",
        data: motion,
        deliveryId,
      }),
    });
    expect(observed).toEqual([motion]);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      v: 1,
      type: "received",
      id: deliveryId,
    });

    const statuses: number[][] = [];
    const statusSubscription = relay.subscribe("status", (bytes) =>
      statuses.push([...bytes]),
    );
    const statusOperation = JSON.parse(socket.sent.at(-1)!);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "reply",
        id: statusOperation.id,
        data: null,
        error: null,
      }),
    });
    await expect(statusSubscription).resolves.toBeUndefined();
    const status = Array.from({ length: 20 }, (_, index) => 255 - index);
    const statusDeliveryId = "5".repeat(32);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "notify",
        kind: "status",
        data: status,
        deliveryId: statusDeliveryId,
      }),
    });
    expect(statuses).toEqual([status]);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      v: 1,
      type: "received",
      id: statusDeliveryId,
    });

    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "notify",
        kind: "motion",
        data: motion,
      }),
    });
    expect(socket.readyState).toBe(3);
  });

  it("rejects hosted sessions with secrets in their public URLs", () => {
    const roomId = "1".repeat(32);
    expect(() =>
      parseHostedPair({
        roomId,
        ownerToken: "2".repeat(64),
        expiresAtMs: Date.now() + 120_000,
        socketUrl: `wss://wand.example/ws/${roomId}?token=secret`,
        phoneUrl: `https://wand.example/phone?room=${roomId}`,
      }),
    ).toThrow("Invalid hosted phone session");
  });
});
