import type { IncomingMessage, ServerResponse } from "node:http";
import { localSpeechAllowed } from "./speech-proxy";
import { parseHostedPair } from "../src/phone/relay";

export function phoneServiceOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.port)
    throw new Error("Phone service must be one HTTPS origin without credentials or a path");
  return url.origin;
}

/** Only the owning laptop can mint a pair; the enrollment secret never reaches JS. */
export function phoneMiddleware(
  origin: string,
  host: string,
  service: string | undefined,
  secret: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const remote = phoneServiceOrigin(service);
  if (Boolean(remote) !== Boolean(secret))
    throw new Error("Phone hosting requires both its origin and enrollment secret");
  let busy = false;
  let nextPairAt = 0;
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/api/phone/")) { next(); return; }
    const send = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (!localSpeechAllowed(req.headers.origin, req.socket.remoteAddress, origin, host)) {
      send(403, { issue: "Use this laptop to connect your phone" }); return;
    }
    if (req.method !== "POST" || !["/api/phone/config", "/api/phone/pair"].includes(req.url)) {
      send(405, { issue: "Unsupported phone request" }); return;
    }
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) > 2) {
      send(413, { issue: "Phone requests cannot carry data" }); return;
    }
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2) send(413, { issue: "Phone requests cannot carry data" }); });
    req.on("end", () => {
      if (res.writableEnded || res.destroyed) return;
      if (req.url === "/api/phone/config") { send(200, { enabled: Boolean(remote) }); return; }
      if (!remote || !secret) { send(503, { issue: "Phone hosting is not configured" }); return; }
      if (busy || Date.now() < nextPairAt) { send(429, { issue: "Wait a moment, then reconnect" }); return; }
      busy = true;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 5_000);
      res.on("close", () => abort.abort());
      void (async () => {
        try {
          const response = await fetcher(`${remote}/api/rooms`, {
            method: "POST", redirect: "error", signal: abort.signal,
            headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
            body: "{}",
          });
          if (!response.ok || !response.body) throw new Error("unavailable");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 4_096) { await reader.cancel(); throw new Error("oversize"); }
            chunks.push(part.value);
          }
          const pair = parseHostedPair(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (new URL(pair.phoneUrl).origin !== remote || pair.expiresAtMs > Date.now() + 125_000)
            throw new Error("wrong service");
          // Only a successful pair starts a short cooldown; a failed or cancelled attempt may be
          // retried at once instead of surfacing as "unavailable".
          nextPairAt = Date.now() + 2_000;
          send(200, pair);
        } catch {
          send(503, { issue: "Phone connection unavailable. Try again." });
        } finally {
          clearTimeout(timeout);
          busy = false;
        }
      })();
    });
  };
}
