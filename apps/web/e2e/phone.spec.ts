import { expect, test, type WebSocketRoute } from "@playwright/test";

type RelayOperation = {
  operation: string;
  data?: number[];
};

test("hosted phone allows a sideways grip and waits for real motion before pairing", async ({ page }) => {
  let sockets = 0;
  page.on("websocket", socket => { if (socket.url().includes("/ws/")) sockets++; });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.addInitScript(() => {
    Reflect.set(window, "__motionPermissionRequests", 0);
    class Motion extends Event {
      static requestPermission = async () => { Reflect.set(window, "__motionPermissionRequests", Number(Reflect.get(window, "__motionPermissionRequests")) + 1); return "granted"; };
    }
    Object.defineProperty(window, "DeviceMotionEvent", { value: Motion, configurable: true });
  });
  await page.goto(`/phone.html?room=${"a".repeat(32)}`);
  await page.getByRole("button", { name: "Connect wand" }).click();
  await expect(page.getByRole("heading", { name: "Move your iPhone gently…" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__motionPermissionRequests"))).toBe(1);
  expect(sockets).toBe(0);
});

test("hosted phone uses real RTC, resumes, and re-handshakes an explicit route change", async ({ page: owner, context }) => {
  test.setTimeout(35_000);
  const roomId = "a".repeat(32);
  let ownerSocket: WebSocketRoute | undefined, phoneSocket: WebSocketRoute | undefined;
  let generation = 1;
  let dataViaCloud = 0;
  const paired = () => {
    ownerSocket?.send(JSON.stringify({ v: 2, type: "paired", generation, route: "direct", resumed: generation > 1, resumeToken: "c".repeat(64), expiresAtMs: Date.now() + 120000 }));
    phoneSocket?.send(JSON.stringify({ v: 2, type: "paired", generation, route: "direct", resumed: generation > 1, resumeToken: "d".repeat(64), expiresAtMs: Date.now() + 120000 }));
  };
  await context.routeWebSocket(`**/ws/${roomId}`, socket => {
    let role = "";
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "owner") { role = "owner"; ownerSocket = socket; }
      if (message.type === "phone") {
        role = "phone"; phoneSocket = socket;
        ownerSocket?.send(JSON.stringify({ v: 2, type: "claim", claimId: "b".repeat(32), challenge: "123456" }));
        socket.send(JSON.stringify({ v: 2, type: "awaiting", challenge: "123456" }));
      }
      if (message.type === "approve") paired();
      if (message.type === "signal") (role === "owner" ? phoneSocket : ownerSocket)?.send(JSON.stringify(message));
      if (message.type === "reset-link") { generation++; paired(); }
      if (message.type === "route") { generation++; const update = JSON.stringify({ v: 2, type: "route", route: "relay", generation }); ownerSocket?.send(update); phoneSocket?.send(update); }
      if (message.type === "data") { dataViaCloud++; (role === "owner" ? phoneSocket : ownerSocket)?.send(JSON.stringify(message)); }
    });
  });
  await owner.goto("/");
  await owner.evaluate(async room => {
    const { PhoneSession } = await import(/* @vite-ignore */ "/src/phone/session.ts");
    const { WandClient } = await import(/* @vite-ignore */ "/src/wand/client.ts");
    const session = new PhoneSession({ pair: { roomId: room, ownerToken: "b".repeat(64), expiresAtMs: Date.now() + 120000, socketUrl: `ws://${location.host}/ws/${room}`, phoneUrl: `${location.origin}/phone.html?room=${room}` }, onClaim: (claim: { claimId: string }) => session.approve(claim.claimId) });
    const wand = new WandClient(session);
    wand.onSample(() => {
      const snapshot = wand.getSnapshot();
      session.reportAccepted({ sequence: snapshot.lastSample?.seq ?? 0, accepted: snapshot.accepted, receivedHz: 50, ageMs: 20 });
    });
    Reflect.set(window, "__hostedPhone", { session, wand });
    void wand.connect();
  }, roomId);
  const phone = await context.newPage(); await phone.setViewportSize({ width: 844, height: 390 });
  await phone.addInitScript(() => {
    class Motion extends Event {
      static requestPermission = async () => "granted";
      readonly accelerationIncludingGravity = { x: 0, y: 9.80665, z: 0 };
    }
    Object.defineProperty(window, "DeviceMotionEvent", { value: Motion, configurable: true });
    setInterval(() => window.dispatchEvent(new Motion("devicemotion")), 20);
  });
  await phone.goto(`/phone.html?room=${roomId}`);
  await phone.getByRole("button", { name: "Connect wand" }).click();
  await expect(phone.getByText("Sensor active", { exact: true })).toBeVisible();
  await expect(phone.getByText("Reaching laptop", { exact: true })).toBeVisible({ timeout: 15000 });
  expect(dataViaCloud).toBe(0);
  const beforeRotation = generation;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await expect(phone.getByText("Reaching laptop", { exact: true })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  expect(generation).toBe(beforeRotation);
  await owner.evaluate(() => {
    const { session } = Reflect.get(window, "__hostedPhone") as { session: { coach(value: { instruction: string; completed: number; total: number; hint: string }): void } };
    session.coach({ instruction: "Three gentle jabs.", completed: 1, total: 3, hint: "Return to your starting grip." });
  });
  await expect(phone.getByRole("heading", { name: "Three gentle jabs." })).toBeVisible();
  await expect(phone.getByLabel("1 of 3 gestures")).toBeVisible();
  await phone.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect(phone.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(phone.getByText("Waiting for laptop", { exact: true })).toBeVisible();
  await phone.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(phone.getByText("Reaching laptop", { exact: true })).toBeVisible({ timeout: 15000 });
  expect(generation).toBeGreaterThan(1); expect(dataViaCloud).toBe(0);
  const inputGeneration = await owner.evaluate(() => { const h = Reflect.get(window, "__hostedPhone") as { wand: { getSnapshot(): { generation: number } }; session: { chooseRelay(): void } }; const before = h.wand.getSnapshot().generation; h.session.chooseRelay(); return before; });
  await expect.poll(() => owner.evaluate(() => { const h = Reflect.get(window, "__hostedPhone") as { wand: { getSnapshot(): { phase: string; generation: number } } }; const snapshot = h.wand.getSnapshot(); return { phase: snapshot.phase, changed: snapshot.generation }; })).toEqual({ phase: "streaming", changed: inputGeneration + 1 });
  await expect(phone.getByText("Reaching laptop", { exact: true })).toBeVisible(); expect(dataViaCloud).toBeGreaterThan(0);
  await owner.evaluate(() => { const h = Reflect.get(window, "__hostedPhone") as { wand: { disconnect(): void } }; h.wand.disconnect(); });
  await phone.getByRole("button", { name: "Disconnect", exact: true }).click();
});

test("phone opens one relay only after its first real motion sample", async ({
  page,
}) => {
  let relaySockets = 0;
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/ws/dev-wand")) relaySockets++;
  });
  await page.addInitScript(() => {
    class MockDeviceMotionEvent extends Event {
      static requestPermission = async () => "granted";
      readonly accelerationIncludingGravity: {
        x: number;
        y: number;
        z: number;
      };
      constructor(
        type: string,
        init: {
          accelerationIncludingGravity?: { x: number; y: number; z: number };
        } = {},
      ) {
        super(type);
        this.accelerationIncludingGravity =
          init.accelerationIncludingGravity ?? { x: 0, y: 0, z: 9.80665 };
      }
    }
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      value: MockDeviceMotionEvent,
    });
  });
  await page.goto("/phone");
  await page.getByLabel("Laptop code").fill("ABCDEFGHIJ");
  await page.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(
    page.getByRole("heading", {
      name: "Move your iPhone to finish connecting…",
    }),
  ).toBeVisible();
  await page.waitForTimeout(250);
  expect(relaySockets).toBe(0);

  await page.evaluate(() =>
    window.dispatchEvent(
      new DeviceMotionEvent("devicemotion", {
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
      }),
    ),
  );
  await expect.poll(() => relaySockets).toBe(1);
  await page.waitForTimeout(100);
  expect(relaySockets).toBe(1);
});

test("phone times out without motion and cancels pending permission on page hide", async ({
  page,
  context,
}) => {
  let relaySockets = 0;
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/ws/dev-wand")) relaySockets++;
  });
  await page.addInitScript(() => {
    class MockDeviceMotionEvent extends Event {
      static requestPermission = async () => "granted";
      readonly accelerationIncludingGravity = { x: 0, y: 0, z: 9.80665 };
    }
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      value: MockDeviceMotionEvent,
    });
  });
  await page.goto("/phone");
  await page.getByLabel("Laptop code").fill("ABCDEFGHIJ");
  await page.getByRole("button", { name: "Connect wand" }).click();
  await expect(
    page.getByRole("heading", { name: "No motion detected. Try again." }),
  ).toBeVisible({ timeout: 4_000 });
  expect(relaySockets).toBe(0);

  const pending = await context.newPage();
  let pendingRelaySockets = 0;
  pending.on("websocket", (socket) => {
    if (socket.url().endsWith("/ws/dev-wand")) pendingRelaySockets++;
  });
  await pending.addInitScript(() => {
    let resolvePermission: ((value: string) => void) | undefined;
    class MockDeviceMotionEvent extends Event {
      static requestPermission = () =>
        new Promise<string>((resolve) => {
          resolvePermission = resolve;
        });
      readonly accelerationIncludingGravity = { x: 0, y: 0, z: 9.80665 };
    }
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      value: MockDeviceMotionEvent,
    });
    Reflect.set(window, "__resolveMotionPermission", (value: string) =>
      resolvePermission?.(value),
    );
  });
  await pending.goto("/phone");
  await pending.getByLabel("Laptop code").fill("ABCDEFGHIJ");
  await pending.getByRole("button", { name: "Connect wand" }).click();
  await expect(
    pending.getByRole("heading", { name: "Requesting motion access…" }),
  ).toBeVisible();
  await pending.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await pending.evaluate(() => {
    (Reflect.get(window, "__resolveMotionPermission") as (value: string) => void)(
      "granted",
    );
  });
  await pending.waitForTimeout(50);
  await pending.evaluate(() =>
    window.dispatchEvent(new DeviceMotionEvent("devicemotion")),
  );
  await pending.waitForTimeout(100);
  expect(pendingRelaySockets).toBe(0);
  await expect(
    pending.getByRole("heading", { name: "Wand paused. Reconnect." }),
  ).toBeVisible();
});

test("phone reports denied motion permission without opening a relay", async ({
  page,
}) => {
  let relaySockets = 0;
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/ws/dev-wand")) relaySockets++;
  });
  await page.addInitScript(() => {
    class MockDeviceMotionEvent extends Event {
      static requestPermission = async () => "denied";
      readonly accelerationIncludingGravity = null;
    }
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      value: MockDeviceMotionEvent,
    });
  });
  await page.goto("/phone");
  await page.getByLabel("Laptop code").fill("ABCDEFGHIJ");
  await page.getByRole("button", { name: "Connect wand" }).click();
  await expect(
    page.getByRole("heading", { name: "Allow motion to use your wand." }),
  ).toBeVisible();
  expect(relaySockets).toBe(0);
});

for (const wakeLockMode of ["unsupported", "denied"] as const) {
  test(`phone keeps working when screen wake lock is ${wakeLockMode}`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => {
      class MockDeviceMotionEvent extends Event {
        static requestPermission = async () => "granted";
        readonly accelerationIncludingGravity = { x: 0, y: 0, z: 9.80665 };
      }
      Object.defineProperty(window, "DeviceMotionEvent", {
        configurable: true,
        value: MockDeviceMotionEvent,
      });
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value:
          mode === "unsupported"
            ? undefined
            : {
                request: async () => {
                  throw new DOMException("denied", "NotAllowedError");
                },
              },
      });
    }, wakeLockMode);
    await page.goto("/phone");
    await page.getByLabel("Laptop code").fill("ABCDEFGHIJ");
    await page.getByRole("button", { name: "Connect wand" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Move your iPhone to finish connecting…",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Keep this screen awake during your duel."),
    ).toBeVisible();
  });
}

test("phone releases a wake lock that resolves after the session stops", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class MockDeviceMotionEvent extends Event {
      static requestPermission = async () => "granted";
      readonly accelerationIncludingGravity = { x: 0, y: 0, z: 9.80665 };
    }
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      value: MockDeviceMotionEvent,
    });
    let resolveWakeLock:
      | ((lock: {
          release(): Promise<void>;
          addEventListener(): void;
        }) => void)
      | undefined;
    let releases = 0;
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: () =>
          new Promise((resolve) => {
            resolveWakeLock = resolve;
          }),
      },
    });
    Reflect.set(window, "__resolveWakeLock", () =>
      resolveWakeLock?.({
        release: async () => {
          releases++;
        },
        addEventListener: () => undefined,
      }),
    );
    Reflect.set(window, "__wakeLockReleases", () => releases);
  });
  await page.goto("/phone");
  await page.getByLabel("Laptop code").fill("ABCDEFGHIJ");
  await page.getByRole("button", { name: "Connect wand" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Move your iPhone to finish connecting…",
    }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await page.evaluate(() => {
    (Reflect.get(window, "__resolveWakeLock") as () => void)();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, "__wakeLockReleases") as () => number)(),
      ),
    )
    .toBe(1);
  await expect(
    page.getByRole("heading", { name: "Wand paused. Reconnect." }),
  ).toBeVisible();
});

test("phone relay performs the byte handshake, motion, feedback, and page-hide teardown", async ({
  page: owner,
}) => {
  const operations: RelayOperation[] = [];
  const relayReplies: string[] = [];
  const duelReservations: string[] = [];
  owner.on("request", request => {
    if (request.method() === "POST" && /\/api\/game\/(room|session)$/.test(request.url()))
      duelReservations.push(request.url());
  });
  owner.on("websocket", (socket) => {
    if (!socket.url().endsWith("/ws/dev-wand")) return;
    socket.on("framesent", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type === "op") operations.push(message);
      } catch {
        // Non-JSON frames are rejected by the real relay and are not expected here.
      }
    });
    socket.on("framereceived", ({ payload }) =>
      relayReplies.push(String(payload)),
    );
  });

  await owner.goto("/");
  const pair = await owner.evaluate(async () => {
    const gamePath = "/src/game/client.ts";
    const relayPath = "/src/phone/relay.ts";
    const virtualPath = "/src/wand/virtual.ts";
    const clientPath = "/src/wand/client.ts";
    const { GameClient } = await import(/* @vite-ignore */ gamePath);
    const { PhoneRelayChannel } = await import(/* @vite-ignore */ relayPath);
    const { VirtualWandTransport } = await import(
      /* @vite-ignore */ virtualPath
    );
    const { WandClient } = await import(/* @vite-ignore */ clientPath);
    const game = new GameClient();
    const pair = await game.pair();
    const wand = new WandClient(
      new VirtualWandTransport(
        undefined,
        undefined,
        new PhoneRelayChannel(pair.ownerToken),
      ),
    );
    const ready = wand.connect();
    Reflect.set(window, "__phoneHarness", { game, wand, ready });
    return pair;
  });

  const phone = await owner.context().newPage();
  await phone.addInitScript(() => {
    class MockDeviceMotionEvent extends Event {
      static requestPermission = async () => "granted";
      readonly accelerationIncludingGravity: {
        x: number;
        y: number;
        z: number;
      };
      constructor(
        type: string,
        init: { accelerationIncludingGravity?: { x: number; y: number; z: number } } = {},
      ) {
        super(type);
        this.accelerationIncludingGravity =
          init.accelerationIncludingGravity ?? { x: 0, y: 0, z: 9.80665 };
      }
    }
    Object.defineProperty(window, "DeviceMotionEvent", {
      configurable: true,
      value: MockDeviceMotionEvent,
    });
  });
  await phone.goto("/phone");
  await phone.evaluate(() => {
    const emit = () =>
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
        }),
      );
    Reflect.set(window, "__motionTimer", window.setInterval(emit, 20));
    emit();
  });
  await phone.getByLabel("Laptop code").fill(pair.code);
  await phone.getByRole("button", { name: "Connect wand" }).click();
  await expect(
    phone.getByRole("heading", { name: "Your wand is ready" }),
  ).toBeVisible();
  await expect
    .poll(() => relayReplies.some((frame) => frame.includes('"type":"paired"')))
    .toBe(true);

  await expect
    .poll(() =>
      owner.evaluate(() => {
        type Harness = { wand: { getSnapshot(): { phase: string } } };
        return (
          Reflect.get(window, "__phoneHarness") as Harness
        ).wand.getSnapshot().phase;
      }),
    )
    .toBe("streaming");
  const handshake = await owner.evaluate(() => {
    type Harness = {
      wand: {
        getSnapshot(): {
          phase: string;
          accepted: number;
          lastSample?: { azMg: number };
        };
      };
    };
    const harness = Reflect.get(window, "__phoneHarness") as Harness;
    return harness.wand.getSnapshot();
  });
  expect(handshake.phase).toBe("streaming");
  expect(duelReservations).toEqual([]);

  const handshakeOperations = operations.slice();
  expect(
    handshakeOperations.filter((message) => message.operation === "info"),
  ).toHaveLength(1);
  expect(
    handshakeOperations.filter(
      (message) => message.operation === "subscribe-motion",
    ),
  ).toHaveLength(1);
  expect(
    handshakeOperations.filter(
      (message) => message.operation === "subscribe-status",
    ),
  ).toHaveLength(1);
  const controls = handshakeOperations.filter(
    (message) => message.operation === "control",
  );
  expect(controls.filter((message) => message.data?.[1] === 1)).toHaveLength(1);
  expect(controls.filter((message) => message.data?.[1] === 2)).toHaveLength(5);

  await expect
    .poll(() =>
      owner.evaluate(() => {
        type Harness = { wand: { getSnapshot(): { accepted: number } } };
        return (
          Reflect.get(window, "__phoneHarness") as Harness
        ).wand.getSnapshot().accepted;
      }),
    )
    .toBeGreaterThan(0);
  expect(
    await owner.evaluate(() => {
      type Harness = {
        wand: { getSnapshot(): { lastSample?: { azMg: number } } };
      };
      return (
        Reflect.get(window, "__phoneHarness") as Harness
      ).wand.getSnapshot().lastSample?.azMg;
    }),
  ).toBe(1000);

  await owner.evaluate(async () => {
    const protocolPath = "/src/wand/protocol.ts";
    const { PresentationPhase } = await import(
      /* @vite-ignore */ protocolPath
    );
    type Harness = {
      wand: {
        setState(state: {
          phase: number;
          hp: number;
          maxHp: number;
          statusFlags: number;
          presentationEpoch: number;
        }): void;
      };
    };
    (Reflect.get(window, "__phoneHarness") as Harness).wand.setState({
      phase: PresentationPhase.Playing,
      hp: 73,
      maxHp: 100,
      statusFlags: 0,
      presentationEpoch: 77,
    });
  });
  await expect(phone.getByText("73 ♥", { exact: true })).toBeVisible();
  await owner.evaluate(async () => {
    const protocolPath = "/src/wand/protocol.ts";
    const { CueEffect, SpellCode } = await import(
      /* @vite-ignore */ protocolPath
    );
    type Harness = {
      wand: {
        cue(cue: {
          effect: number;
          spell: number;
          durationMs: number;
          presentationEpoch: number;
        }): void;
      };
    };
    (Reflect.get(window, "__phoneHarness") as Harness).wand.cue({
      effect: CueEffect.TookDamage,
      spell: SpellCode.Stupefy,
      durationMs: 1000,
      presentationEpoch: 77,
    });
  });
  await expect(phone.locator(".wand-orb")).toHaveClass(/cue-3/);

  await phone.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await expect(
    phone.getByRole("heading", { name: "Wand paused. Reconnect." }),
  ).toBeVisible();
  await expect
    .poll(() =>
      owner.evaluate(() => {
        type Harness = { wand: { getSnapshot(): { phase: string } } };
        return (
          Reflect.get(window, "__phoneHarness") as Harness
        ).wand.getSnapshot().phase;
      }),
    )
    .toBe("fault");

  await phone.evaluate(() =>
    window.clearInterval(Reflect.get(window, "__motionTimer") as number),
  );
  await owner.evaluate(() => {
    type Harness = {
      wand: { disconnect(): void };
      game: { disconnect(): void };
    };
    const harness = Reflect.get(window, "__phoneHarness") as Harness;
    harness.wand.disconnect();
    harness.game.disconnect();
  });
});
