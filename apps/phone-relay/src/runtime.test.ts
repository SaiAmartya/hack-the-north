import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const worker = exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

type PairResponse = {
  roomId: string;
  ownerToken: string;
  expiresAtMs: number;
  socketUrl: string;
  phoneUrl: string;
};

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      try {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before message"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
}

async function createPair(): Promise<PairResponse> {
  const response = await worker.default.fetch(
    new Request("https://relay.example/api/rooms", {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-pair-create-secret",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as PairResponse;
}

async function connectSocket(url: string, origin: string): Promise<WebSocket> {
  const requestUrl = url.replace(/^wss:/, "https:");
  const response = await worker.default.fetch(
    new Request(requestUrl, {
      headers: { origin, upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket as WebSocket;
  socket.accept();
  return socket;
}

async function openApprovedPair(): Promise<{
  pair: PairResponse;
  owner: WebSocket;
  phone: WebSocket;
}> {
  const pair = await createPair();
  const owner = await connectSocket(pair.socketUrl, "https://laptop.example");
  const phone = await connectSocket(pair.socketUrl, "https://relay.example");
  owner.send(
    JSON.stringify({ v: 1, type: "owner", token: pair.ownerToken }),
  );
  const ownerClaim = nextMessage(owner);
  const phoneAwaiting = nextMessage(phone);
  phone.send(JSON.stringify({ v: 1, type: "phone" }));
  const [claim, awaiting] = await Promise.all([ownerClaim, phoneAwaiting]);
  expect(claim).toMatchObject({
    v: 1,
    type: "claim",
    challenge: expect.stringMatching(/^\d{6}$/),
    claimId: expect.stringMatching(/^[0-9a-f]{32}$/),
  });
  expect(awaiting).toEqual({
    v: 1,
    type: "awaiting",
    challenge: claim.challenge,
  });
  const ownerPaired = nextMessage(owner);
  const phonePaired = nextMessage(phone);
  owner.send(
    JSON.stringify({ v: 1, type: "approve", claimId: claim.claimId }),
  );
  await expect(ownerPaired).resolves.toEqual({
    v: 1,
    type: "paired",
    generation: 1,
  });
  await expect(phonePaired).resolves.toEqual({
    v: 1,
    type: "paired",
    generation: 1,
  });
  return { pair, owner, phone };
}

async function persistenceCounts(roomId: string): Promise<{
  roomWrites: number;
  alarmWrites: number;
}> {
  const rooms = (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS;
  const stub = rooms.get(rooms.idFromName(roomId));
  return runInDurableObject(stub, (instance) => {
    const counters = instance as unknown as {
      persistenceWrites: number;
      alarmWrites: number;
    };
    return {
      roomWrites: counters.persistenceWrites,
      alarmWrites: counters.alarmWrites,
    };
  });
}

describe("hosted phone relay runtime", () => {
  it("protects creation and rejects an unapproved WebSocket origin", async () => {
    const unauthorized = await worker.default.fetch(
      new Request("https://relay.example/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(unauthorized.status).toBe(401);

    const pair = await createPair();
    expect(pair.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect(pair.ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.socketUrl).toBe(`wss://relay.example/ws/${pair.roomId}`);
    expect(pair.phoneUrl).toBe(
      `https://relay.example/phone?room=${pair.roomId}`,
    );
    expect(pair.expiresAtMs).toBeGreaterThan(Date.now());
    expect(pair.expiresAtMs).toBeLessThanOrEqual(Date.now() + 120_000);

    const rejected = await worker.default.fetch(
      new Request(pair.socketUrl.replace(/^wss:/, "https:"), {
        headers: { origin: "https://attacker.example", upgrade: "websocket" },
      }),
    );
    expect(rejected.status).toBe(403);
  });

  it("requires approval, forwards exact records, and invalidates on disconnect", async () => {
    const { pair, owner, phone } = await openApprovedPair();

    const operationAtPhone = nextMessage(phone);
    owner.send(
      JSON.stringify({
        v: 1,
        type: "op",
        id: "status-1",
        operation: "status",
      }),
    );
    await expect(operationAtPhone).resolves.toEqual({
      v: 1,
      type: "op",
      id: "status-1",
      operation: "status",
    });

    const status = Array.from({ length: 20 }, (_, index) => index + 1);
    const replyAtOwner = nextMessage(owner);
    phone.send(
      JSON.stringify({
        v: 1,
        type: "reply",
        id: "status-1",
        data: status,
      }),
    );
    await expect(replyAtOwner).resolves.toEqual({
      v: 1,
      type: "reply",
      id: "status-1",
      data: status,
    });

    const notifyAtOwner = nextMessage(owner);
    phone.send(
      JSON.stringify({
        v: 1,
        type: "notify",
        kind: "status",
        data: status,
      }),
    );
    const statusNotification = await notifyAtOwner;
    expect(statusNotification).toEqual({
      v: 1,
      type: "notify",
      kind: "status",
      data: status,
      deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    owner.send(
      JSON.stringify({
        v: 1,
        type: "received",
        id: statusNotification.deliveryId,
      }),
    );
    await scheduler.wait(10);

    const ownerClosed = nextClose(owner);
    phone.close(1000, "done");
    await expect(ownerClosed).resolves.toBeDefined();

    const reused = await worker.default.fetch(
      new Request(pair.socketUrl.replace(/^wss:/, "https:"), {
        headers: {
          origin: "https://laptop.example",
          upgrade: "websocket",
        },
      }),
    );
    expect(reused.status).toBe(410);
  });

  it("bounds motion delivery, keeps the newest overflow, and accepts delayed ACKs", async () => {
    const { pair, owner, phone } = await openApprovedPair();
    const writesBefore = await persistenceCounts(pair.roomId);
    let closeReason = "not_closed";
    owner.addEventListener("close", (event) => {
      closeReason = `owner:${event.reason}`;
    });
    phone.addEventListener("close", (event) => {
      closeReason = `phone:${event.reason}`;
    });
    const delivered: Record<string, unknown>[] = [];
    const ackTasks: Promise<void>[] = [];
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type !== "notify" || message.kind !== "motion") return;
      delivered.push(message);
      const id = message.deliveryId;
      if (typeof id !== "string") return;
      ackTasks.push(
        scheduler.wait(60).then(() => {
          try {
            owner.send(JSON.stringify({ v: 1, type: "received", id }));
          } catch {
            // The main stream loop reports the close reason deterministically.
          }
        }),
      );
    };
    owner.addEventListener("message", onMessage);

    for (let sequence = 0; sequence < 500; sequence += 1) {
      const data = Array(20).fill(sequence % 256);
      try {
        phone.send(
          JSON.stringify({ v: 1, type: "notify", kind: "motion", data }),
        );
      } catch {
        throw new Error(`relay closed during stream (${closeReason})`);
      }
      await scheduler.wait(20);
    }
    await scheduler.wait(120);
    await Promise.all(ackTasks);
    expect(delivered.length).toBeGreaterThanOrEqual(475);
    expect(
      delivered.every(
        (message) =>
          typeof message.deliveryId === "string" &&
          /^[0-9a-f]{32}$/.test(message.deliveryId),
      ),
    ).toBe(true);
    const writesAfter = await persistenceCounts(pair.roomId);
    expect(writesAfter).toEqual(writesBefore);
    owner.removeEventListener("message", onMessage);
    phone.close(1000, "done");
  }, 15_000);

  it("overwrites a full motion window with only the newest fresh sample", async () => {
    const { owner, phone } = await openApprovedPair();
    const delivered: Record<string, unknown>[] = [];
    for (let sequence = 0; sequence < 8; sequence += 1) {
      const next = nextMessage(owner);
      phone.send(
        JSON.stringify({
          v: 1,
          type: "notify",
          kind: "motion",
          data: Array(20).fill(sequence),
        }),
      );
      delivered.push(await next);
    }
    expect(new Set(delivered.map((message) => message.deliveryId)).size).toBe(8);
    phone.send(
      JSON.stringify({
        v: 1,
        type: "notify",
        kind: "motion",
        data: Array(20).fill(8),
      }),
    );
    phone.send(
      JSON.stringify({
        v: 1,
        type: "notify",
        kind: "motion",
        data: Array(20).fill(9),
      }),
    );
    await scheduler.wait(10);
    const newest = nextMessage(owner);
    owner.send(
      JSON.stringify({
        v: 1,
        type: "received",
        id: delivered[0].deliveryId,
      }),
    );
    await expect(newest).resolves.toMatchObject({
      v: 1,
      type: "notify",
      kind: "motion",
      data: Array(20).fill(9),
      deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    owner.close(1000, "done");
  });

  it("closes the room when a motion delivery is not acknowledged", async () => {
    const { owner, phone } = await openApprovedPair();
    const firstMotion = nextMessage(owner);
    phone.send(
      JSON.stringify({
        v: 1,
        type: "notify",
        kind: "motion",
        data: Array(20).fill(7),
      }),
    );
    await expect(firstMotion).resolves.toMatchObject({
      type: "notify",
      deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    const closed = nextClose(owner);
    await scheduler.wait(220);
    try {
      phone.send(
        JSON.stringify({
          v: 1,
          type: "notify",
          kind: "status",
          data: Array(20).fill(0),
        }),
      );
    } catch {
      // The alarm may have already closed the peer before this trigger frame.
    }
    await expect(closed).resolves.toBeDefined();
  });
});
