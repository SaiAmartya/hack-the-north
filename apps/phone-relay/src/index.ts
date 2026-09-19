import {
  isAllowedAssetPath, isRoomId, parseOwnerOrigins, randomHex, secretsEqual,
} from "./protocol";
export { PairRoom } from "./room";

const PAIR_WINDOW_MS = 120_000;
const ROOM_LIFETIME_MS = 30 * 60_000;
const MAX_CREATE_BODY_BYTES = 64;

export type Env = {
  ROOMS: DurableObjectNamespace<import("./room").PairRoom>;
  ASSETS: Fetcher;
  PAIR_CREATE_SECRET: string;
  ALLOWED_OWNER_ORIGINS?: string;
};

export type RoomInit = {
  roomId: string;
  ownerToken: string;
  createdAtMs: number;
  pairDeadlineMs: number;
  expiresAtMs: number;
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function plainResponse(status: number, body = "Not found"): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function securityHeaders(response: Response, host: string): Response {
  const secured = new Response(response.body, response);
  secured.headers.set(
    "content-security-policy",
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://${host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
  );
  secured.headers.set("cross-origin-opener-policy", "same-origin");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  return secured;
}

export function isRoomInit(value: unknown): value is RoomInit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RoomInit>;
  const { createdAtMs, pairDeadlineMs, expiresAtMs } = record;
  return (
    Object.keys(record).length === 5 &&
    typeof record.roomId === "string" &&
    isRoomId(record.roomId) &&
    typeof record.ownerToken === "string" &&
    /^[0-9a-f]{64}$/.test(record.ownerToken) &&
    typeof createdAtMs === "number" &&
    Number.isSafeInteger(createdAtMs) &&
    typeof pairDeadlineMs === "number" &&
    Number.isSafeInteger(pairDeadlineMs) &&
    typeof expiresAtMs === "number" &&
    Number.isSafeInteger(expiresAtMs) &&
    pairDeadlineMs === createdAtMs + PAIR_WINDOW_MS &&
    expiresAtMs === createdAtMs + ROOM_LIFETIME_MS
  );
}

export async function readJsonWithLimit(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("body_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error("body_too_large");
  }
  return JSON.parse(text) as unknown;
}

async function authorizeCreate(request: Request, env: Env): Promise<boolean> {
  if (request.headers.has("origin")) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length > 520) return false;
  const token = header.slice("Bearer ".length);
  return Boolean(env.PAIR_CREATE_SECRET) && secretsEqual(token, env.PAIR_CREATE_SECRET);
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (!(await authorizeCreate(request, env))) {
    return plainResponse(401, "Unauthorized");
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return plainResponse(415, "Unsupported media type");
  }
  try {
    const body = await readJsonWithLimit(request, MAX_CREATE_BODY_BYTES);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0
    ) {
      return plainResponse(400, "Invalid request");
    }
  } catch {
    return plainResponse(400, "Invalid request");
  }

  const url = new URL(request.url);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const roomId = randomHex(16);
    const ownerToken = randomHex(32);
    const createdAtMs = Date.now();
    const pairDeadlineMs = createdAtMs + PAIR_WINDOW_MS;
    const expiresAtMs = createdAtMs + ROOM_LIFETIME_MS;
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    const initialized = await stub.fetch("https://room.internal/init", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PAIR_CREATE_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        roomId,
        ownerToken,
        createdAtMs,
        pairDeadlineMs,
        expiresAtMs,
      } satisfies RoomInit),
    });
    if (initialized.status === 409) continue;
    if (!initialized.ok) return plainResponse(503, "Pairing unavailable");

    const socketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return jsonResponse(
      {
        roomId,
        ownerToken,
        expiresAtMs: pairDeadlineMs,
        socketUrl: `${socketProtocol}//${url.host}/ws/${roomId}`,
        phoneUrl: `${url.origin}/phone?room=${roomId}`,
      },
      201,
    );
  }
  return plainResponse(503, "Pairing unavailable");
}

async function openSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.search) return plainResponse(404);
  const match = /^\/ws\/([0-9a-f]{32})$/.exec(url.pathname);
  if (!match) return plainResponse(404);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return plainResponse(426, "WebSocket required");
  }

  const ownerOrigins = parseOwnerOrigins(env.ALLOWED_OWNER_ORIGINS);
  if (!ownerOrigins) return plainResponse(503, "Pairing unavailable");
  const origin = request.headers.get("origin");
  if (!origin || (origin !== url.origin && !ownerOrigins.has(origin))) {
    return plainResponse(403, "Forbidden");
  }

  const roomId = match[1];
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  return stub.fetch("https://room.internal/connect", {
    headers: {
      authorization: `Bearer ${env.PAIR_CREATE_SECRET}`,
      origin,
      upgrade: "websocket",
      "x-service-origin": url.origin,
    },
  });
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plainResponse(404);
  }
  if (!isAllowedAssetPath(url.pathname)) return plainResponse(404);
  if (url.pathname === "/phone") {
    if (
      url.searchParams.size !== 1 ||
      !isRoomId(url.searchParams.get("room") ?? "")
    ) {
      return plainResponse(404);
    }
  } else if (url.search) {
    return plainResponse(404);
  }

  const assetUrl = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/phone") {
    assetUrl.pathname = "/phone.html";
    assetUrl.search = "";
  }
  const asset = await env.ASSETS.fetch(
    new Request(assetUrl, { method: request.method }),
  );
  if (!asset.ok) return plainResponse(404);
  const secured = securityHeaders(asset, url.host);
  if (url.pathname === "/" || url.pathname === "/phone") {
    secured.headers.set("cache-control", "no-store");
  }
  return secured;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return plainResponse(405, "Method not allowed");
      }
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") {
        return plainResponse(405, "Method not allowed");
      }
      return createRoom(request, env);
    }
    if (url.pathname.startsWith("/ws/")) return openSocket(request, env);
    return serveAsset(request, env);
  },
};
