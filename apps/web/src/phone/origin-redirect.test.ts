import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { canonicalOriginMiddleware } from "../../dev/origin-redirect";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function start(origin: string) {
  const middleware = canonicalOriginMiddleware(origin);
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(200); res.end("served"); }));
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  return address.port;
}
function send(port: number, host: string, path: string, method = "GET") {
  return new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.on("error", reject);
    req.end();
  });
}
describe("canonical game origin", () => {
  it("sends a localhost tab to the launcher's exact origin with the same path", async () => {
    const port = await start("http://127.0.0.1:5173");
    expect(await send(port, "localhost:5173", "/?p=1")).toEqual({ status: 307, location: "http://127.0.0.1:5173/?p=1" });
    expect(await send(port, "localhost:5173", "/api/phone/pair", "POST")).toEqual({ status: 307, location: "http://127.0.0.1:5173/api/phone/pair" });
  });
  it("serves the exact origin untouched", async () => {
    const port = await start("http://127.0.0.1:5173");
    expect(await send(port, "127.0.0.1:5173", "/api/phone/config", "POST")).toEqual({ status: 200, location: undefined });
    const lan = await start("https://192.168.1.20:5173");
    expect(await send(lan, "192.168.1.20:5173", "/")).toEqual({ status: 200, location: undefined });
  });
});
