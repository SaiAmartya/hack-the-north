import { DurableObject } from "cloudflare:workers";
import {
  MAX_FRAME_BYTES,
  type PhoneNotification,
  MAX_PENDING_OPERATIONS,
  OPERATION_TIMEOUT_MS,
  isAllowedAssetPath,
  isRoomId,
  parseOwnerApproval,
  parseOwnerAuth,
  parseOwnerOperation,
  parseOwnerOrigins,
  parseOwnerReceived,
  parsePhoneAuth,
  parsePhoneNotification,
  parsePhoneReply,
  parseTextFrame,
  randomChallenge,
  randomHex,
  secretsEqual,
  sha256Hex,
} from "./protocol";

const PAIR_WINDOW_MS = 120_000;
const ROOM_LIFETIME_MS = 30 * 60_000;
const MAX_CREATE_BODY_BYTES = 64;
const MAX_INIT_BODY_BYTES = 512;
const MAX_CONNECTIONS = 2;
const OWNER_MESSAGES_PER_SECOND = 100;
const PHONE_MESSAGES_PER_SECOND = 80;
const UNAUTHENTICATED_MESSAGES_PER_SECOND = 24;
const MAX_QUEUED_MESSAGES = 8;
const MAX_QUEUE_AGE_MS = 100;
const MAX_CONSECUTIVE_STALE_MOTION = 3;
const AUTH_TIMEOUT_MS = 5_000;
const DELIVERY_ACK_TIMEOUT_MS = 200;
const MOTION_STALE_MS = 100;
const NOTIFICATION_DELIVERY_WINDOW = 8;
const MAX_PENDING_STATUS_NOTIFICATIONS = 4;
const ROOM_KEY = "room";

export type Env = {
  ROOMS: DurableObjectNamespace<PairRoom>;
  ASSETS: Fetcher;
  PAIR_CREATE_SECRET: string;
  ALLOWED_OWNER_ORIGINS?: string;
};

type RoomRecord = {
  version: 1;
  roomId: string;
  ownerTokenHash: string;
  createdAtMs: number;
  pairDeadlineMs: number;
  expiresAtMs: number;
  status: "waiting" | "paired" | "closed";
  pairedOnce: boolean;
  generation: 1;
};

type SocketRole = "unauthenticated" | "owner" | "pending-phone" | "phone";

type SocketAttachment = {
  version: 1;
  role: SocketRole;
  origin: string;
  serviceOrigin: string;
  connectedAtMs: number;
  rateWindowMs: number;
  rateCount: number;
  staleMotionCount: number;
  deliveryIds?: string[];
  pendingOperationIds?: string[];
  claimId?: string;
  challenge?: string;
};

type RoomInit = {
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

function plainResponse(status: number, body = "Not found"): Response {
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

function attachmentOf(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment() as unknown;
  if (!value || typeof value !== "object") return null;
  const attachment = value as Partial<SocketAttachment>;
  if (
    attachment.version !== 1 ||
    (attachment.role !== "unauthenticated" &&
      attachment.role !== "owner" &&
      attachment.role !== "pending-phone" &&
      attachment.role !== "phone") ||
    typeof attachment.origin !== "string" ||
    typeof attachment.serviceOrigin !== "string" ||
    typeof attachment.connectedAtMs !== "number" ||
    typeof attachment.rateWindowMs !== "number" ||
    typeof attachment.rateCount !== "number" ||
    (attachment.deliveryIds !== undefined &&
      (!Array.isArray(attachment.deliveryIds) ||
        attachment.deliveryIds.length > NOTIFICATION_DELIVERY_WINDOW ||
        !attachment.deliveryIds.every(
          (id) => typeof id === "string" && /^[0-9a-f]{32}$/.test(id),
        ))) ||
    (attachment.pendingOperationIds !== undefined &&
      (!Array.isArray(attachment.pendingOperationIds) ||
        attachment.pendingOperationIds.length > MAX_PENDING_OPERATIONS ||
        !attachment.pendingOperationIds.every(
          (id) =>
            typeof id === "string" &&
            /^[A-Za-z0-9._:-]{1,64}$/.test(id),
        )))
  ) {
    return null;
  }
  return attachment as SocketAttachment;
}

function isRoomInit(value: unknown): value is RoomInit {
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

async function readJsonWithLimit(
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
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return plainResponse(426, "WebSocket required");
  }
  const url = new URL(request.url);
  if (url.search) return plainResponse(404);
  const match = /^\/ws\/([0-9a-f]{32})$/.exec(url.pathname);
  if (!match) return plainResponse(404);

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

export class PairRoom extends DurableObject<Env> {
  private room: RoomRecord | null = null;
  private serial: Promise<void> = Promise.resolve();
  private queuedMessages = 0;
  private backlogShutdownQueued = false;
  private readonly pendingOperations = new Map<string, number>();
  private readonly notificationDeliveries = new Map<string, number>();
  private transientTimer: ReturnType<typeof setTimeout> | null = null;
  private persistenceWrites = 0;
  private alarmWrites = 0;
  private latestMotion: {
    notification: PhoneNotification;
    arrivedAtMs: number;
  } | null = null;
  private readonly pendingStatuses: Array<{
    notification: PhoneNotification;
    arrivedAtMs: number;
  }> = [];
  private readonly state: DurableObjectState;
  private readonly workerEnv: Env;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    this.state = state;
    this.workerEnv = env;
    this.state.setHibernatableWebSocketEventTimeout(1_000);
    this.state.blockConcurrencyWhile(async () => {
      this.room = (await this.state.storage.get<RoomRecord>(ROOM_KEY)) ?? null;
      const interrupted = this.state.getWebSockets().some((socket) => {
        const attachment = attachmentOf(socket);
        return Boolean(
          attachment?.deliveryIds?.length ||
            attachment?.pendingOperationIds?.length,
        );
      });
      if (this.room?.status === "paired" && interrupted) {
        this.room.status = "closed";
        await this.persistRoom();
        await this.closeSockets("relay_restarted");
        await this.scheduleLifecycleAlarm();
        return;
      }
      this.scheduleTransientTimer();
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.enqueue(() => this.handleFetch(request));
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const arrivedAtMs = Date.now();
    if (
      typeof message !== "string" ||
      message.length > MAX_FRAME_BYTES ||
      new TextEncoder().encode(message).byteLength > MAX_FRAME_BYTES
    ) {
      return this.rejectBeforeQueue(socket, "invalid_message");
    }
    if (this.queuedMessages >= MAX_QUEUED_MESSAGES) {
      return this.rejectBeforeQueue(socket, "event_backlog");
    }
    this.queuedMessages += 1;
    return this.enqueue(() => this.handleMessage(socket, message, arrivedAtMs)).finally(
      () => {
        this.queuedMessages -= 1;
      },
    );
  }

  webSocketClose(socket: WebSocket): Promise<void> {
    return this.enqueue(async () => {
      const attachment = attachmentOf(socket);
      if (attachment && attachment.role !== "unauthenticated") {
        await this.terminateRoom("peer_disconnected");
      } else {
        this.scheduleTransientTimer();
      }
    });
  }

  webSocketError(socket: WebSocket): Promise<void> {
    return this.webSocketClose(socket);
  }

  alarm(): Promise<void> {
    return this.enqueue(async () => {
      const room = this.room;
      if (!room) return;
      const now = Date.now();
      if (now >= room.expiresAtMs) {
        await this.closeSockets("room_expired");
        this.room = null;
        await this.state.storage.deleteAll();
        return;
      }
      if (room.status === "waiting" && now >= room.pairDeadlineMs) {
        await this.terminateRoom("pair_expired");
        return;
      }
      await this.scheduleLifecycleAlarm();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private rejectBeforeQueue(socket: WebSocket, code: string): Promise<void> {
    const attachment = attachmentOf(socket);
    this.closeSocket(socket, code);
    if (
      attachment &&
      attachment.role !== "unauthenticated" &&
      !this.backlogShutdownQueued
    ) {
      this.backlogShutdownQueued = true;
      return this.enqueue(() => this.terminateRoom(code)).finally(() => {
        this.backlogShutdownQueued = false;
      });
    }
    return Promise.resolve();
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorized = await this.internalRequestAuthorized(request);
    if (!authorized) return plainResponse(403, "Forbidden");
    if (url.pathname === "/init" && request.method === "POST") {
      return this.initialize(request);
    }
    if (url.pathname === "/connect" && request.method === "GET") {
      return this.connectWebSocket(request);
    }
    return plainResponse(404);
  }

  private async internalRequestAuthorized(request: Request): Promise<boolean> {
    const header = request.headers.get("authorization") ?? "";
    return (
      header.startsWith("Bearer ") &&
      Boolean(this.workerEnv.PAIR_CREATE_SECRET) &&
      (await secretsEqual(
        header.slice("Bearer ".length),
        this.workerEnv.PAIR_CREATE_SECRET,
      ))
    );
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.room) return plainResponse(409, "Room exists");
    let value: unknown;
    try {
      value = await readJsonWithLimit(request, MAX_INIT_BODY_BYTES);
    } catch {
      return plainResponse(400, "Invalid request");
    }
    if (!isRoomInit(value)) return plainResponse(400, "Invalid request");
    this.room = {
      version: 1,
      roomId: value.roomId,
      ownerTokenHash: await sha256Hex(value.ownerToken),
      createdAtMs: value.createdAtMs,
      pairDeadlineMs: value.pairDeadlineMs,
      expiresAtMs: value.expiresAtMs,
      status: "waiting",
      pairedOnce: false,
      generation: 1,
    };
    await this.persistRoom();
    await this.scheduleLifecycleAlarm();
    return new Response(null, { status: 204 });
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    const room = this.room;
    const now = Date.now();
    if (
      !room ||
      room.status !== "waiting" ||
      room.pairedOnce ||
      now >= room.pairDeadlineMs ||
      now >= room.expiresAtMs
    ) {
      return plainResponse(410, "Room unavailable");
    }
    if (this.state.getWebSockets().length >= MAX_CONNECTIONS) {
      return plainResponse(409, "Room full");
    }
    const origin = request.headers.get("origin");
    const serviceOrigin = request.headers.get("x-service-origin");
    if (!origin || !serviceOrigin) return plainResponse(403, "Forbidden");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      version: 1,
      role: "unauthenticated",
      origin,
      serviceOrigin,
      connectedAtMs: now,
      rateWindowMs: now,
      rateCount: 0,
      staleMotionCount: 0,
    } satisfies SocketAttachment);
    this.scheduleTransientTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(
    socket: WebSocket,
    frame: string | ArrayBuffer,
    arrivedAtMs: number,
  ): Promise<void> {
    const room = this.room;
    const attachment = attachmentOf(socket);
    if (!room || !attachment || room.status === "closed") {
      this.closeSocket(socket, "room_unavailable");
      return;
    }
    const now = Date.now();
    if (
      now >= room.expiresAtMs ||
      (room.status === "waiting" && now >= room.pairDeadlineMs)
    ) {
      await this.terminateRoom("room_expired");
      return;
    }
    if (
      [...this.notificationDeliveries.values()].some(
        (deadline) => arrivedAtMs >= deadline,
      )
    ) {
      await this.terminateRoom("delivery_timeout");
      return;
    }
    if (!this.consumeRate(socket, attachment, now)) {
      await this.protocolViolation(socket, "rate_limit");
      return;
    }

    let value: unknown;
    try {
      value = parseTextFrame(frame);
    } catch {
      await this.protocolViolation(socket, "invalid_message");
      return;
    }

    if (Date.now() - arrivedAtMs > MAX_QUEUE_AGE_MS) {
      const motion =
        attachment.role === "phone" ? parsePhoneNotification(value) : null;
      if (motion?.kind === "motion") {
        attachment.staleMotionCount += 1;
        socket.serializeAttachment(attachment);
        if (attachment.staleMotionCount < MAX_CONSECUTIVE_STALE_MOTION) return;
      }
      await this.protocolViolation(socket, "event_backlog");
      return;
    }
    if (attachment.staleMotionCount !== 0) {
      attachment.staleMotionCount = 0;
      socket.serializeAttachment(attachment);
    }

    if (attachment.role === "unauthenticated") {
      await this.authenticate(socket, attachment, value);
      return;
    }
    if (attachment.role === "owner") {
      await this.handleOwner(socket, value);
      return;
    }
    if (attachment.role === "pending-phone") {
      await this.protocolViolation(socket, "approval_required");
      return;
    }
    await this.handlePhone(socket, value, arrivedAtMs);
  }

  private consumeRate(
    socket: WebSocket,
    attachment: SocketAttachment,
    now: number,
  ): boolean {
    if (now - attachment.rateWindowMs >= 1_000) {
      attachment.rateWindowMs = now;
      attachment.rateCount = 0;
    }
    attachment.rateCount += 1;
    socket.serializeAttachment(attachment);
    const limit =
      attachment.role === "phone"
        ? PHONE_MESSAGES_PER_SECOND
        : attachment.role === "owner"
          ? OWNER_MESSAGES_PER_SECOND
          : UNAUTHENTICATED_MESSAGES_PER_SECOND;
    return attachment.rateCount <= limit;
  }

  private async authenticate(
    socket: WebSocket,
    attachment: SocketAttachment,
    value: unknown,
  ): Promise<void> {
    const owner = parseOwnerAuth(value);
    if (owner) {
      const origins = parseOwnerOrigins(this.workerEnv.ALLOWED_OWNER_ORIGINS);
      if (!origins?.has(attachment.origin) || this.findSocket("owner")) {
        this.closeSocket(socket, "owner_rejected");
        return;
      }
      const tokenHash = await sha256Hex(owner.token);
      if (!this.room || !(await secretsEqual(tokenHash, this.room.ownerTokenHash))) {
        this.closeSocket(socket, "owner_rejected");
        return;
      }
      attachment.role = "owner";
      attachment.deliveryIds = [];
      attachment.pendingOperationIds = [];
      socket.serializeAttachment(attachment);
      this.scheduleTransientTimer();
      const pending = this.findSocket("pending-phone");
      const pendingAttachment = pending ? attachmentOf(pending) : null;
      if (
        pending &&
        pendingAttachment?.claimId &&
        pendingAttachment.challenge &&
        !this.sendJson(socket, {
          v: 1,
          type: "claim",
          claimId: pendingAttachment.claimId,
          challenge: pendingAttachment.challenge,
        })
      ) {
        await this.terminateRoom("slow_peer");
      }
      return;
    }

    const phone = parsePhoneAuth(value);
    if (!phone || attachment.origin !== attachment.serviceOrigin) {
      this.closeSocket(socket, "phone_rejected");
      return;
    }
    if (this.findSocket("pending-phone") || this.findSocket("phone")) {
      this.closeSocket(socket, "phone_rejected");
      return;
    }
    attachment.role = "pending-phone";
    attachment.claimId = randomHex(16);
    attachment.challenge = randomChallenge();
    socket.serializeAttachment(attachment);
    this.scheduleTransientTimer();
    if (
      !this.sendJson(socket, {
        v: 1,
        type: "awaiting",
        challenge: attachment.challenge,
      })
    ) {
      await this.terminateRoom("slow_peer");
      return;
    }
    const ownerSocket = this.findSocket("owner");
    if (
      ownerSocket &&
      !this.sendJson(ownerSocket, {
        v: 1,
        type: "claim",
        claimId: attachment.claimId,
        challenge: attachment.challenge,
      })
    ) {
      await this.terminateRoom("slow_peer");
    }
  }

  private async handleOwner(socket: WebSocket, value: unknown): Promise<void> {
    const received = parseOwnerReceived(value);
    if (received) {
      await this.acknowledgeDelivery(socket, received.id);
      return;
    }
    const approval = parseOwnerApproval(value);
    if (approval) {
      const phoneSocket = this.findSocket("pending-phone");
      const phoneAttachment = phoneSocket ? attachmentOf(phoneSocket) : null;
      if (
        !phoneSocket ||
        !phoneAttachment ||
        phoneAttachment.claimId !== approval.claimId ||
        !this.room ||
        this.room.pairedOnce
      ) {
        await this.protocolViolation(socket, "invalid_approval");
        return;
      }
      phoneAttachment.role = "phone";
      delete phoneAttachment.claimId;
      delete phoneAttachment.challenge;
      phoneSocket.serializeAttachment(phoneAttachment);
      this.room.status = "paired";
      this.room.pairedOnce = true;
      await this.persistRoom();
      await this.scheduleLifecycleAlarm();
      this.scheduleTransientTimer();
      const paired = { v: 1, type: "paired", generation: 1 } as const;
      if (!this.sendJson(socket, paired) || !this.sendJson(phoneSocket, paired)) {
        await this.terminateRoom("slow_peer");
      }
      return;
    }

    const operation = parseOwnerOperation(value);
    const phoneSocket = this.findSocket("phone");
    if (!operation || !phoneSocket || !this.room || this.room.status !== "paired") {
      await this.protocolViolation(socket, "invalid_operation");
      return;
    }
    const now = Date.now();
    this.prunePending(now);
    if (
      this.pendingOperations.size >= MAX_PENDING_OPERATIONS ||
      this.pendingOperations.has(operation.id)
    ) {
      await this.protocolViolation(socket, "operation_backlog");
      return;
    }
    this.pendingOperations.set(operation.id, now + OPERATION_TIMEOUT_MS);
    this.updateOwnerTransientIds();
    this.scheduleTransientTimer();
    if (!this.sendJson(phoneSocket, operation)) {
      await this.terminateRoom("slow_peer");
    }
  }

  private async handlePhone(
    socket: WebSocket,
    value: unknown,
    arrivedAtMs: number,
  ): Promise<void> {
    const reply = parsePhoneReply(value);
    const notification = reply ? null : parsePhoneNotification(value);
    const ownerSocket = this.findSocket("owner");
    if ((!reply && !notification) || !ownerSocket || !this.room) {
      await this.protocolViolation(socket, "invalid_phone_message");
      return;
    }
    if (reply) {
      this.prunePending(arrivedAtMs);
      if (!this.pendingOperations.has(reply.id)) {
        await this.protocolViolation(socket, "unknown_operation");
        return;
      }
      this.pendingOperations.delete(reply.id);
      this.updateOwnerTransientIds();
      this.scheduleTransientTimer();
    }
    if (notification) {
      await this.forwardNotification(ownerSocket, notification, arrivedAtMs);
      return;
    }
    if (!this.sendJson(ownerSocket, reply)) {
      await this.terminateRoom("slow_peer");
    }
  }

  private async forwardNotification(
    ownerSocket: WebSocket,
    notification: PhoneNotification,
    arrivedAtMs: number,
  ): Promise<void> {
    if (!this.room) return;
    if (this.notificationDeliveries.size >= NOTIFICATION_DELIVERY_WINDOW) {
      if (notification.kind === "motion") {
        this.latestMotion = { notification, arrivedAtMs };
      } else {
        if (
          this.pendingStatuses.length >= MAX_PENDING_STATUS_NOTIFICATIONS
        ) {
          await this.terminateRoom("delivery_backlog");
          return;
        }
        this.pendingStatuses.push({ notification, arrivedAtMs });
        this.scheduleTransientTimer();
      }
      return;
    }
    const id = randomHex(16);
    this.notificationDeliveries.set(
      id,
      Date.now() + DELIVERY_ACK_TIMEOUT_MS,
    );
    this.updateOwnerTransientIds();
    if (!this.sendJson(ownerSocket, { ...notification, deliveryId: id })) {
      await this.terminateRoom("slow_peer");
      return;
    }
    this.scheduleTransientTimer();
  }

  private async acknowledgeDelivery(
    ownerSocket: WebSocket,
    deliveryId: string,
  ): Promise<void> {
    if (
      !this.room ||
      this.room.status !== "paired" ||
      !this.notificationDeliveries.has(deliveryId)
    ) {
      await this.protocolViolation(ownerSocket, "invalid_delivery_ack");
      return;
    }
    this.notificationDeliveries.delete(deliveryId);
    this.updateOwnerTransientIds();
    const pendingStatus = this.pendingStatuses[0];
    if (pendingStatus) {
      if (
        pendingStatus.arrivedAtMs + MAX_QUEUE_AGE_MS <= Date.now()
      ) {
        await this.terminateRoom("delivery_backlog");
        return;
      }
      this.pendingStatuses.shift();
      await this.forwardNotification(
        ownerSocket,
        pendingStatus.notification,
        pendingStatus.arrivedAtMs,
      );
      return;
    }
    const latest = this.latestMotion;
    this.latestMotion = null;
    if (latest && Date.now() - latest.arrivedAtMs <= MOTION_STALE_MS) {
      await this.forwardNotification(
        ownerSocket,
        latest.notification,
        latest.arrivedAtMs,
      );
      return;
    }
    this.scheduleTransientTimer();
  }

  private findSocket(role: SocketRole): WebSocket | null {
    return (
      this.state
        .getWebSockets()
        .find((socket) => attachmentOf(socket)?.role === role) ?? null
    );
  }

  private sendJson(socket: WebSocket, value: unknown): boolean {
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  private async protocolViolation(socket: WebSocket, code: string): Promise<void> {
    const attachment = attachmentOf(socket);
    if (attachment && attachment.role !== "unauthenticated") {
      await this.terminateRoom(code);
    } else {
      this.closeSocket(socket, code);
    }
  }

  private closeSocket(socket: WebSocket, code: string): void {
    this.sendJson(socket, { v: 1, type: "error", code });
    try {
      socket.close(4008, code.slice(0, 64));
    } catch {
      // The peer may already be gone; room cleanup is handled by the close event.
    }
  }

  private async closeSockets(code: string): Promise<void> {
    for (const socket of this.state.getWebSockets()) this.closeSocket(socket, code);
  }

  private async terminateRoom(code: string): Promise<void> {
    if (!this.room || this.room.status === "closed") return;
    this.room.status = "closed";
    this.pendingOperations.clear();
    this.notificationDeliveries.clear();
    this.pendingStatuses.length = 0;
    this.latestMotion = null;
    this.clearTransientTimer();
    this.updateOwnerTransientIds();
    await this.persistRoom();
    await this.closeSockets(code);
    await this.scheduleLifecycleAlarm();
  }

  private prunePending(now: number): void {
    let changed = false;
    for (const [id, deadline] of this.pendingOperations) {
      if (deadline <= now) {
        this.pendingOperations.delete(id);
        changed = true;
      }
    }
    if (changed) this.updateOwnerTransientIds();
  }

  private updateOwnerTransientIds(): void {
    const owner = this.findSocket("owner");
    const attachment = owner ? attachmentOf(owner) : null;
    if (!owner || !attachment) return;
    attachment.deliveryIds = [...this.notificationDeliveries.keys()];
    attachment.pendingOperationIds = [...this.pendingOperations.keys()];
    owner.serializeAttachment(attachment);
  }

  private clearTransientTimer(): void {
    if (this.transientTimer !== null) clearTimeout(this.transientTimer);
    this.transientTimer = null;
  }

  private scheduleTransientTimer(): void {
    this.clearTransientTimer();
    const deadlines = [
      ...this.notificationDeliveries.values(),
      ...this.pendingOperations.values(),
      ...this.pendingStatuses.map(
        ({ arrivedAtMs }) => arrivedAtMs + MAX_QUEUE_AGE_MS,
      ),
    ];
    for (const socket of this.state.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (attachment?.role === "unauthenticated") {
        const deadline = attachment.connectedAtMs + AUTH_TIMEOUT_MS;
        if (deadline > Date.now()) deadlines.push(deadline);
      }
    }
    if (deadlines.length === 0) return;
    const delay = Math.max(0, Math.min(...deadlines) - Date.now());
    this.transientTimer = setTimeout(() => {
      this.transientTimer = null;
      void this.enqueue(() => this.handleTransientDeadlines()).catch(() => {
        for (const socket of this.state.getWebSockets()) {
          this.closeSocket(socket, "internal_error");
        }
      });
    }, delay);
  }

  private async handleTransientDeadlines(): Promise<void> {
    const now = Date.now();
    if (
      [...this.notificationDeliveries.values()].some(
        (deadline) => deadline <= now,
      )
    ) {
      await this.terminateRoom("delivery_timeout");
      return;
    }
    if (
      this.pendingStatuses.some(
        ({ arrivedAtMs }) => arrivedAtMs + MAX_QUEUE_AGE_MS <= now,
      )
    ) {
      await this.terminateRoom("delivery_backlog");
      return;
    }
    this.prunePending(now);
    for (const socket of this.state.getWebSockets()) {
      const attachment = attachmentOf(socket);
      if (
        attachment?.role === "unauthenticated" &&
        attachment.connectedAtMs + AUTH_TIMEOUT_MS <= now
      ) {
        this.closeSocket(socket, "auth_timeout");
      }
    }
    this.scheduleTransientTimer();
  }

  private async persistRoom(): Promise<void> {
    if (this.room) {
      this.persistenceWrites += 1;
      await this.state.storage.put(ROOM_KEY, this.room);
    }
  }

  private async scheduleLifecycleAlarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.alarmWrites += 1;
    await this.state.storage.setAlarm(
      room.status === "waiting" ? room.pairDeadlineMs : room.expiresAtMs,
    );
  }
}
