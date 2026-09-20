import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * One spelling of the game origin. The hosted phone service trusts the launcher's exact origin
 * (`http://127.0.0.1:5173`); a tab typed as `localhost:5173` is the same laptop but a different
 * Origin, so its owner socket is refused before pairing and the page can only report
 * "Connection interrupted". Send such a tab to the canonical origin before anything can pair.
 */
export function canonicalOriginMiddleware(origin: string) {
  const canonicalHost = new URL(origin).host;
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const host = req.headers.host;
    if (!host || host === canonicalHost) { next(); return; }
    res.writeHead(307, { Location: `${origin}${req.url ?? "/"}`, "Cache-Control": "no-store" });
    res.end();
  };
}
