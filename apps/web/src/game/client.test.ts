import { afterEach, expect, it, vi } from "vitest";
import { GameClient, normalizeRoomCode } from "./client";
import welcome from "../../../host/tests/fixtures/game-welcome-v1.json";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  deferClose = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    if (!this.deferClose) this.finishClose();
  }
  finishClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

async function connectedClient() {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", new URL("http://127.0.0.1:5173"));
  const request = vi.fn().mockImplementation(() =>
    Promise.resolve(Response.json({ token: "test-only-session", slot: "P1" })),
  );
  vi.stubGlobal("fetch", request);
  const client = new GameClient();
  const connecting = client.connect("ble", "K7X2PD");
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message(welcome);
  await connecting;
  return { client, socket, request };
}

it("creates rooms, sends the code with the session and explains an unknown code", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ code: "K7X2PD" }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", request);
  const client = new GameClient();
  await expect(client.createRoom()).resolves.toBe("K7X2PD");
  expect(request.mock.calls[0][0]).toBe("/api/game/room");
  expect(request.mock.calls[0][1].method).toBe("POST");
  await expect(client.connect("ble", "K7X2PD")).rejects.toThrow(
    "No duel with that code.",
  );
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({
    name: "Wizard",
    source: "ble",
    code: "K7X2PD",
  });
  await expect(client.createRoom()).rejects.toThrow("Too many duels");
  await expect(client.connect("ble", "bad")).rejects.toThrow("six-character");
  expect(request).toHaveBeenCalledTimes(3);
  expect(normalizeRoomCode(" k7x-2pd ")).toBe("K7X2PD");
});

it("releases a session returned after cancellation without opening a socket", async () => {
  let finish!: (response: Response) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(new Response(null, { status: 204 }));
  const socket = vi.fn();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("WebSocket", socket);
  const client = new GameClient();
  const connecting = client.connect("ble", "K7X2PD");
  client.disconnect();
  finish(Response.json({ token: "test-only-session", slot: "P1" }));
  await expect(connecting).rejects.toThrow("Connection cancelled");
  expect(socket).not.toHaveBeenCalled();
  expect(request.mock.calls[1][1].method).toBe("DELETE");
  expect(client.token).toBe("");
});

it("does not retain HTTP abort controllers after failed session or pairing requests", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options) => {
      signals.push(options.signal);
      return Promise.resolve(new Response(null, { status: 409 }));
    }),
  );
  const client = new GameClient();
  await expect(client.connect("ble", "K7X2PD")).rejects.toThrow("duel is full");
  await expect(client.pair()).rejects.toThrow("Phone pairing unavailable");
  client.disconnect();
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
});

it("reattaches the same session and ignores every callback from its replaced socket", async () => {
  const { client, socket, request } = await connectedClient();
  const stale = {
    open: socket.onopen,
    message: socket.onmessage,
    error: socket.onerror,
    close: socket.onclose,
  };
  socket.close();
  const reconnecting = client.reconnect();
  const replacement = FakeWebSocket.instances[1];
  expect(client.issue).toContain("Reconnecting");
  replacement.open();
  stale.open?.();
  expect(replacement.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
    { v: 1, type: "auth", token: "test-only-session" },
  ]);
  replacement.message({
    ...welcome,
    connectionGeneration: 2,
    snapshot: { ...welcome.snapshot, stateVersion: 10, serverNowMs: 20_000 },
  });
  await expect(reconnecting).resolves.toBe(true);
  stale.message?.({ data: JSON.stringify({ ...welcome, connectionGeneration: 99 }) });
  stale.error?.();
  stale.close?.();
  expect(client.token).toBe("test-only-session");
  expect(client.slot).toBe("P1");
  expect(client.connectionGeneration).toBe(2);
  expect(client.snapshot?.stateVersion).toBe(10);
  expect(client.now()).toBeCloseTo(20_000);
  expect(client.issue).toBe("");
  expect(request).toHaveBeenCalledTimes(1);
  expect(socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "leave")).toBe(false);
  client.disconnect();
});

it("returns a rejected reservation to the caller without creating or releasing a session", async () => {
  const { client, socket, request } = await connectedClient();
  socket.close();
  const reconnecting = client.reconnect();
  const replacement = FakeWebSocket.instances[1];
  replacement.open();
  replacement.message({ v: 1, type: "error", code: "auth_failed" });
  await expect(reconnecting).resolves.toBe(false);
  expect(client.issue).toBe("Battle session ended. Rejoin the duel.");
  expect(client.token).toBe("test-only-session");
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  client.disconnect();
});

it("cancels a pending reattach when another reattach or leave supersedes it", async () => {
  const { client, socket } = await connectedClient();
  socket.close();
  const first = client.reconnect();
  const firstRejected = expect(first).rejects.toThrow("Connection cancelled");
  const obsolete = FakeWebSocket.instances[1].onmessage;
  const second = client.reconnect();
  await Promise.resolve();
  await firstRejected;
  const secondRejected = expect(second).rejects.toThrow("Connection cancelled");
  client.disconnect();
  await secondRejected;
  obsolete?.({ data: JSON.stringify(welcome) });
  expect(client.token).toBe("");
  expect(client.snapshot).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("still closes a reattached game connection when authoritative messages stop", async () => {
  const { client, socket } = await connectedClient();
  socket.close();
  const reconnecting = client.reconnect();
  const replacement = FakeWebSocket.instances[1];
  replacement.open();
  replacement.message({ ...welcome, connectionGeneration: 2 });
  await reconnecting;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(replacement.readyState).toBe(3);
  expect(client.issue).toBe("Game connection lost");
  client.disconnect();
});

it.each(["open", "closing"])("waits for an %s socket to close before reattaching", async (state) => {
  const { client, socket, request } = await connectedClient();
  socket.deferClose = true;
  if (state === "closing") socket.close();
  const staleMessage = socket.onmessage;
  const reconnecting = client.reconnect();
  await vi.advanceTimersByTimeAsync(500);
  expect(FakeWebSocket.instances).toHaveLength(1);
  staleMessage?.({ data: JSON.stringify({ ...welcome, connectionGeneration: 99 }) });
  expect(client.connectionGeneration).toBe(1);
  expect(client.issue).toContain("Reconnecting");
  socket.finishClose();
  await Promise.resolve();
  const replacement = FakeWebSocket.instances[1];
  replacement.open();
  replacement.message({ ...welcome, connectionGeneration: 2 });
  await expect(reconnecting).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "leave")).toBe(false);
  client.disconnect();
});

it("cancels superseded close waits and never reopens a socket after leaving", async () => {
  const { client, socket } = await connectedClient();
  socket.deferClose = true;
  const first = client.reconnect();
  const firstRejected = expect(first).rejects.toThrow("Connection cancelled");
  const obsoleteClose = socket.onclose;
  const second = client.reconnect();
  await firstRejected;
  obsoleteClose?.();
  await Promise.resolve();
  expect(FakeWebSocket.instances).toHaveLength(1);
  const secondRejected = expect(second).rejects.toThrow("Connection cancelled");
  client.disconnect();
  await secondRejected;
  socket.finishClose();
  await Promise.resolve();
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds the close wait without racing a replacement against the retained peer", async () => {
  const { client, socket, request } = await connectedClient();
  socket.deferClose = true;
  const reconnecting = client.reconnect();
  const rejected = expect(reconnecting).rejects.toThrow("still closing");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  client.disconnect();
});
