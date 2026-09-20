import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { scriptedLaptop, connectBadge, snapshot, cast, castWithMicrophone, miscast } from "./scripted-laptop";
import badgeGestures from "../src/input/fixtures/badge-gestures-2026-09-20.json" with { type: "json" };

test("the homepage requires a wand before offering duel creation or a code", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Wands at.*the ready/ })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Start a duel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Join with code", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect badge", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect iPhone", exact: true })).toBeVisible();
  await expect(page.getByText(/virtual|device lab|simulated/i)).toHaveCount(0);
  await page.screenshot({ path: "/tmp/wandduel-home.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/wandduel-mobile.png", fullPage: true });
});

test("failed phone setup offers a fresh connection instead of a preparing screen", async ({ page }) => {
  await page.route("**/api/phone/config", route => route.fulfill({ status: 503 }));
  await page.goto("/");
  await page.getByRole("button", { name: "Connect iPhone", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Let's reconnect." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preparing your iPhone…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reconnect iPhone", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Choose another wand" }).click();
  await expect(page.getByRole("button", { name: "Connect badge", exact: true })).toBeVisible();
});

test("hosted iPhone pairing uses POST-only brokers, a public QR, and explicit approval", async ({
  page,
}) => {
  const roomId = "1".repeat(32),
    ownerToken = "2".repeat(64),
    claimId = "3".repeat(32),
    phoneUrl = `https://wand.example/phone?room=${roomId}`,
    socketUrl = `wss://wand.example/ws/${roomId}`;
  const brokerRequests: { path: string; method: string; body: string | null }[] =
    [];
  await page.route("**/api/phone/config", async (route) => {
    const request = route.request();
    brokerRequests.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      body: request.postData(),
    });
    await route.fulfill({ json: { enabled: true } });
  });
  await page.route("**/api/phone/pair", async (route) => {
    const request = route.request();
    brokerRequests.push({
      path: new URL(request.url()).pathname,
      method: request.method(),
      body: request.postData(),
    });
    await route.fulfill({
      status: 201,
      json: {
        roomId,
        ownerToken,
        expiresAtMs: Date.now() + 120_000,
        socketUrl,
        phoneUrl,
      },
    });
  });
  await page.addInitScript(
    ({ expectedSocketUrl, expectedClaimId }) => {
      const NativeWebSocket = window.WebSocket;
      const RoutedWebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          const url = String(args[0]);
          if (url !== expectedSocketUrl) return Reflect.construct(Target, args);
          const record = {
            url,
            sent: [] as string[],
            closed: false,
            claim: (): void => undefined,
          };
          Reflect.set(window, "__hostedPhoneSocket", record);
          const socket = {
            url,
            readyState: NativeWebSocket.CONNECTING as number,
            bufferedAmount: 0,
            onopen: null as ((event: Event) => void) | null,
            onmessage: null as ((event: MessageEvent<string>) => void) | null,
            onerror: null as ((event: Event) => void) | null,
            onclose: null as ((event: CloseEvent) => void) | null,
            send(value: string) {
              record.sent.push(String(value));
            },
            close() {
              record.closed = true;
              socket.readyState = NativeWebSocket.CLOSED;
            },
          };
          record.claim = () =>
            socket.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify({
                  v: 2,
                  type: "claim",
                  claimId: expectedClaimId,
                  challenge: "482193",
                }),
              }),
            );
          queueMicrotask(() => {
            socket.readyState = NativeWebSocket.OPEN;
            socket.onopen?.(new Event("open"));
          });
          return socket;
        },
      });
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        value: RoutedWebSocket,
      });
    },
    { expectedSocketUrl: socketUrl, expectedClaimId: claimId },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Connect iPhone" }).click();
  await expect(
    page.getByRole("heading", { name: "Scan with iPhone." }),
  ).toBeVisible();
  const qr = page.getByRole("img", {
    name: "Scan this code with your iPhone",
  });
  await expect(qr).toBeVisible();
  await expect(qr).toHaveCSS("stroke", "none");
  await qr.screenshot({ path: "/tmp/wandduel-qr-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(qr).toBeVisible();
  await expect(qr).toHaveCSS("stroke", "none");
  await qr.screenshot({ path: "/tmp/wandduel-qr-narrow.png" });
  await page.evaluate(() =>
    Reflect.get(window, "__hostedPhoneSocket").claim(),
  );
  await expect(
    page.getByRole("heading", {
      name: "Does 482193 match your iPhone?",
    }),
  ).toBeVisible();
  expect(brokerRequests).toEqual([
    { path: "/api/phone/config", method: "POST", body: null },
    { path: "/api/phone/pair", method: "POST", body: null },
  ]);
  const beforeApproval = await page.evaluate(() =>
    Reflect.get(window, "__hostedPhoneSocket"),
  );
  expect(beforeApproval.url).toBe(socketUrl);
  expect(beforeApproval.url).not.toContain(ownerToken);
  expect(JSON.parse(beforeApproval.sent[0])).toEqual({
    v: 2,
    type: "owner",
    token: ownerToken,
  });

  await page.getByRole("button", { name: "Yes, connect" }).click();
  await expect(
    page.getByRole("heading", { name: /Connecting.*your iPhone…/ }),
  ).toBeVisible();
  const afterApproval = await page.evaluate(() =>
    Reflect.get(window, "__hostedPhoneSocket"),
  );
  expect(JSON.parse(afterApproval.sent.at(-1))).toEqual({
    v: 2,
    type: "approve",
    claimId,
  });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("button", { name: "Connect iPhone" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => Reflect.get(window, "__hostedPhoneSocket").closed,
    ),
  ).toBe(true);
});

test("raw wand evidence drives attack, block, abort, and rematch", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/__qa/game");
  await expect(
    page.getByRole("heading", { name: "Scripted duel QA" }),
  ).toBeVisible();
  await expect(
    page.getByText("raw replay motion plus explicitly scripted speech", {
      exact: false,
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Run scripted duel QA", exact: true })
    .click();
  const stage = page.getByTestId("qa-stage");
  await expect
    .poll(() => stage.textContent(), { timeout: 35_000 })
    .toMatch(/^(complete|failed)$/);
  if ((await stage.textContent()) === "failed") {
    throw new Error(
      `Scripted duel QA failed: ${await page.getByTestId("qa-detail").textContent()}`,
    );
  }
  await expect(page.getByTestId("qa-attack")).toHaveText("true");
  await expect(page.getByTestId("qa-defense")).toHaveText("true");
  await expect(page.getByTestId("qa-blocked")).toHaveText("true");
  await expect(page.getByTestId("qa-health")).toHaveText("100");
  await expect(page.getByTestId("qa-abort")).toHaveText("aborted");
  await expect(page.getByTestId("qa-rematch")).not.toHaveText("—");
  expect(errors).toEqual([]);
});

test("a paired wand plays five spells against the real solo bot, rematches, and reconnects", async ({ page, context }) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const laptop = await scriptedLaptop(page);
  await expect(page.getByRole("button", { name: "Duel a bot", exact: true })).toHaveCount(0);
  await connectBadge(page);
  await page.screenshot({ path: "/tmp/wandduel-mode-selection.png", fullPage: true });
  const creating = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/game/session",
  );
  await page.getByRole("button", { name: "Duel a bot", exact: true }).click();
  expect((await creating).postDataJSON()).toMatchObject({ mode: "solo", source: "ble" });
  await expect(page.getByRole("heading", { name: "Solo duel", exact: true })).toBeVisible();
  await expect(page.getByText("Speak + jab to attack. Speak + raise to shield or heal.", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Duel code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /camera/i })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeDisabled();
  await expect.poll(async () => (await snapshot(page)).players.P2?.source).toBe("bot");
  expect((await snapshot(page)).mode).toBe("solo");
  expect((await snapshot(page)).players.P2?.name).toBe("Practice Wizard");
  expect(context.pages()).toHaveLength(1);
  const roomId = (await snapshot(page)).roomId;
  laptop.enableSpeech();
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.screenshot({ path: "/tmp/wandduel-solo-lobby.png", fullPage: true });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  const roundId = (await snapshot(page)).roundId;
  await expect(page.getByRole("button", { name: /camera/i })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);

  const assertProjectileOutcome = async (projectileId: string | undefined, spell: "expelliarmus" | "incendio", damage: number) => {
    expect(projectileId).toBeTruthy();
    const resolutions = (state: Awaited<ReturnType<typeof snapshot>>) => state.recentEvents.filter(event =>
      event.projectileId === projectileId && event.type === "damage",
    );
    await expect.poll(async () => resolutions(await snapshot(page)).length, { intervals: [50] }).toBe(1);
    const resolved = await snapshot(page);
    const [impact] = resolutions(resolved);
    expect(impact).toMatchObject({ actor: "P1", target: "P2", spell, amount: damage });
    expect(resolved.projectiles.some(projectile => projectile.id === projectileId)).toBe(false);
    const disarmed = resolved.recentEvents.filter(event => event.projectileId === projectileId && event.type === "offenseLocked");
    if (spell === "expelliarmus") {
      expect(disarmed).toHaveLength(1);
      expect(resolved.players.P2!.offenseLockedUntilMs).toBeGreaterThan(impact.atMs);
      await expect(page.getByLabel("Rival wizard").getByText(/DISARMED/)).toBeVisible();
    }
  };

  // React to the actual first projectile; the bot remains active throughout the match.
  await expect.poll(async () => (await snapshot(page)).projectiles.some(projectile =>
    projectile.caster === "P2" && projectile.spell === "stupefy",
  ), { intervals: [50], timeout: 16_000 }).toBe(true);
  expect((await cast(page, "protego")).accepted).toBe(true);
  await expect(page.getByLabel(/^Protego: recharging/)).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).recentEvents.some(event =>
    event.type === "impactBlocked" && event.actor === "P2" && event.target === "P1",
  ), { intervals: [50] }).toBe(true);
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", "100");

  const disarmCast = await cast(page, "expelliarmus");
  expect(disarmCast.accepted).toBe(true);
  await expect(page.getByLabel(/^Expelliarmus: recharging/)).toBeVisible();
  await assertProjectileOutcome(disarmCast.projectileId, "expelliarmus", 10);
  await page.screenshot({ path: "/tmp/wandduel-solo-battle.png", fullPage: true });

  const fireCast = await cast(page, "incendio");
  expect(fireCast.accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).players.P1!.hp, { timeout: 16_000 }).toBe(80);
  expect((await cast(page, "episkey")).accepted).toBe(true);
  await expect(page.getByLabel(/^Episkey: recharging/)).toBeVisible();
  expect((await snapshot(page)).recentEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "healed", actor: "P1", spell: "episkey", amount: 18 }),
  ]));
  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Stupefy: recharging/)).toBeVisible();
  await expect(page.getByLabel(/^Episkey: recharging/)).toBeVisible();
  expect(await cast(page, "stupefy")).toMatchObject({ accepted: false, reason: "cooldown" });
  await assertProjectileOutcome(fireCast.projectileId, "incendio", 30);
  const acceptedSpells = (await snapshot(page)).recentEvents
    .filter(event => event.type === "castAccepted" && event.actor === "P1")
    .map(event => event.spell).sort();
  expect(acceptedSpells).toEqual(["episkey", "expelliarmus", "incendio", "protego", "stupefy"]);
  await expect(page.getByRole("progressbar")).toHaveCount(5);

  // The gentle bot gives a learning player time to finish the round and win on remaining health.
  await expect(page.getByRole("heading", { name: "Victory!", exact: true })).toBeVisible({ timeout: 45_000 });
  expect((await snapshot(page)).result).toMatchObject({ outcome: "win", winner: "P1", reason: "timeout" });
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", "58");
  await expect(page.getByLabel("Duel code")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/wandduel-solo-result.png", fullPage: true });
  await page.getByRole("button", { name: "Rematch", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  const rematch = await snapshot(page);
  expect(rematch.roundId).toBeGreaterThan(roundId);
  expect(rematch.players.P1?.hp).toBe(100);
  expect(rematch.players.P2?.hp).toBe(100);
  expect(rematch.players.P2?.source).toBe("bot");

  await page.evaluate(() => Reflect.get(window, "__battleSocket").close());
  await expect(page.getByRole("heading", { name: "Duel paused", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect battle", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeEnabled();
  expect((await snapshot(page)).roomId).toBe(roomId);
  expect((await snapshot(page)).mode).toBe("solo");
  await expect(page.getByLabel("Duel code")).toHaveCount(0);
  await page.getByRole("button", { name: "Leave duel", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your wand.*is ready/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Duel a bot", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").chooser)).toBe(1);
  expect(context.pages()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a recorded badge raise reaches the solo referee as one Protego", async ({ page }) => {
  const recording = badgeGestures.cases.find(entry => entry.name === "protego-strong-training-4")!;
  const samples = recording.samples.map(row => ({
    captureMs: Number(row[1]), axMg: Number(row[3]), ayMg: Number(row[4]),
    azMg: Number(row[5]), flags: Number(row[7]),
  }));
  await scriptedLaptop(page);
  await page.getByRole("switch", { name: "Dev mode", exact: true }).click();
  await page.evaluate(first => {
    Reflect.get(window, "__scriptedBadge").pose = [first.axMg, first.ayMg, first.azMg];
  }, samples[0]);
  await connectBadge(page);
  await page.getByRole("button", { name: "Duel a bot", exact: true }).click();
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");

  const result = await page.evaluate(async rawSamples => {
    const controller = Reflect.get(window, "__duelController");
    const gestures: string[] = [];
    const acknowledgements: boolean[] = [];
    const originalGesture = controller.fusion.pushGesture.bind(controller.fusion);
    const originalAck = controller.game.onAck;
    controller.fusion.pushGesture = (evidence: { spell: string; startMs: number; endMs: number }) => {
      gestures.push(evidence.spell);
      originalGesture(evidence);
      if (gestures.length !== 1) return;
      // Only recognized speech is scripted. The recorded axes and acquisition intervals
      // traverse the BLE protocol and live recognizer before this overlapping utterance.
      const id = crypto.randomUUID(), startMs = evidence.startMs + 20;
      controller.fusion.beginUtterance({ id, generation: controller.generation, startMs });
      controller.fusion.pushUtterance({ id, generation: controller.generation, spell: "protego",
        startMs, endMs: evidence.endMs, finalAtMs: performance.now() });
    };
    controller.game.onAck = (message: { command: string; accepted: boolean }) => {
      originalAck(message);
      if (message.command === "cast") acknowledgements.push(message.accepted);
    };
    try {
      await Reflect.get(window, "__scriptedBadge").play("recorded-protego", rawSamples);
      const deadline = performance.now() + 2_000;
      while (!acknowledgements.length && performance.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      return { gestures, acknowledgements };
    } finally {
      controller.fusion.pushGesture = originalGesture;
      controller.game.onAck = originalAck;
    }
  }, samples);
  expect(result).toEqual({ gestures: ["protego"], acknowledgements: [true] });
  const events = (await snapshot(page)).recentEvents.filter(event => event.actor === "P1");
  expect(events.filter(event => event.type === "castAccepted")).toEqual([
    expect.objectContaining({ spell: "protego" }),
  ]);
  expect(events).toContainEqual(expect.objectContaining({ type: "shieldRaised", spell: "protego" }));
});

test("normal mode aligns real microphone timing with batched BLE in both orders and overlap", async ({ page }, testInfo) => {
  test.setTimeout(70_000);
  const laptop = await scriptedLaptop(page);
  laptop.enableSpeech();
  await expect(page.getByRole("switch", { name: "Dev mode", exact: true })).not.toBeChecked();
  await connectBadge(page);
  await page.getByRole("button", { name: "Duel a bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  await page.evaluate(() => { Reflect.get(window, "__scriptedBadge").batchMs = 100; });
  const timing = [];
  for (const order of ["overlap", "speech-first", "movement-first"] as const) {
    for (const spell of ["protego", "stupefy"] as const) {
      await expect.poll(async () => {
        const state = await snapshot(page);
        return state.players.P1!.cooldownUntilMs[spell] - state.serverNowMs;
      }).toBeLessThanOrEqual(0);
      timing.push({ order, spell, ...await castWithMicrophone(page, spell, order) });
    }
  }
  await testInfo.attach("normal-microphone-motion-timing", { body: JSON.stringify(timing, null, 2), contentType: "application/json" });
  await expect.poll(async () => (await snapshot(page)).players.P2?.hp).toBe(40);
  const ownCasts = (await snapshot(page)).recentEvents.filter(e => e.actor === "P1" && e.type === "castAccepted");
  expect(ownCasts.map(e => e.spell)).toEqual(["protego", "stupefy", "protego", "stupefy", "protego", "stupefy"]);
  expect(await page.evaluate(() => {
    const c = Reflect.get(window, "__duelController");
    return { dev: c.devMode, simple: c.simpleMotion, rejected: c.wand.getSnapshot().rejected };
  })).toEqual({ dev: false, simple: false, rejected: 0 });
  await page.locator(".arena-frame").screenshot({ path: "/tmp/wandduel-normal-timing.png" });
});

test("dev-only simple motion casts all five spoken spells from the same raw spike", async ({ page }) => {
  test.setTimeout(55_000);
  await scriptedLaptop(page);
  const toggle = page.getByRole("switch", { name: "Simple motion", exact: true });
  await expect(toggle).toHaveCount(0);
  await page.getByRole("switch", { name: "Dev mode", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: "/tmp/wandduel-simple-home.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/wandduel-simple-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await connectBadge(page);
  await page.getByRole("button", { name: "Duel a bot", exact: true }).click();
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  await expect(toggle).toHaveCount(0);
  await expect(page.getByText("MOVE + SPEAK", { exact: true })).toHaveCount(5);

  // A correctly recognized word on its own never submits a cast.
  await page.evaluate(() => {
    const c = Reflect.get(window, "__duelController"), now = performance.now(), id = crypto.randomUUID();
    c.fusion.beginUtterance({ id, generation: c.generation, startMs: now - 120 });
    c.fusion.pushUtterance({ id, generation: c.generation, spell: "protego", startMs: now - 120, endMs: now, finalAtMs: now });
  });
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__duelController").fusion.getState().pendingUtterance),
    { timeout: 4_000 }).toBeUndefined();
  expect((await snapshot(page)).recentEvents.filter(e => e.type === "castAccepted" && e.actor === "P1")).toEqual([]);

  const spike = async (spell: "stupefy" | "protego" | "expelliarmus" | "incendio" | "episkey" | null) => page.evaluate(async spellName => {
    const c = Reflect.get(window, "__duelController");
    const acknowledgements: { accepted: boolean; reason?: string }[] = [];
    const originalGesture = c.fusion.pushGesture.bind(c.fusion), originalAck = c.game.onAck;
    let spikes = 0;
    c.fusion.pushGesture = (evidence: { kind?: string; startMs: number; endMs: number }) => {
      originalGesture(evidence);
      if (evidence.kind !== "acceleration-spike") throw new Error("Typed gesture leaked into simple mode");
      spikes++;
      if (!spellName || spikes !== 1) return;
      const id = crypto.randomUUID(), startMs = evidence.startMs - 60;
      c.fusion.beginUtterance({ id, generation: c.generation, startMs });
      c.fusion.pushUtterance({ id, generation: c.generation, spell: spellName,
        // A mapped sensor timestamp may lead now within SYNC uncertainty. A real
        // transcription final cannot precede its own captured audio interval.
        startMs, endMs: evidence.endMs, finalAtMs: Math.max(evidence.endMs, performance.now()) });
    };
    c.game.onAck = (message: { command: string; accepted: boolean; reason?: string }) => {
      originalAck(message);
      if (message.command === "cast") acknowledgements.push({ accepted: message.accepted, reason: message.reason });
    };
    // Same short sideways pulse for attacks, shield and healing; no gesture or cast injection.
    const raw = Array.from({ length: 46 }, (_, i) => ({ captureMs: i * 20,
      axMg: i >= 15 && i < 19 ? 650 : 0, ayMg: 0, azMg: 1000, flags: 1 }));
    try {
      await Reflect.get(window, "__scriptedBadge").play("simple-spike", raw);
      const until = performance.now() + (spellName ? 1_500 : 200);
      while (spellName && !acknowledgements.length && performance.now() < until)
        await new Promise(resolve => setTimeout(resolve, 10));
      return { spikes, acknowledgements };
    } finally {
      c.fusion.pushGesture = originalGesture;
      c.game.onAck = originalAck;
    }
  }, spell);
  expect(await spike(null)).toMatchObject({ spikes: 1, acknowledgements: [] });
  // Let the first bot hit supply genuine damage for the healing assertion.
  await expect.poll(async () => (await snapshot(page)).players.P1?.hp, { timeout: 16_000 }).toBe(80);
  for (const spell of ["protego", "stupefy", "expelliarmus", "incendio", "episkey"] as const)
    expect(await spike(spell)).toMatchObject({ spikes: 1, acknowledgements: [{ accepted: true }] });
  const state = await snapshot(page);
  expect(state.players.P1?.hp).toBe(98);
  expect(state.recentEvents.filter(e => e.type === "castAccepted" && e.actor === "P1").map(e => e.spell).sort())
    .toEqual(["episkey", "expelliarmus", "incendio", "protego", "stupefy"]);
  const exported = await page.evaluate(() => JSON.parse(Reflect.get(window, "__duelController").exportTelemetry()));
  expect(exported).toMatchObject({ simpleMotionEnabled: true, gestureProfile: "acceleration-spike-v1" });
  expect(exported.entries.filter((e: { kind: string }) => e.kind === "cast.attempt").map((e: { data: { input: string } }) => e.data.input))
    .toEqual(Array(5).fill("speech+acceleration-spike"));
  await page.locator(".arena-frame").screenshot({ path: "/tmp/wandduel-simple-battle.png" });
  await page.getByRole("button", { name: "Leave duel", exact: true }).click();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("switch", { name: "Dev mode", exact: true }).click();
  await expect(toggle).toHaveCount(0);
});

test("developer mode teaches all five spells and exports raw motion, speech and battle telemetry", async ({ page }) => {
  test.setTimeout(80_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const laptop = await scriptedLaptop(page);
  const dev = page.getByRole("switch", { name: "Dev mode", exact: true });
  await expect(dev).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Say the spells" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tutorial duel", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/wandduel-dev-home.png", fullPage: true });
  await dev.click();
  await expect(dev).toBeChecked();
  await expect(page.getByRole("button", { name: "Tutorial duel", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/wandduel-dev-home-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await connectBadge(page);
  await page.getByRole("button", { name: "Tutorial duel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tutorial duel", exact: true })).toBeVisible();
  await expect(page.getByLabel("Duel code")).toHaveCount(0);
  // A paired physical-input boundary remains mandatory; an unavailable microphone does not block developer clicks.
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, "__duelController").speech.getSnapshot().phase)).not.toBe("listening");
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial).toMatchObject({ step: 0, spell: "stupefy", stage: "instruction", paused: true });
  const guide = page.getByRole("region", { name: "Tutorial guide" });
  await expect(guide.getByRole("heading", { name: "Stupefy", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Cast Stupefy:/ })).toBeDisabled();
  const beforePause = await snapshot(page);
  await page.waitForTimeout(1_200);
  const afterPause = await snapshot(page);
  expect(beforePause.roundEndsAtMs).toBe(0);
  expect(afterPause.roundEndsAtMs).toBe(0);
  expect(afterPause.phase).toBe("playing");
  expect(afterPause.tutorial).toEqual(beforePause.tutorial);
  expect(afterPause.projectiles).toEqual([]);
  expect(afterPause.players.P1?.hp).toBe(100);
  expect(afterPause.players.P2?.hp).toBe(100);
  await expect(page.getByLabel("Time remaining")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/wandduel-tutorial-instruction.png", fullPage: true });
  await guide.getByRole("img").screenshot({ path: "/tmp/wandduel-gesture-jab.png" });
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("practice");
  // The first lesson traverses real raw BLE packet decoding, motion classification and speech/motion fusion.
  expect(await cast(page, "stupefy")).toMatchObject({ accepted: true });
  await expect(page.getByRole("button", { name: /^Cast Stupefy: recharging/ })).toBeDisabled();
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("complete");
  expect((await snapshot(page)).players.P2?.hp).toBe(80);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial).toMatchObject({ step: 1, spell: "protego", stage: "instruction" });
  await guide.getByRole("img").screenshot({ path: "/tmp/wandduel-gesture-raise.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".gesture-wand")).toHaveCSS("animation-name", "none");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/wandduel-tutorial-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const controller = Reflect.get(window, "__duelController");
    return controller.game.snapshot.projectiles.some((projectile: { caster: string; impactAtMs: number }) => projectile.caster === "P2" && projectile.impactAtMs - controller.game.now() < 900);
  }), { intervals: [50] }).toBe(true);
  await page.getByRole("button", { name: /^Cast Protego:/ }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("complete");
  expect((await snapshot(page)).players.P1?.hp).toBe(100);
  expect((await snapshot(page)).recentEvents.some(event => event.type === "impactBlocked" && event.target === "P1")).toBe(true);
  const shieldComplete = await snapshot(page);
  await page.waitForTimeout(400);
  const shieldPaused = await snapshot(page);
  const remainingAt = (state: Awaited<ReturnType<typeof snapshot>>) => state.players.P1!.cooldownUntilMs.protego - state.serverNowMs;
  expect(Math.abs(remainingAt(shieldPaused) - remainingAt(shieldComplete))).toBeLessThan(100);

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial?.spell).toBe("episkey");
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Cast Episkey:/ })).toBeDisabled();
  await expect.poll(async () => (await snapshot(page)).players.P1?.hp).toBe(80);
  await page.getByRole("button", { name: /^Cast Episkey:/ }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("complete");
  expect((await snapshot(page)).players.P1?.hp).toBe(98);
  expect((await snapshot(page)).recentEvents.some(event => event.type === "healed" && event.amount === 18)).toBe(true);

  for (const spell of ["expelliarmus", "incendio"] as const) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).tutorial?.spell).toBe(spell);
    await page.getByRole("button", { name: "Try it", exact: true }).click();
    const button = page.getByRole("button", { name: new RegExp(`^Cast ${spell}:`, "i") });
    await button.click();
    await expect(button).toBeDisabled();
    await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("complete");
    expect((await snapshot(page)).recentEvents.some(event => event.actor === "P1" && event.spell === spell && event.type === (spell === "expelliarmus" ? "offenseLocked" : "damage"))).toBe(true);
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(guide.getByRole("heading", { name: "Your first duel.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Begin duel", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("free");
  await expect(page.getByLabel("Time remaining")).toBeVisible();
  expect((await snapshot(page)).players.P1?.hp).toBe(100);
  expect((await snapshot(page)).players.P2?.hp).toBe(100);
  await page.getByRole("button", { name: /^Cast Stupefy:/ }).click();
  await expect(page.getByRole("button", { name: /^Cast Stupefy:/ })).toBeDisabled();

  // Exercise the real AudioWorklet/endpoint/helper-response telemetry path with synthetic PCM.
  // The helper response is scripted; this proves display/export plumbing, not acoustic accuracy.
  laptop.enableSpeech();
  await page.route("**/api/speech/transcribe", async route => {
    const headers = route.request().headers();
    await route.fulfill({ json: { utteranceId: headers["x-wand-utterance-id"], generation: Number(headers["x-wand-generation"]), text: "stupefy", transcript: "Stupify", spell: "stupefy", accepted: true, inferenceMs: 24 } });
  });
  await page.evaluate(() => Reflect.get(window, "__duelController").startMic());
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__duelController").speech.getSnapshot().phase)).toBe("listening");
  await page.waitForTimeout(250);
  await page.evaluate(async () => {
    const microphone = Reflect.get(window, "__scriptedMicrophone") as ConstantSourceNode;
    microphone.offset.value = 0.08;
    await new Promise(resolve => setTimeout(resolve, 300));
    microphone.offset.value = 0;
  });
  await expect.poll(() => page.evaluate(() => {
    const data = JSON.parse(Reflect.get(window, "__duelController").exportTelemetry());
    return data.entries.some((entry: { kind: string; data: { transcript?: string } }) => entry.kind === "speech.result" && entry.data.transcript === "Stupify");
  })).toBe(true);
  await expect(page.getByLabel("Latest raw transcription")).toHaveText("Stupify");
  // Keep the last transcript readable after high-frequency motion displaces its log row.
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "__duelController").telemetry.snapshot(80).entries.some((entry: { kind: string }) => entry.kind === "speech.result"))).toBe(false);
  await expect(page.getByLabel("Latest raw transcription")).toHaveText("Stupify");
  await page.getByRole("button", { name: "Pause view", exact: true }).click();
  const frozenLog = await page.locator(".telemetry-entries").innerText();
  await page.waitForTimeout(150);
  expect(await page.locator(".telemetry-entries").innerText()).toBe(frozenLog);
  await page.screenshot({ path: "/tmp/wandduel-dev-telemetry.png", fullPage: true });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: false }).click();
  const file = await (await downloading).path();
  const exported = JSON.parse(await readFile(file!, "utf8"));
  expect(exported).toMatchObject({ format: "wandduel-telemetry-v1", mode: "tutorial", developerClicksEnabled: true });
  expect(exported.source).toBe("REAL BLE");
  const kinds = exported.entries.map((entry: { kind: string }) => entry.kind);
  expect(kinds).toEqual(expect.arrayContaining(["wand.raw_motion", "wand.sample", "gesture.candidate", "gesture.accepted", "fusion", "game.ack", "game.event", "speech.result"]));
  expect(exported.entries.find((entry: { kind: string }) => entry.kind === "wand.raw_motion").data.hex).toMatch(/^[\da-f]{2}( [\da-f]{2})+$/);
  expect(exported.entries.find((entry: { kind: string }) => entry.kind === "wand.sample").data).toMatchObject({ axMg: expect.any(Number), ayMg: expect.any(Number), azMg: expect.any(Number), captureMs: expect.any(Number), browserMs: expect.any(Number) });
  expect(exported.entries.some((entry: { kind: string; data: { input?: string } }) => entry.kind === "cast.attempt" && entry.data.input === "developer-click")).toBe(true);
  expect(JSON.stringify(exported)).not.toMatch(/"token"|"sessionToken"|"ownerToken"|"samples":\[/);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByLabel("Latest raw transcription")).toHaveText("Waiting for speech…");
  await expect(page.getByText("Move your wand or say a spell to capture an event.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume view", exact: true }).click();
  await expect(page.locator(".telemetry-entry").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("wrong raw gestures fizzle locally, explain the correction, and allow the next correct cast", async ({ page }) => {
  test.setTimeout(50_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await scriptedLaptop(page);
  await page.getByRole("switch", { name: "Dev mode", exact: true }).click();
  await connectBadge(page);
  await page.getByRole("button", { name: "Tutorial duel", exact: true }).click();
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try it", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try it", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("practice");
  // Lesson one has no bot attack, isolating the absence of any authoritative failure effect.
  const before = await snapshot(page);
  const unchangedByFizzle = async () => {
    const state = await snapshot(page);
    for (const slot of ["P1", "P2"] as const) {
      expect(state.players[slot]?.hp).toBe(before.players[slot]?.hp);
      expect(state.players[slot]?.cooldownUntilMs).toEqual(before.players[slot]?.cooldownUntilMs);
      expect(state.players[slot]?.shieldUntilMs).toBe(before.players[slot]?.shieldUntilMs);
      expect(state.players[slot]?.offenseLockedUntilMs).toBe(before.players[slot]?.offenseLockedUntilMs);
    }
    expect(state.projectiles).toEqual([]);
    expect(state.recentEvents.filter(event => event.type === "castAccepted")).toEqual([]);
    expect(state.tutorial?.stage).toBe("practice");
  };
  await miscast(page, "protego");
  const fizzle = page.getByTestId("local-miscast");
  await expect(fizzle).toHaveAttribute("data-spell", "protego");
  await expect(page.getByRole("img", { name: "Protego fizzled near your wand", exact: true })).toBeVisible();
  await expect(page.getByText("Protego fizzled. Raise your wand and hold briefly.", { exact: true })).toBeVisible();
  await expect(page.locator(".miscast-dialogue")).toHaveCSS("color", "rgb(241, 215, 131)");
  await unchangedByFizzle();
  // Freeze only the decorative SVG at a representative frame; input and referee clocks remain real.
  await fizzle.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 650; animation.pause(); }));
  await page.locator(".arena").screenshot({ path: "/tmp/wandduel-shield-fizzle-preview.png" });
  await page.screenshot({ path: "/tmp/wandduel-protego-fizzle.png", fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".shield-shard").first()).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: "/tmp/wandduel-fizzle-reduced-motion.png", fullPage: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await miscast(page, "episkey");
  await expect(fizzle).toHaveAttribute("data-spell", "episkey");
  await expect(page.getByText("Episkey fizzled. Raise your wand and hold briefly.", { exact: true })).toBeVisible();
  await unchangedByFizzle();
  await fizzle.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 650; animation.pause(); }));
  await page.locator(".arena").screenshot({ path: "/tmp/wandduel-heal-fizzle-preview.png" });
  await page.screenshot({ path: "/tmp/wandduel-healing-fizzle.png", fullPage: true });

  await miscast(page, "incendio");
  await expect(fizzle).toHaveAttribute("data-spell", "incendio");
  await expect(page.getByText("Incendio fizzled. Give your wand a clear forward jab.", { exact: true })).toBeVisible();
  await unchangedByFizzle();
  await fizzle.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = 600; animation.pause(); }));
  await page.locator(".arena").screenshot({ path: "/tmp/wandduel-attack-fizzle-preview.png" });
  await page.screenshot({ path: "/tmp/wandduel-attack-fizzle.png", fullPage: true });
  await page.evaluate(() => Reflect.get(window, "__scriptedBadge").play("lower"));
  expect(await cast(page, "stupefy")).toMatchObject({ accepted: true });
  await expect(fizzle).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).players.P2?.hp).toBe(80);
  await expect.poll(async () => (await snapshot(page)).tutorial?.stage).toBe("complete");
  const ownHud = page.getByRole("region", { name: "Your wizard", exact: true });
  const rivalHud = page.getByRole("region", { name: "Rival wizard", exact: true });
  const assertHudOwnership = async () => {
    await expect(ownHud.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", "100");
    await expect(rivalHud.getByRole("meter", { name: "Opponent health", exact: true })).toHaveAttribute("value", "80");
    await expect(page.locator(".health-panel").getByText("WIZARD", { exact: true })).toHaveCount(0);
    await expect(page.locator(".health-panel").getByText("DUELIST", { exact: true })).toHaveCount(0);
    const ownBounds = (await ownHud.boundingBox())!;
    const rivalBounds = (await rivalHud.boundingBox())!;
    expect(ownBounds.x).toBeLessThan(rivalBounds.x);
    expect(ownBounds.y + ownBounds.height).toBeLessThan(rivalBounds.y);
  };
  await assertHudOwnership();
  await page.locator(".arena").screenshot({ path: "/tmp/wandduel-hud-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertHudOwnership();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator(".arena").screenshot({ path: "/tmp/wandduel-hud-mobile.png" });
  expect(errors).toEqual([]);
});

test("badge trials export a complete raw trial and preserve an interrupted attempt", async ({ page }) => {
  test.setTimeout(35_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await scriptedLaptop(page);
  await page.getByRole("switch", { name: "Dev mode", exact: true }).click();
  await expect(page.getByRole("region", { name: "Gesture trial recorder" })).toHaveCount(0);
  await connectBadge(page);
  const recorder = page.getByRole("region", { name: "Gesture trial recorder" });
  await recorder.getByRole("button", { name: /Record gesture trials/ }).click();
  await recorder.getByLabel("Trial movement").selectOption("protego");
  await recorder.getByRole("checkbox", { name: "Say the spell while moving" }).uncheck();
  await recorder.getByLabel("Grip / environment / observations").fill("Scripted raw badge boundary; synthetic raise, no microphone.");
  await recorder.getByRole("button", { name: "Start 10 trials", exact: true }).click();
  await expect(recorder.getByLabel("Trial movement")).toBeDisabled();
  await expect(recorder.getByText("Raise and hold", { exact: true })).toBeVisible({ timeout: 6_000 });
  await page.evaluate(() => Reflect.get(window, "__scriptedBadge").play("guard"));
  await expect(recorder.getByText("Return to your resting grip", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.evaluate(() => Reflect.get(window, "__scriptedBadge").play("lower"));
  await expect(recorder.getByText("Trial 2 of 10", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(200);
  await page.evaluate(() => Reflect.get(window, "__setVisibility")(true));
  await expect(recorder.getByText("Interrupted — your captured trials are kept", { exact: true })).toBeVisible();
  await expect(recorder.getByRole("button", { name: /Export trial JSON/ })).toBeEnabled();
  await recorder.getByText("1 completed · add notes for individual trials", { exact: true }).click();
  await recorder.getByLabel("Trial 1 observation", { exact: true }).fill("Raise was recognized.");
  await recorder.getByLabel("Trial 2 observation", { exact: true }).fill("Backgrounded during countdown.");
  await page.screenshot({ path: "/tmp/wandduel-gesture-trial-recorder.png", fullPage: true });
  const downloading = page.waitForEvent("download");
  await recorder.getByRole("button", { name: /Export trial JSON/ }).click();
  const file = await (await downloading).path();
  const exported = JSON.parse(await readFile(file!, "utf8"));
  expect(exported).toMatchObject({
    format: "wandduel-gesture-trials-v1", intendedLabel: "protego", expectedGesture: "raise",
    speakDuringMovement: false, completed: 1, stoppedReason: "page_hidden",
    context: { source: "ble", streaming: true },
    metadata: { source: "REAL BLE", firmware: { major: 0, minor: 2, patch: 0 } },
  });
  expect(exported.trials).toHaveLength(10);
  expect(exported.trials[0]).toMatchObject({ number: 1, intendedLabel: "protego", status: "completed", observation: "Raise was recognized." });
  expect(exported.trials[0].phases.map((phase: { phase: string }) => phase.phase)).toEqual(["countdown", "move", "settle", "rest"]);
  expect(exported.trials[0].entries.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining(["wand.raw_motion", "wand.sample", "gesture.accepted"]));
  expect(exported.trials[0].entries.find((entry: { kind: string }) => entry.kind === "wand.raw_motion").data.hex).toMatch(/^[\da-f]{2}( [\da-f]{2})+$/);
  expect(exported.trials[1]).toMatchObject({ number: 2, status: "interrupted", interruption: { reason: "page_hidden" }, observation: "Backgrounded during countdown." });
  expect(exported.trials[1].entries.some((entry: { kind: string }) => entry.kind === "wand.sample")).toBe(true);
  expect(exported.trials.slice(2).every((trial: { status: string }) => trial.status === "pending")).toBe(true);
  expect(JSON.stringify(exported)).not.toMatch(/"token"|"sessionToken"|"ownerToken"|"samples":\[/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/wandduel-gesture-trial-recorder-mobile.png", fullPage: true });
  await recorder.getByRole("button", { name: "Reset trials", exact: true }).click();
  await expect(recorder.getByRole("button", { name: /Export trial JSON/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
