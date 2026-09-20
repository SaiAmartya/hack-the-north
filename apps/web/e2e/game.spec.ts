import { expect, test } from "@playwright/test";
import { scriptedLaptop, connectBadge, snapshot, cast } from "./scripted-laptop";

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

  // React to the actual first projectile; the bot remains active throughout the match.
  await expect.poll(async () => (await snapshot(page)).projectiles.some(projectile =>
    projectile.caster === "P2" && projectile.spell === "stupefy",
  ), { intervals: [50] }).toBe(true);
  expect((await cast(page, "protego")).accepted).toBe(true);
  await expect(page.getByLabel(/^Protego: recharging/)).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).recentEvents.some(event =>
    event.type === "impactBlocked" && event.actor === "P2" && event.target === "P1",
  ), { intervals: [50] }).toBe(true);
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", "100");

  expect((await cast(page, "expelliarmus")).accepted).toBe(true);
  await expect(page.getByLabel(/^Expelliarmus: recharging/)).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).recentEvents.some(event =>
    event.type === "offenseLocked" && event.actor === "P1" && event.target === "P2",
  ), { intervals: [50] }).toBe(true);
  await expect(page.getByLabel("Rival wizard").getByText(/DISARMED/)).toBeVisible();
  expect((await snapshot(page)).recentEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "damage", actor: "P1", spell: "expelliarmus", amount: 10 }),
  ]));
  await page.screenshot({ path: "/tmp/wandduel-solo-battle.png", fullPage: true });

  expect((await cast(page, "incendio")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).players.P1!.hp).toBeLessThanOrEqual(82);
  expect((await cast(page, "episkey")).accepted).toBe(true);
  await expect(page.getByLabel(/^Episkey: recharging/)).toBeVisible();
  expect((await snapshot(page)).recentEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "healed", actor: "P1", spell: "episkey", amount: 18 }),
  ]));
  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Stupefy: recharging/)).toBeVisible();
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  expect(await cast(page, "stupefy")).toMatchObject({ accepted: false, reason: "cooldown" });
  await expect.poll(async () => (await snapshot(page)).recentEvents.some(event =>
    event.type === "damage" && event.actor === "P1" && event.spell === "incendio" && event.amount === 30,
  )).toBe(true);
  const acceptedSpells = (await snapshot(page)).recentEvents
    .filter(event => event.type === "castAccepted" && event.actor === "P1")
    .map(event => event.spell).sort();
  expect(acceptedSpells).toEqual(["episkey", "expelliarmus", "incendio", "protego", "stupefy"]);
  await expect(page.getByRole("progressbar")).toHaveCount(5);

  // Stop defending and let the real opponent finish, proving its attacks reach a normal result.
  await expect(page.getByRole("heading", { name: "Defeat!", exact: true })).toBeVisible({ timeout: 45_000 });
  expect((await snapshot(page)).result).toMatchObject({ outcome: "win", winner: "P2" });
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", "0");
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
