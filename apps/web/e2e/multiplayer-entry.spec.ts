import { expect, test, type Page } from "@playwright/test";

// Browser-boundary fixtures retain the real BLE adapter, protocol, controller and referee.
async function scriptedLaptop(page: Page) {
  let speechAvailable = false;
  await page.route("**/api/speech/health", (route) =>
    route.fulfill(speechAvailable
      ? { json: { status: "ok", ready: true, warm: true, busy: false, workerAvailable: true } }
      : { status: 503 }),
  );
  await page.route(/\/src\/wand\/transport\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}
import { VirtualWandEndpoint } from "/src/wand/endpoint.ts";
const endpoint = new VirtualWandEndpoint({
  nowMs: () => performance.now(),
  info: { version: 1, capabilities: 15, sampleHz: 50, rangeG: 8,
    deviceId: Array.from(crypto.getRandomValues(new Uint8Array(6))), bootId: 1,
    firmware: { major: 0, minor: 2, patch: 0 }, axisConvention: 1 },
});
const probe = { chooser: 0, connects: 0, disconnects: 0 };
window.__scriptedBadge = probe;
let timer, sequence = 0;
class Characteristic extends EventTarget {
  constructor(kind) { super(); this.kind = kind; }
  async readValue() {
    const bytes = this.kind === "info" ? endpoint.readInfo() : endpoint.readStatus();
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  async writeValueWithResponse(value) { endpoint.writeControl(new Uint8Array(value)); }
  async startNotifications() {
    const notify = bytes => {
      this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    };
    if (this.kind === "motion") endpoint.subscribeMotion(notify);
    else endpoint.subscribeStatus(notify);
    return this;
  }
}
const device = new EventTarget();
device.id = "scripted-badge";
device.gatt = {
  async connect() {
    probe.connects++;
    clearInterval(timer);
    timer = setInterval(() => {
      endpoint.tick();
      endpoint.emitMotion({ version: 1, flags: 1, seq: sequence++ & 65535,
        captureMs: Math.floor(performance.now()), bootId: 1, axMg: 0, ayMg: 0, azMg: 1000 });
    }, 20);
    return this;
  },
  disconnect() { probe.disconnects++; clearInterval(timer); endpoint.disconnect(); },
  async getPrimaryService() {
    const characteristics = new Map();
    return { async getCharacteristic(uuid) {
      if (!characteristics.has(uuid)) {
        const kind = Object.entries(WAND_UUIDS).find(([, value]) => value === uuid)[0];
        characteristics.set(uuid, new Characteristic(kind));
      }
      return characteristics.get(uuid);
    } };
  },
};
Object.defineProperty(navigator, "bluetooth", {
  configurable: true,
  value: { async requestDevice() { probe.chooser++; return device; } },
});`,
    });
  });
  await page.addInitScript(() => {
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args: ConstructorParameters<typeof WebSocket>) {
        const socket = new Target(...args);
        if (new URL(socket.url).pathname === "/ws/game") Reflect.set(window, "__battleSocket", socket);
        return socket;
      },
    });
    let hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    Object.defineProperty(document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
    Reflect.set(window, "__setVisibility", (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const context = new AudioContext({ sampleRate: 16000 });
        const source = context.createConstantSource();
        source.offset.value = 0;
        const destination = context.createMediaStreamDestination();
        destination.channelCount = 1;
        source.connect(destination);
        source.start();
        await context.resume();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); void context.close(); };
        }
        return destination.stream;
      },
    });
  });
  await page.goto("/");
  return { enableSpeech: () => { speechAvailable = true; }, disableSpeech: () => { speechAvailable = false; } };
}

async function connectBadge(page: Page) {
  await page.getByRole("button", { name: "Connect badge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
}

test("a paired wand lands in the battle lobby at once, with no calibration or practice step", async ({ page }) => {
  await scriptedLaptop(page);
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = await page.getByLabel("Duel code").textContent();
  await connectBadge(page);
  await expect(page.getByRole("button", { name: /practice|calibrat|join battle/i })).toHaveCount(0);
  await expect(page.locator("main")).toHaveClass(/in-duel/);
  await expect(page.getByLabel("Duel code")).toHaveText(code!);
  await expect(page.getByText("Share this code with your rival.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable microphone", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Enable camera", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/multiplayer-lobby-narrow.png", fullPage: true });
});

test("two player lobbies start a duel and recover visibility without choosing the badge again", async ({ page, context }) => {
  test.setTimeout(45_000);
  const first = await scriptedLaptop(page);
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = (await page.getByLabel("Duel code").textContent())!;
  await connectBadge(page);
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeDisabled();
  const opponent = await context.newPage();
  const second = await scriptedLaptop(opponent);
  await opponent.getByLabel("Duel code").fill(code);
  await opponent.getByRole("button", { name: "Join with code", exact: true }).click();
  await connectBadge(opponent);
  for (const player of [page, opponent])
    await expect(player.getByText("Your rival has joined.")).toBeVisible();
  first.enableSpeech();
  second.enableSpeech();
  for (const player of [page, opponent]) {
    await player.getByRole("button", { name: "Enable microphone", exact: true }).click();
    await expect(player.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  }
  await page.screenshot({ path: "test-results/multiplayer-lobby-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await opponent.getByRole("button", { name: "Ready", exact: true }).click();
  for (const player of [page, opponent])
    await expect(player.getByRole("meter", { name: "Opponent health" })).toBeVisible();

  const paired = await page.evaluate(() => ({ ...Reflect.get(window, "__scriptedBadge") }));
  first.disableSpeech();
  await page.evaluate(() => Reflect.get(window, "__setVisibility")(true));
  await expect(page.getByRole("heading", { name: "Duel paused" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").disconnects)).toBe(paired.disconnects);
  await page.evaluate(() => Reflect.get(window, "__setVisibility")(false));
  await expect(page.getByRole("button", { name: "Enable microphone", exact: true })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByLabel("Duel code")).toHaveText(code);
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").chooser)).toBe(1);
  first.enableSpeech();
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Duel paused" })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "__battleSocket").close());
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reconnect battle", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Duel code")).toHaveText(code);
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").chooser)).toBe(1);
  await opponent.close();
});
