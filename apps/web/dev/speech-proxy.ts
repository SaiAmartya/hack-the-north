import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";

export const AUDIO_LIMIT = 96_000;
/** The loopback game origin, spelled either way the player may have typed it. */
export function approvedOrigins(approvedOrigin: string): string[] {
  if (approvedOrigin === "http://127.0.0.1:5173") return [approvedOrigin, "http://localhost:5173"];
  if (approvedOrigin === "http://localhost:5173") return [approvedOrigin, "http://127.0.0.1:5173"];
  return [approvedOrigin];
}
export function localSpeechAllowed(
  origin: string | undefined,
  peer: string | undefined,
  approvedOrigin: string,
  interfaceAddress: string,
): boolean {
  const address = peer?.replace(/^::ffff:/, "");
  return (
    origin !== undefined &&
    approvedOrigins(approvedOrigin).includes(origin) &&
    !!address &&
    ["127.0.0.1", "::1", interfaceAddress].includes(address)
  );
}
/** Runs before proxying; forwarded address headers are deliberately ignored. */
export function speechMiddleware(
  origin: string,
  host: string,
  secret: string | undefined,
) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/api/speech/")) {
      next();
      return;
    }
    if (
      !localSpeechAllowed(
        req.headers.origin,
        req.socket.remoteAddress,
        origin,
        host,
      )
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const path =
      req.url === "/api/speech/health"
        ? "/health"
        : req.url === "/api/speech/transcribe"
          ? "/transcribe"
          : undefined;
    if (!path || req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!secret) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"ready":false,"issue":"Start the local speech helper"}');
      return;
    }
    if (
      path === "/transcribe" &&
      req.headers["content-type"] !== "application/octet-stream"
    ) {
      res.writeHead(415);
      res.end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > AUDIO_LIMIT) {
        if (!res.headersSent) {
          res.writeHead(413);
          res.end();
        }
        chunks.length = 0;
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > AUDIO_LIMIT) return;
      const headers: Record<string, string> = {
        "X-Wand-Speech-Secret": secret,
        "Content-Length": String(size),
      };
      for (const [key, value] of Object.entries(req.headers))
        if (
          typeof value === "string" &&
          (key === "content-type" ||
            [
              "x-wand-audio-format",
              "x-wand-sample-rate",
              "x-wand-channels",
              "x-wand-utterance-id",
              "x-wand-generation",
              "x-wand-voice-start-ms",
              "x-wand-voice-end-ms",
              "x-wand-deadline-budget-ms",
            ].includes(key))
        )
          headers[key] = value;
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: 8001,
          path,
          method: path === "/health" ? "GET" : "POST",
          headers,
          timeout: 1500,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(503);
        res.end();
      });
      upstream.end(Buffer.concat(chunks));
      res.on("close", () => upstream.destroy());
    });
  };
}
