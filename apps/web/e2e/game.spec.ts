import { expect, test } from "@playwright/test";

test("badge and iPhone are the only player connection actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Connect badge", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button",{name:"Connect iPhone",exact:true})).toBeVisible();
  await expect(page.getByText(/virtual|device lab|simulated/i)).toHaveCount(0);
  await page.screenshot({ path: "/tmp/wandduel-home.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Connect badge", exact: true }),
  ).toBeVisible();
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
            claim: () => undefined,
          };
          Reflect.set(window, "__hostedPhoneSocket", record);
          const socket = {
            url,
            readyState: NativeWebSocket.CONNECTING,
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
    page.getByRole("heading", { name: "Connecting your iPhone…" }),
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
