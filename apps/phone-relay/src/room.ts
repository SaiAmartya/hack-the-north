import { DurableObject } from "cloudflare:workers";
import { parsePhoneMessage, type PhoneData, type PhoneIssueCode, type PhoneMessage, type PhoneRole, type PhoneRoute } from "../../../shared/phone-v2";
import { isRoomInit, plainResponse, readJsonWithLimit, type Env } from "./index";
import { parseOwnerOrigins, randomChallenge, randomHex, secretsEqual, sha256Hex } from "./protocol";

const KEY = "room";
const RESUME_MS = 30_000;
const AUTH_MS = 5_000;
const QUEUE_MS = 100;
const PROGRESS_MS = 1_000;
const MAX_EVENTS = 32;
const MAX_FRAME = 24_576;
type Role = PhoneRole | "pending-phone" | "unauthenticated" | "retired";
type Room = {
  version: 2;
  roomId: string;
  ownerTokenHash: string;
  createdAtMs: number;
  pairDeadlineMs: number;
  expiresAtMs: number;
  status: "waiting" | "paired" | "recovering" | "closed";
  generation: number;
  route: PhoneRoute;
  resumeUntilMs?: number;
  ownerResumeHash?: string;
  phoneResumeHash?: string;
};
type Attachment = {
  version: 2; role: Role; origin: string; serviceOrigin: string;
  connectedAtMs: number; rateWindowMs: number; rateCount: number;
  claimId?: string; challenge?: string; outstanding?: boolean;
  signalGeneration?: number; signalCount?: number;
};
type QueuedMotion = { data: Extract<PhoneData, { kind: "motion" }>; arrivedAtMs: number };
function attachment(socket: WebSocket): Attachment | null {
  const a = socket.deserializeAttachment() as Attachment | null;
  return a?.version === 2 && ["owner", "phone", "pending-phone", "unauthenticated", "retired"].includes(a.role) ? a : null;
}

export class PairRoom extends DurableObject<Env> {
  private room: Room | null = null;
  private serial: Promise<void> = Promise.resolve();
  private queuedMessages = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly operations = new Map<string, number>();
  private readonly motion = new Map<number, number>();
  private readonly statuses = new Map<string, number>();
  private latestMotion: QueuedMotion | null = null;
  private highestMotion = 0;
  private acknowledgedMotion = 0;
  private lastProgressMs = 0;
  private lastMotionProgressMs = 0;
  private persistenceWrites = 0;
  private alarmWrites = 0;

  constructor(private readonly state: DurableObjectState, private readonly workerEnv: Env) {
    super(state, workerEnv);
    state.setHibernatableWebSocketEventTimeout(1_000);
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<Room | { version: 1 }>(KEY);
      if (stored?.version === 2) this.room = stored;
      else if (stored) {
        for (const socket of state.getWebSockets()) this.close(socket, "protocol_version");
        await state.storage.deleteAll();
      }
      if (this.room?.status === "paired" && this.room.route === "relay" && state.getWebSockets().some(s => attachment(s)?.outstanding)) {
        await this.recover("network", true);
      }
      this.scheduleTimer();
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.enqueue(async () => {
      const auth = request.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !this.workerEnv.PAIR_CREATE_SECRET || !await secretsEqual(auth.slice(7), this.workerEnv.PAIR_CREATE_SECRET)) return plainResponse(403, "Forbidden");
      const path = new URL(request.url).pathname;
      if (path === "/init" && request.method === "POST") {
        if (this.room) return plainResponse(409, "Room exists");
        let init: unknown;
        try { init = await readJsonWithLimit(request, 512); } catch { return plainResponse(400, "Invalid request"); }
        if (!isRoomInit(init)) return plainResponse(400, "Invalid request");
        this.room = { version: 2, roomId: init.roomId, ownerTokenHash: await sha256Hex(init.ownerToken), createdAtMs: init.createdAtMs, pairDeadlineMs: init.pairDeadlineMs, expiresAtMs: init.expiresAtMs, status: "waiting", generation: 1, route: "direct" };
        await this.persist();
        return new Response(null, { status: 204 });
      }
      if (path !== "/connect" || request.method !== "GET") return plainResponse(404);
      if (!this.room || this.expired(Date.now()) || this.room.status === "closed") return plainResponse(410, "Room unavailable");
      // Two authenticated peers plus two short-lived replacement/authentication slots.
      if (this.sockets().length >= 4) return plainResponse(409, "Room full");
      const origin = request.headers.get("origin"), serviceOrigin = request.headers.get("x-service-origin");
      if (!origin || !serviceOrigin) return plainResponse(403, "Forbidden");
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ version: 2, role: "unauthenticated", origin, serviceOrigin, connectedAtMs: Date.now(), rateWindowMs: Date.now(), rateCount: 0 } satisfies Attachment);
      this.scheduleTimer();
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    const arrivedAtMs = Date.now();
    if (typeof frame !== "string" || new TextEncoder().encode(frame).byteLength > MAX_FRAME) {
      this.close(socket, "invalid_message");
      return this.webSocketClose(socket);
    }
    if (this.queuedMessages >= MAX_EVENTS) {
      this.close(socket, "event_backlog");
      return this.webSocketClose(socket);
    }
    this.queuedMessages++;
    return this.enqueue(() => this.message(socket, frame, arrivedAtMs)).finally(() => { this.queuedMessages--; });
  }

  webSocketClose(socket: WebSocket): Promise<void> {
    return this.enqueue(async () => {
      const a = attachment(socket);
      if (!a || a.role === "retired") return;
      const role = a.role;
      a.role = "retired";
      socket.serializeAttachment(a);
      if (role === "owner" || role === "phone") {
        if (this.room?.status === "waiting") await this.terminate("peer_disconnected");
        else await this.recover("network", false);
      }
      this.scheduleTimer();
    });
  }

  webSocketError(socket: WebSocket): Promise<void> { return this.webSocketClose(socket); }
  alarm(): Promise<void> {
    return this.enqueue(async () => {
      if (this.room && this.expired(Date.now())) await this.terminate(this.expiryCode(Date.now()));
      if (this.room && Date.now() >= this.room.expiresAtMs) { this.room = null; await this.state.storage.deleteAll(); }
      else await this.scheduleAlarm();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
  private expired(now: number): boolean {
    const r = this.room;
    return !r || now >= r.expiresAtMs || (r.status === "waiting" && now >= r.pairDeadlineMs) || (r.status === "recovering" && now >= (r.resumeUntilMs ?? 0));
  }
  private sockets(): WebSocket[] { return this.state.getWebSockets().filter(s => attachment(s)?.role !== "retired"); }
  private expiryCode(now: number): string {
    const r = this.room;
    // Revoke future signalling/resume after grace, not an established direct
    // peer channel whose independently enforced absolute deadline is later.
    return r?.route === "direct" && r.status === "recovering" && now < r.expiresAtMs
      ? "signalling-expired" : "expired";
  }
  private peer(role: Role): WebSocket | undefined { return this.sockets().find(s => attachment(s)?.role === role); }
  private send(socket: WebSocket | undefined, message: PhoneMessage): boolean {
    if (!socket) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  private broadcast(message: PhoneMessage): void {
    this.send(this.peer("owner"), message); this.send(this.peer("phone"), message);
  }
  private close(socket: WebSocket, code: string): void {
    this.send(socket, { v: 2, type: "error", code });
    try { socket.close(4008, code.slice(0, 64)); } catch { /* Already closed. */ }
  }
  private clearLink(): void {
    this.operations.clear(); this.motion.clear(); this.statuses.clear(); this.latestMotion = null;
    this.highestMotion = 0; this.acknowledgedMotion = 0; this.lastProgressMs = Date.now(); this.lastMotionProgressMs = Date.now();
    this.markOutstanding();
  }
  private markOutstanding(): void {
    const socket = this.peer("owner"), a = socket ? attachment(socket) : null;
    if (socket && a) { a.outstanding = !!(this.operations.size || this.motion.size || this.statuses.size); socket.serializeAttachment(a); }
  }
  private async persist(): Promise<void> {
    if (this.room) { this.persistenceWrites++; await this.state.storage.put(KEY, this.room); }
    await this.scheduleAlarm();
  }
  private async scheduleAlarm(): Promise<void> {
    if (!this.room) return;
    this.alarmWrites++;
    const r = this.room;
    await this.state.storage.setAlarm(r.status === "waiting" ? r.pairDeadlineMs : r.status === "recovering" ? Math.min(r.resumeUntilMs ?? r.expiresAtMs, r.expiresAtMs) : r.expiresAtMs);
  }

  private async message(socket: WebSocket, text: string, arrivedAtMs: number): Promise<void> {
    const a = attachment(socket), r = this.room;
    if (!a || a.role === "retired") return;
    if (!r || r.status === "closed" || this.expired(arrivedAtMs)) { const code = this.expiryCode(arrivedAtMs); await this.terminate(code); this.close(socket, code); return; }
    if (arrivedAtMs - a.rateWindowMs >= 1_000) { a.rateWindowMs = arrivedAtMs; a.rateCount = 0; }
    a.rateCount++;
    socket.serializeAttachment(a);
    const limit = a.role === "phone" ? 100 : a.role === "owner" ? 150 : 24;
    if (a.rateCount > limit) { this.close(socket, "rate_limit"); await this.disconnectForFault(socket); return; }
    let message: PhoneMessage;
    try { message = parsePhoneMessage(text); } catch { this.close(socket, "protocol_version"); await this.disconnectForFault(socket); return; }
    if (a.role === "unauthenticated") { await this.authenticate(socket, a, message); return; }
    if (message.type === "leave") {
      if (a.role === "owner" || a.role === "phone") await this.terminate("left");
      else { a.role = "retired"; socket.serializeAttachment(a); this.close(socket, "left"); }
      return;
    }
    if (message.type === "approve" && a.role === "owner" && r.status === "waiting") { await this.approve(socket, message.claimId); return; }
    if (a.role === "pending-phone") { this.close(socket, "approval_required"); return; }
    if (a.role !== "owner" && a.role !== "phone") return;
    if (!("generation" in message) || message.generation !== r.generation) return;
    // A missing signalling peer must not prevent the owner invalidating a
    // failed direct link. Establishment waits until both roles have resumed.
    if (a.role === "owner" && (message.type === "reset-link" || message.type === "route" && message.route === "relay")) {
      if (Date.now() - arrivedAtMs > QUEUE_MS) { await this.recover("congestion", true); return; }
      if (message.type === "reset-link" || r.route !== "relay") {
        r.generation++; if (message.type === "route") r.route = "relay";
        this.clearLink(); await this.persist();
      }
      if (r.status === "paired") {
        if (message.type === "route") this.broadcast({ v: 2, type: "route", route: r.route, generation: r.generation });
        else this.paired(true);
      } else this.broadcast({ v: 2, type: "recovering", code: "network", generation: r.generation, route: r.route, resumeUntilMs: r.resumeUntilMs ?? r.expiresAtMs });
      return;
    }
    if (r.status !== "paired") return;
    if (Date.now() - arrivedAtMs > QUEUE_MS) {
      if (message.type === "data" && message.kind === "motion") return;
      await this.recover("congestion", true); return;
    }
    if (message.type === "signal" && r.route === "direct") {
      if (a.signalGeneration !== r.generation) { a.signalGeneration = r.generation; a.signalCount = 0; }
      a.signalCount = (a.signalCount ?? 0) + 1; socket.serializeAttachment(a);
      if (a.signalCount > 64) { await this.terminate("signal_limit"); return; }
      if ((message.signal.type === "offer" && a.role !== "owner") || (message.signal.type === "answer" && a.role !== "phone")) { await this.terminate("invalid_signal"); return; }
      if (!this.send(this.peer(a.role === "owner" ? "phone" : "owner"), message)) await this.recover("network", false);
      return;
    }
    if (message.type !== "data" || r.route !== "relay") { await this.terminate("invalid_message"); return; }
    await this.data(socket, a.role, message, arrivedAtMs);
  }

  private async disconnectForFault(socket: WebSocket): Promise<void> {
    const a = attachment(socket);
    if (!a) return;
    const authenticated = a.role === "owner" || a.role === "phone";
    a.role = "retired"; socket.serializeAttachment(a);
    if (authenticated) await this.recover("protocol", false);
  }
  private async authenticate(socket: WebSocket, a: Attachment, m: PhoneMessage): Promise<void> {
    const r = this.room;
    if (!r) return;
    if (m.type === "resume") {
      const allowed = m.role === "owner" ? parseOwnerOrigins(this.workerEnv.ALLOWED_OWNER_ORIGINS)?.has(a.origin) : a.origin === a.serviceOrigin;
      const hash = m.role === "owner" ? r.ownerResumeHash : r.phoneResumeHash;
      if (!allowed || !hash || r.status === "waiting" || this.peer(m.role) || !await secretsEqual(await sha256Hex(m.token), hash)) { this.close(socket, "resume_rejected"); return; }
      a.role = m.role; socket.serializeAttachment(a);
      if (this.peer("owner") && this.peer("phone")) {
        r.status = "paired"; delete r.resumeUntilMs; await this.persist();
        this.paired(true);
      } else this.send(socket, { v: 2, type: "recovering", generation: r.generation, code: "network", route: r.route, resumeUntilMs: r.resumeUntilMs ?? r.expiresAtMs });
      this.scheduleTimer(); return;
    }
    if (r.status !== "waiting") { this.close(socket, "resume_required"); return; }
    if (m.type === "owner") {
      if (!parseOwnerOrigins(this.workerEnv.ALLOWED_OWNER_ORIGINS)?.has(a.origin) || this.peer("owner") || !await secretsEqual(await sha256Hex(m.token), r.ownerTokenHash)) { this.close(socket, "owner_rejected"); return; }
      a.role = "owner"; socket.serializeAttachment(a);
      const pending = this.peer("pending-phone"), p = pending ? attachment(pending) : null;
      if (p?.claimId && p.challenge) this.send(socket, { v: 2, type: "claim", claimId: p.claimId, challenge: p.challenge });
    } else if (m.type === "phone" && a.origin === a.serviceOrigin && !this.peer("phone") && !this.peer("pending-phone")) {
      a.role = "pending-phone"; a.claimId = randomHex(16); a.challenge = randomChallenge(); socket.serializeAttachment(a);
      this.send(socket, { v: 2, type: "awaiting", challenge: a.challenge });
      this.send(this.peer("owner"), { v: 2, type: "claim", claimId: a.claimId, challenge: a.challenge });
    } else this.close(socket, "authentication_rejected");
    this.scheduleTimer();
  }
  private async approve(owner: WebSocket, claimId: string): Promise<void> {
    const phone = this.peer("pending-phone"), p = phone ? attachment(phone) : null, r = this.room;
    if (!phone || !p || p.claimId !== claimId || !r) { await this.terminate("invalid_approval"); return; }
    const ownerToken = randomHex(32), phoneToken = randomHex(32);
    r.ownerResumeHash = await sha256Hex(ownerToken); r.phoneResumeHash = await sha256Hex(phoneToken);
    r.status = "paired";
    p.role = "phone"; delete p.claimId; delete p.challenge; phone.serializeAttachment(p);
    this.clearLink(); await this.persist();
    const common = { v: 2, type: "paired", generation: r.generation, expiresAtMs: r.expiresAtMs, route: r.route, resumed: false } as const;
    this.send(owner, { ...common, resumeToken: ownerToken }); this.send(phone, { ...common, resumeToken: phoneToken });
    this.scheduleTimer();
  }
  private paired(resumed: boolean): void {
    const r = this.room;
    if (r) this.broadcast({ v: 2, type: "paired", generation: r.generation, expiresAtMs: r.expiresAtMs, route: r.route, resumed });
  }

  private async data(socket: WebSocket, role: PhoneRole, m: PhoneData, arrivedAtMs: number): Promise<void> {
    if (!this.room) return;
    const ownerKind = ["begin-link", "op", "receipt", "coaching", "issue"].includes(m.kind);
    if ((role === "owner") !== ownerKind && m.kind !== "issue") { await this.terminate("invalid_direction"); return; }
    const target = this.peer(role === "owner" ? "phone" : "owner");
    if (!target) { await this.recover("network", false); return; }
    if (m.kind === "receipt") {
      if (m.through > this.highestMotion) { await this.terminate("invalid_receipt"); return; }
      let advanced = false;
      for (const seq of this.motion.keys()) if (seq <= m.through) { this.motion.delete(seq); advanced = true; this.lastMotionProgressMs = arrivedAtMs; }
      this.acknowledgedMotion = Math.max(this.acknowledgedMotion, m.through);
      for (const id of m.statusIds) if (this.statuses.delete(id)) advanced = true;
      if (advanced) this.lastProgressMs = arrivedAtMs;
      if (!this.send(target, m)) { await this.recover("network", true); return; }
      this.flushMotion();
    } else if (m.kind === "motion") {
      if (m.sequence <= this.highestMotion || m.sequence <= this.acknowledgedMotion || m.sequence <= (this.latestMotion?.data.sequence ?? 0)) return;
      if (this.motion.size >= 8) this.latestMotion = { data: m, arrivedAtMs };
      else this.forwardMotion(m);
    } else if (m.kind === "status") {
      if (this.statuses.has(m.id)) return;
      if (this.statuses.size >= 4) { await this.recover("congestion", true); return; }
      this.startProgress(); this.statuses.set(m.id, Date.now());
      if (!this.send(target, m)) { await this.recover("network", true); return; }
    } else if (m.kind === "op" || m.kind === "begin-link") {
      if (this.operations.size >= 4 || this.operations.has(m.id)) { await this.recover("congestion", true); return; }
      this.startProgress(); this.operations.set(m.id, Date.now() + 1_500);
      if (!this.send(target, m)) { await this.recover("network", true); return; }
    } else if (m.kind === "reply" || m.kind === "begun") {
      const deadline = this.operations.get(m.id);
      if (!deadline || arrivedAtMs >= deadline) return;
      this.operations.delete(m.id); this.lastProgressMs = arrivedAtMs;
      if (!this.send(target, m)) { await this.recover("network", true); return; }
    } else if (!this.send(target, m)) { await this.recover("network", true); return; }
    this.markOutstanding(); this.scheduleTimer();
    void socket;
  }
  private startProgress(): void {
    if (!this.motion.size && !this.statuses.size && !this.operations.size) this.lastProgressMs = Date.now();
  }
  private forwardMotion(m: Extract<PhoneData, { kind: "motion" }>): void {
    if (!this.motion.size) this.lastMotionProgressMs = Date.now();
    this.startProgress(); this.highestMotion = m.sequence; this.motion.set(m.sequence, Date.now());
    if (!this.send(this.peer("owner"), m)) void this.enqueue(() => this.recover("network", true));
  }
  private flushMotion(): void {
    const latest = this.latestMotion;
    if (!latest || this.motion.size >= 8) return;
    this.latestMotion = null;
    if (Date.now() - latest.arrivedAtMs < QUEUE_MS && latest.data.sequence > this.highestMotion) this.forwardMotion(latest.data);
  }
  private async recover(code: PhoneIssueCode, closeConnections: boolean): Promise<void> {
    const r = this.room;
    if (!r || r.status === "closed" || r.status === "waiting") return;
    if (r.status !== "recovering") {
      r.status = "recovering"; r.resumeUntilMs = Math.min(Date.now() + RESUME_MS, r.expiresAtMs);
      if (r.route === "relay") r.generation++;
      this.clearLink(); await this.persist();
    }
    this.broadcast({ v: 2, type: "recovering", code, generation: r.generation, route: r.route, resumeUntilMs: r.resumeUntilMs ?? r.expiresAtMs });
    if (closeConnections) for (const s of this.sockets()) {
      const a = attachment(s); if (a) { a.role = "retired"; s.serializeAttachment(a); }
      try { s.close(4010, code); } catch { /* Already closed. */ }
    }
    this.scheduleTimer();
  }
  private async terminate(code: string): Promise<void> {
    if (!this.room || this.room.status === "closed") return;
    this.room.status = "closed"; delete this.room.ownerResumeHash; delete this.room.phoneResumeHash;
    this.clearLink(); await this.persist();
    for (const s of this.sockets()) { this.close(s, code); const a = attachment(s); if (a) { a.role = "retired"; s.serializeAttachment(a); } }
    this.scheduleTimer();
  }
  private scheduleTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const deadlines: number[] = [];
    for (const s of this.sockets()) { const a = attachment(s); if (a?.role === "unauthenticated") deadlines.push(a.connectedAtMs + AUTH_MS); }
    if (this.motion.size || this.statuses.size || this.operations.size) deadlines.push(this.lastProgressMs + PROGRESS_MS);
    if (this.motion.size) deadlines.push(this.lastMotionProgressMs + PROGRESS_MS);
    if (this.latestMotion) deadlines.push(this.latestMotion.arrivedAtMs + QUEUE_MS);
    if (!deadlines.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(async () => {
        const now = Date.now();
        if (this.latestMotion && now - this.latestMotion.arrivedAtMs >= QUEUE_MS) this.latestMotion = null;
        for (const s of this.sockets()) { const a = attachment(s); if (a?.role === "unauthenticated" && now >= a.connectedAtMs + AUTH_MS) { this.close(s, "auth_timeout"); a.role = "retired"; s.serializeAttachment(a); } }
        if (((this.motion.size || this.statuses.size || this.operations.size) && now >= this.lastProgressMs + PROGRESS_MS) || (this.motion.size && now >= this.lastMotionProgressMs + PROGRESS_MS)) await this.recover("congestion", true);
        this.scheduleTimer();
      });
    }, Math.max(1, Math.min(...deadlines) - Date.now()));
  }
}
