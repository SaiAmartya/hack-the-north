import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const worker = exports as unknown as { default: { fetch(request: Request): Promise<Response> } };
type Message = Record<string, unknown>;
type Pair = { roomId: string; ownerToken: string; expiresAtMs: number; socketUrl: string; phoneUrl: string };
class Peer {
  readonly messages: Message[] = [];
  private listeners: Array<(m: Message) => void> = [];
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as Message;
      const listener = this.listeners.shift();
      if (listener) listener(message); else this.messages.push(message);
    });
  }
  send(message: Message): void { this.socket.send(JSON.stringify(message)); }
  next(): Promise<Message> {
    const existing = this.messages.shift();
    return existing ? Promise.resolve(existing) : new Promise(resolve => this.listeners.push(resolve));
  }
}
async function create(): Promise<Pair> {
  const response = await worker.default.fetch(new Request("https://relay.example/api/rooms", { method: "POST", headers: { authorization: "Bearer test-only-pair-create-secret", "content-type": "application/json" }, body: "{}" }));
  expect(response.status).toBe(201);
  return await response.json() as Pair;
}
async function connect(pair: Pair, role: "owner" | "phone"): Promise<Peer> {
  const response = await worker.default.fetch(new Request(pair.socketUrl.replace(/^wss:/, "https:"), { headers: { origin: role === "owner" ? "https://laptop.example" : "https://relay.example", upgrade: "websocket" } }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept(); return new Peer(socket);
}
async function approved(relay = false) {
  const pair = await create(), owner = await connect(pair, "owner"), phone = await connect(pair, "phone");
  owner.send({ v: 2, type: "owner", token: pair.ownerToken });
  phone.send({ v: 2, type: "phone" });
  const claim = await owner.next(), awaiting = await phone.next();
  expect(claim).toMatchObject({ v: 2, type: "claim", challenge: expect.stringMatching(/^\d{6}$/) });
  expect(awaiting).toEqual({ v: 2, type: "awaiting", challenge: claim.challenge });
  owner.send({ v: 2, type: "approve", claimId: claim.claimId });
  const o = await owner.next(), p = await phone.next();
  expect(o).toMatchObject({ v: 2, type: "paired", generation: 1, route: "direct", resumed: false });
  expect(p.resumeToken).not.toBe(o.resumeToken);
  let generation = 1;
  if (relay) {
    owner.send({ v: 2, type: "route", generation, route: "relay" });
    expect(await owner.next()).toEqual({ v: 2, type: "route", generation: 2, route: "relay" });
    expect(await phone.next()).toEqual({ v: 2, type: "route", generation: 2, route: "relay" });
    generation = 2;
  }
  return { pair, owner, phone, generation, ownerToken: o.resumeToken as string, phoneToken: p.resumeToken as string };
}
function data(generation: number, rest: Message): Message { return { v: 2, type: "data", generation, ...rest }; }
const bytes = Array.from({ length: 20 }, (_, i) => i);
async function room<T>(pair: Pair, action: (instance: unknown) => T | Promise<T>): Promise<T> {
  const rooms = (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS;
  return runInDurableObject(rooms.get(rooms.idFromName(pair.roomId)), action);
}
async function leave(owner: Peer): Promise<void> { owner.send({ v: 2, type: "leave" }); await owner.next(); }

describe("phone v2 Worker boundary", () => {
  it("requires private creation auth, exact origins, and isolates assets", async () => {
    expect((await worker.default.fetch(new Request("https://relay.example/api/rooms", { method: "POST", body: "{}" }))).status).toBe(401);
    const pair = await create();
    expect(pair.phoneUrl).toBe(`https://relay.example/phone?room=${pair.roomId}`);
    expect(pair.phoneUrl).not.toContain(pair.ownerToken);
    expect((await worker.default.fetch(new Request(pair.socketUrl.replace(/^wss:/, "https:"), { headers: { origin: "https://attacker.example", upgrade: "websocket" } }))).status).toBe(403);
    for (const path of ["/api/speech/health", "/ws/game", "/__qa/game", "/@vite/client", "/src/main.tsx"]) expect((await worker.default.fetch(new Request(`https://relay.example${path}`))).status).toBe(404);
  });
  it("rejects v1 explicitly instead of silently reinterpreting its session", async () => {
    const pair = await create(), owner = await connect(pair, "owner");
    owner.send({ v: 1, type: "owner", token: pair.ownerToken });
    expect(await owner.next()).toEqual({ v: 2, type: "error", code: "protocol_version" });
  });
  it("requires matching approval and rejects extra authority fields", async () => {
    const pair = await create(), phone = await connect(pair, "phone");
    phone.send({ v: 2, type: "phone", admin: true });
    expect(await phone.next()).toMatchObject({ type: "error", code: "protocol_version" });
  });
  it("forwards bounded direct signaling without accepting data on the cloud route", async () => {
    const { owner, phone, generation } = await approved();
    const signal = { v: 2, type: "signal", generation, signal: { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" } };
    owner.send(signal); expect(await phone.next()).toEqual(signal);
    phone.send(data(generation, { kind: "motion", sequence: 1, records: [bytes] }));
    expect(await owner.next()).toMatchObject({ type: "error", code: "invalid_message" });
  });
  it("rejects a phone offer and preserves signal direction", async () => {
    const { owner, phone, generation } = await approved();
    phone.send({ v: 2, type: "signal", generation, signal: { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" } });
    expect(await owner.next()).toMatchObject({ type: "error", code: "invalid_signal" });
  });
  it("forwards exact control records/replies and independent status receipts", async () => {
    const { owner, phone, generation } = await approved(true);
    const op = data(generation, { kind: "op", id: "control-1", operation: "control", data: bytes });
    owner.send(op); expect(await phone.next()).toEqual(op);
    const reply = data(generation, { kind: "reply", id: "control-1" });
    phone.send(reply); expect(await owner.next()).toEqual(reply);
    const status = data(generation, { kind: "status", id: "s1", data: bytes });
    phone.send(status); expect(await owner.next()).toEqual(status);
    const receipt = data(generation, { kind: "receipt", through: 0, statusIds: ["s1"] });
    owner.send(receipt); expect(await phone.next()).toEqual(receipt); await leave(owner);
  });
  it("reserves four control deliveries independently of eight outstanding motion batches", async () => {
    const { pair, owner, phone, generation } = await approved(true);
    for (let i = 1; i <= 8; i++) { const m = data(generation, { kind: "motion", sequence: i, records: [bytes, bytes] }); phone.send(m); expect(await owner.next()).toEqual(m); }
    for (let i = 1; i <= 4; i++) { const m = data(generation, { kind: "status", id: `s${i}`, data: bytes }); phone.send(m); expect(await owner.next()).toEqual(m); }
    expect(await room(pair, instance => { const r = instance as { motion: Map<number, number>; statuses: Map<string, number> }; return [r.motion.size, r.statuses.size]; })).toEqual([8, 4]);
    owner.send(data(generation, { kind: "receipt", through: 8, statusIds: ["s1", "s2", "s3", "s4"] })); await phone.next(); await leave(owner);
  });
  it("keeps only newest two unsent samples and cumulatively releases the window", async () => {
    const { owner, phone, generation } = await approved(true);
    for (let i = 1; i <= 8; i++) { phone.send(data(generation, { kind: "motion", sequence: i, records: [bytes] })); await owner.next(); }
    phone.send(data(generation, { kind: "motion", sequence: 9, records: [Array(20).fill(9)] }));
    phone.send(data(generation, { kind: "motion", sequence: 10, records: [Array(20).fill(10), Array(20).fill(11)] }));
    await scheduler.wait(10);
    owner.send(data(generation, { kind: "receipt", through: 8, statusIds: [] })); await phone.next();
    expect(await owner.next()).toMatchObject({ kind: "motion", sequence: 10, records: [Array(20).fill(10), Array(20).fill(11)] });
    owner.send(data(generation, { kind: "receipt", through: 10, statusIds: [] })); await phone.next(); await leave(owner);
  });
  it("discards expired unsent motion rather than catching up", async () => {
    const { owner, phone, generation } = await approved(true);
    for (let i = 1; i <= 8; i++) { phone.send(data(generation, { kind: "motion", sequence: i, records: [bytes] })); await owner.next(); }
    phone.send(data(generation, { kind: "motion", sequence: 9, records: [bytes] })); await scheduler.wait(120);
    owner.send(data(generation, { kind: "receipt", through: 8, statusIds: [] })); await phone.next();
    phone.send(data(generation, { kind: "motion", sequence: 10, records: [bytes] }));
    expect(await owner.next()).toMatchObject({ kind: "motion", sequence: 10 });
    owner.send(data(generation, { kind: "receipt", through: 10, statusIds: [] })); await phone.next(); await leave(owner);
  });
  it("ignores stale generations but rejects invalid cumulative receipts", async () => {
    const { owner, phone, generation } = await approved(true);
    phone.send(data(generation - 1, { kind: "motion", sequence: 99, records: [bytes] }));
    owner.send(data(generation, { kind: "receipt", through: 99, statusIds: [] }));
    expect(await owner.next()).toMatchObject({ type: "error", code: "invalid_receipt" });
  });
  it("resets a congested link after one second while retaining approved pairing", async () => {
    const { pair, owner, phone, generation, ownerToken, phoneToken } = await approved(true);
    phone.send(data(generation, { kind: "motion", sequence: 1, records: [bytes] })); await owner.next();
    expect(await owner.next()).toMatchObject({ type: "recovering", code: "congestion", generation: generation + 1 });
    expect(await phone.next()).toMatchObject({ type: "recovering" });
    const owner2 = await connect(pair, "owner"), phone2 = await connect(pair, "phone");
    owner2.send({ v: 2, type: "resume", role: "owner", token: ownerToken });
    expect(await owner2.next()).toMatchObject({ type: "recovering", generation: generation + 1 });
    phone2.send({ v: 2, type: "resume", role: "phone", token: phoneToken });
    expect(await phone2.next()).toMatchObject({ type: "paired", generation: generation + 1 });
    await owner2.next();
    phone2.send(data(generation + 1, { kind: "motion", sequence: 1, records: [bytes] })); expect(await owner2.next()).toMatchObject({ kind: "motion", sequence: 1 });
    owner2.send(data(generation + 1, { kind: "receipt", through: 1, statusIds: [] })); await phone2.next(); await leave(owner2);
  });
  it("retains direct generation through signaling loss and stores token hashes only", async () => {
    const { pair, owner, phone, generation, ownerToken, phoneToken } = await approved();
    const stored = await room(pair, instance => (instance as { room: unknown }).room);
    expect(JSON.stringify(stored)).not.toContain(ownerToken); expect(JSON.stringify(stored)).not.toContain(phoneToken);
    phone.socket.close(1000, "network-loss"); expect(await owner.next()).toMatchObject({ type: "recovering", route: "direct", generation });
    const phone2 = await connect(pair, "phone"); phone2.send({ v: 2, type: "resume", role: "phone", token: phoneToken });
    expect(await phone2.next()).toMatchObject({ type: "paired", generation, resumed: true }); await owner.next(); await leave(owner);
  });
  it("rejects duplicate roles and cross-role resume credentials", async () => {
    const { pair, owner, phone, phoneToken } = await approved();
    const duplicate = await connect(pair, "owner"); duplicate.send({ v: 2, type: "resume", role: "owner", token: phoneToken }); expect(await duplicate.next()).toMatchObject({ type: "error", code: "resume_rejected" });
    phone.socket.close(1000, "network-loss"); await owner.next();
    const wrong = await connect(pair, "phone"); wrong.send({ v: 2, type: "resume", role: "owner", token: phoneToken }); expect(await wrong.next()).toMatchObject({ type: "error", code: "resume_rejected" }); await leave(owner);
  });
  it("bounds recovery by thirty-second grace and absolute room expiry", async () => {
    const { pair, owner, phone } = await approved(); phone.socket.close(1000, "network-loss"); const recovering = await owner.next();
    expect(Number(recovering.resumeUntilMs) - Date.now()).toBeLessThanOrEqual(30_000);
    await room(pair, async instance => { const r = instance as { room: { resumeUntilMs: number }; alarm(): Promise<void> }; r.room.resumeUntilMs = Date.now() - 1; await r.alarm(); });
    expect(await owner.next()).toMatchObject({ type: "error", code: "signalling-expired" });
    expect((await worker.default.fetch(new Request(pair.socketUrl.replace(/^wss:/, "https:"), { headers: { origin: "https://relay.example", upgrade: "websocket" } }))).status).toBe(410);
  });
  it("intentional leave revokes pairing rather than entering recovery", async () => {
    const { pair, owner, phone } = await approved(); await leave(owner); expect(await phone.next()).toMatchObject({ type: "error", code: "left" });
    expect(await room(pair, instance => (instance as { room: unknown }).room)).toMatchObject({ status: "closed" });
    expect(JSON.stringify(await room(pair, instance => (instance as { room: unknown }).room))).not.toContain("ResumeHash");
  });
  it("can reset a direct link during one-sided signalling recovery", async () => {
    const { pair, owner, phone, phoneToken, generation } = await approved();
    phone.socket.close(1000, "network-loss"); await owner.next();
    owner.send({ v: 2, type: "reset-link", generation });
    expect(await owner.next()).toMatchObject({ type: "recovering", generation: generation + 1 });
    const phone2 = await connect(pair, "phone"); phone2.send({ v: 2, type: "resume", role: "phone", token: phoneToken });
    expect(await owner.next()).toMatchObject({ type: "paired", generation: generation + 1 });
    expect(await phone2.next()).toMatchObject({ type: "paired", generation: generation + 1 }); await leave(owner);
  });
  it("absolute expiry still revokes an established direct pair", async () => {
    const { pair, owner } = await approved();
    await room(pair, async instance => { const r = instance as { room: { expiresAtMs: number }; alarm(): Promise<void> }; r.room.expiresAtMs = Date.now() - 1; await r.alarm(); });
    expect(await owner.next()).toMatchObject({ type: "error", code: "expired" });
  });
  it("owner reset creates a fresh generation for both without fresh QR approval", async () => {
    const { owner, phone, generation } = await approved(); owner.send({ v: 2, type: "reset-link", generation });
    expect(await owner.next()).toMatchObject({ type: "paired", generation: generation + 1, resumed: true });
    expect(await phone.next()).toMatchObject({ type: "paired", generation: generation + 1, resumed: true }); await leave(owner);
  });
});
