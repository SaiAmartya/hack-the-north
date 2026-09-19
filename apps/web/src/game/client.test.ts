import { afterEach, expect, it, vi } from "vitest";
import { GameClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

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
  const connecting = client.connect("ble");
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
  await expect(client.connect("ble")).rejects.toThrow("duel is full");
  await expect(client.pair()).rejects.toThrow("Phone pairing unavailable");
  client.disconnect();
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
});
