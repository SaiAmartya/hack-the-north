import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { phoneMiddleware, phoneServiceOrigin } from "../../dev/phone-proxy";

const origin = "http://127.0.0.1:5173";
const service = "https://phone.example";
const room = "a".repeat(32);
const pair = () => ({ roomId: room, ownerToken: "b".repeat(64), expiresAtMs: Date.now() + 120_000,
  socketUrl: `wss://phone.example/ws/${room}`, phoneUrl: `${service}/phone?room=${room}` });
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function start(fetcher: typeof fetch, enabled = true) {
  const middleware = phoneMiddleware(origin, "127.0.0.1", enabled ? service : undefined,
    enabled ? "enrollment-test-only" : undefined, fetcher);
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  return `http://127.0.0.1:${address.port}`;
}
describe("local hosted-phone broker", () => {
  it("rejects credentials and non-origin service URLs", () => {
    for (const url of ["http://phone.example", "https://secret@phone.example", "https://phone.example/api", "https://phone.example?token=x"])
      expect(() => phoneServiceOrigin(url)).toThrow();
  });
  it("keeps enrollment server-side, returns only the scoped pair, and rate limits", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(pair())));
    const base = await start(upstream);
    const config = await fetch(`${base}/api/phone/config`, { method: "POST", headers: { Origin: origin } });
    expect(await config.json()).toEqual({ enabled: true });
    const response = await fetch(`${base}/api/phone/pair`, { method: "POST", headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect((await response.text())).not.toContain("enrollment-test-only");
    expect(upstream).toHaveBeenCalledWith(`${service}/api/rooms`, expect.objectContaining({
      redirect: "error", body: "{}", headers: { Authorization: "Bearer enrollment-test-only", "Content-Type": "application/json" },
    }));
    const again = await fetch(`${base}/api/phone/pair`, { method: "POST", headers: { Origin: origin } });
    expect(again.status).toBe(429);
  });
  it("refuses foreign origins, arbitrary bodies and non-POST without remote traffic", async () => {
    const upstream = vi.fn<typeof fetch>();
    const base = await start(upstream);
    expect((await fetch(`${base}/api/phone/pair`, { method: "POST", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/phone/pair`, { method: "POST", headers: { Origin: origin }, body: "private audio" })).status).toBe(413);
    expect((await fetch(`${base}/api/phone/pair`, { headers: { Origin: origin } })).status).toBe(405);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("fails closed on a different relay origin and oversized responses", async () => {
    for (const body of [JSON.stringify({ ...pair(), phoneUrl: `https://other.example/phone?room=${room}`, socketUrl: `wss://other.example/ws/${room}` }), "x".repeat(5000)]) {
      const base = await start(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
      const response = await fetch(`${base}/api/phone/pair`, { method: "POST", headers: { Origin: origin } });
      expect(response.status).toBe(503);
    }
  });
  it("leaves the existing LAN path available when hosting is disabled", async () => {
    const base = await start(vi.fn<typeof fetch>(), false);
    const response = await fetch(`${base}/api/phone/config`, { method: "POST", headers: { Origin: origin } });
    expect(await response.json()).toEqual({ enabled: false });
  });
});
