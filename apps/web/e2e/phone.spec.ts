import { expect, test } from "@playwright/test";

type RelayOperation = {
  operation: string;
  data?: number[];
};

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

test("phone relay performs the byte handshake, motion, feedback, and page-hide teardown", async ({
  page: owner,
}) => {
  const operations: RelayOperation[] = [];
  const relayReplies: string[] = [];
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
    const deadline = performance.now() + 7_000;
    while (true) {
      try {
        await game.connect("phone");
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "This duel is full." ||
          performance.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const pair = await game.pair();
    const wand = new WandClient(
      new VirtualWandTransport(
        undefined,
        undefined,
        new PhoneRelayChannel(game.token),
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
