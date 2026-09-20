import { afterEach, expect, it, vi } from "vitest";
import { GameClient, normalizeRoomCode } from "./client";

afterEach(() => vi.unstubAllGlobals());

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
