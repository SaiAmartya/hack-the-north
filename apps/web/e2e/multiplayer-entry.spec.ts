import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { Snapshot, Spell } from "../src/game/contracts";

// Browser-boundary fixtures retain the real BLE adapter, protocol, controller and referee.
async function scriptedLaptop(page: Page) {
  let speechAvailable = false;
  await page.route("**/api/speech/health", (route) =>
    route.fulfill(speechAvailable
      ? { json: { status: "ok", ready: true, warm: true, busy: false, workerAvailable: true } }
      : { status: 503 }),
  );
  // Capture the existing controller only in Playwright's served response, never in the app bundle.
  await page.route(/\/src\/game\/GameApp\.tsx(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain("const next = new DuelController();");
    await route.fulfill({ response, body: body.replace("const next = new DuelController();", "const next = new DuelController(); window.__duelController = next;") });
  });
  await page.route(/\/src\/wand\/transport\.ts(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}
import { VirtualWandEndpoint } from "/src/wand/endpoint.ts";
import { RawMotionTraceBuilder } from "/src/input/traceFixtures.ts";
const endpoint = new VirtualWandEndpoint({
  nowMs: () => performance.now(),
  info: { version: 1, capabilities: 15, sampleHz: 50, rangeG: 8,
    deviceId: Array.from(crypto.getRandomValues(new Uint8Array(6))), bootId: 1,
    firmware: { major: 0, minor: 2, patch: 0 }, axisConvention: 1 },
});
const traces = new RawMotionTraceBuilder();
const probe = { chooser: 0, connects: 0, disconnects: 0, healthTransitions: [], longTasks: [], deliveries: [] };
window.__scriptedBadge = probe;
new PerformanceObserver(list => {
  for (const task of list.getEntries()) probe.longTasks.push({ start: task.startTime, duration: task.duration });
  probe.longTasks = probe.longTasks.slice(-10);
}).observe({ type: "longtask", buffered: true });
let timer, sequence = 0, replaying = false, previousCapture;
const emit = sample => {
  const captureMs = sample.captureMs ?? Math.floor(performance.now());
  // Ending replay and resuming idle can share one millisecond; one acquisition is enough.
  if (captureMs === previousCapture) return true;
  previousCapture = captureMs;
  return endpoint.emitMotion({ ...sample, version: 1, flags: 1,
    seq: sequence++ & 65535, captureMs, bootId: 1 });
};
probe.play = async (movement) => {
  if (replaying) throw new Error("Concurrent scripted movement");
  const samples = movement === "guard" ? traces.guard(32)
    : movement === "lower" ? traces.lower(32) : traces.jab(850, 0, undefined, 1, 0);
  replaying = true;
  const startedAt = Math.ceil(performance.now()) + 20;
  const delivery = { movement, maxLateMs: 0 };
  probe.deliveries.push(delivery);
  try {
    for (const sample of samples) {
      const captureAt = startedAt + sample.browserMs - samples[0].browserMs;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.ceil(captureAt - performance.now()))));
      delivery.maxLateMs = Math.max(delivery.maxLateMs, performance.now() - captureAt);
      if (performance.now() - captureAt > 100) throw new Error("Scripted motion stalled: " + JSON.stringify({
        movement, lateMs: performance.now() - captureAt, captureAt,
        nativeVisibility: Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get.call(document),
        focused: document.hasFocus(), longTasks: probe.longTasks,
      }));
      // Like the existing QA harness, preserve the device's 50 Hz acquisition clock.
      // Browser delivery jitter must not change the recorded stroke's duration.
      if (!emit({ ...sample, captureMs: Math.floor(captureAt) >>> 0 })) throw new Error("Scripted badge is not streaming");
    }
  } finally { replaying = false; }
};
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
      const [axMg, ayMg, azMg] = traces.currentPose().map(Math.round);
      if (!replaying) emit({ axMg, ayMg, azMg });
      const wand = window.__duelController?.wand?.getSnapshot();
      if (wand) {
        const state = JSON.stringify({ generation: wand.generation, phase: wand.phase, issue: wand.issue });
        if (probe.healthTransitions.at(-1) !== state) probe.healthTransitions.push(state);
      }
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
  await expect(page.getByRole("heading", { name: /Your wand.*is ready/ })).toBeVisible();
}

test.afterEach(async ({ context, browser }, testInfo) => {
  const laptops = browser.contexts();
  try {
    const timing = await Promise.all(laptops.flatMap(laptop => laptop.pages()).map(player => player.evaluate(() => {
      const badge = Reflect.get(window, "__scriptedBadge");
      if (!badge) return null;
      const gl = document.querySelector<HTMLCanvasElement>(".spell-canvas")?.getContext("webgl2");
      const debug = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        renderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable",
        nativeVisibility: Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get?.call(document),
        focused: document.hasFocus(), deliveries: badge.deliveries, longTasks: badge.longTasks,
      };
    })));
    const path = testInfo.outputPath("scripted-input-timing.json");
    await writeFile(path, JSON.stringify(timing, null, 2));
    await testInfo.attach("scripted-input-timing", { path, contentType: "application/json" });
  } finally {
    await Promise.all(laptops.filter(laptop => laptop !== context).map(laptop => laptop.close()));
  }
});

test("wand pairing precedes room creation and opens the lobby without calibration", async ({ page }) => {
  await scriptedLaptop(page);
  await expect(page.getByRole("button", { name: "Start a duel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await connectBadge(page);
  await page.getByLabel("Already have a duel code?").fill("abc");
  await page.getByRole("button", { name: "Join with code", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter the six-character duel code.");
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = await page.getByLabel("Duel code").textContent();
  await expect(page.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
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

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => Reflect.get(window, "__duelController").game.snapshot);
}

async function cast(page: Page, spell: Spell): Promise<{ accepted: boolean; reason?: string }> {
  return page.evaluate(async spellName => {
    const controller = Reflect.get(window, "__duelController");
    const badge = Reflect.get(window, "__scriptedBadge");
    if (!controller.healthy()) throw new Error("Scripted laptop input is unhealthy");
    controller.fusion.reset(controller.generation);
    controller.motion.clearPending("scripted browser test");
    let gesture: { id: string; spell: string; startMs: number; endMs: number } | undefined;
    let ack: { accepted: boolean; reason?: string } | undefined;
    const originalGesture = controller.fusion.pushGesture.bind(controller.fusion);
    const originalAck = controller.game.onAck;
    controller.fusion.pushGesture = (evidence: typeof gesture) => { gesture = evidence; originalGesture(evidence); };
    controller.game.onAck = (message: { command: string; accepted: boolean; reason?: string }) => {
      originalAck(message);
      if (message.command === "cast") ack = message;
    };
    const support = spellName === "protego" || spellName === "episkey";
    try {
      await badge.play(support ? "guard" : "jab");
      if (!gesture || gesture.spell !== (support ? "protego" : "stupefy"))
        throw new Error(`No raw gesture for ${spellName}: ${JSON.stringify({
          motion: controller.motion.getState(), diagnostics: controller.motion.getDiagnostics(),
          wand: controller.wand.getSnapshot().issue,
          mic: controller.speech.getSnapshot().issue, phase: controller.game.snapshot?.phase,
          result: controller.game.snapshot?.result,
        })}`);
      const id = crypto.randomUUID(), startMs = gesture.startMs + 20;
      const endMs = Math.max(startMs + 20, gesture.endMs);
      // Only voice recognition is scripted. Raw sensor bytes still traverse the BLE adapter,
      // WandClient and MotionRecognizer, and the real fusion/controller submit the cast.
      controller.fusion.beginUtterance({ id, generation: controller.generation, startMs });
      controller.fusion.pushUtterance({ id, generation: controller.generation, spell: spellName,
        startMs, endMs, finalAtMs: Math.max(endMs, performance.now()) });
      const until = performance.now() + 2_000;
      while (!ack && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      if (!ack) throw new Error(`No ${spellName} referee acknowledgement: ${JSON.stringify({
        fusion: controller.fusion.getState(), healthy: controller.healthy(),
        wand: controller.wand.getSnapshot().issue, wandPhase: controller.wand.getSnapshot().phase,
        mic: controller.speech.getSnapshot(), phase: controller.game.snapshot?.phase,
        result: controller.game.snapshot?.result, transitions: badge.healthTransitions,
      })}`);
      if (support) await badge.play("lower");
      return { accepted: ack.accepted, reason: ack.reason };
    } finally {
      controller.fusion.pushGesture = originalGesture;
      controller.game.onAck = originalAck;
    }
  }, spell);
}

async function sharedHealth(first: Page, second: Page, hp: number) {
  await expect(first.getByRole("meter", { name: "Opponent health" })).toHaveAttribute("value", String(hp));
  await expect(second.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", String(hp));
  expect((await snapshot(first)).players.P2?.hp).toBe(hp);
  expect((await snapshot(second)).players.P2?.hp).toBe(hp);
}

test("two ordinary player views sync five spells, cooldowns, victory, rematch and recovery", async ({ page, browser }) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const first = await scriptedLaptop(page);
  await connectBadge(page);
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = (await page.getByLabel("Duel code").textContent())!;
  await expect(page.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeDisabled();
  // Each laptop has its own browser storage and renderer context.
  const opponentContext = await browser.newContext({
    baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 },
  });
  const opponent = await opponentContext.newPage();
  opponent.on("pageerror", error => errors.push(error.message));
  const second = await scriptedLaptop(opponent);
  await connectBadge(opponent);
  await opponent.getByLabel("Already have a duel code?").fill(code.toLowerCase());
  await opponent.getByRole("button", { name: "Join with code", exact: true }).click();
  await expect(opponent.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
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
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  await expect.poll(async () => (await snapshot(opponent)).phase).toBe("playing");
  const firstRound = (await snapshot(page)).roundId;
  const rules = await page.evaluate(() => Reflect.get(window, "__duelController").game.rules.spells);
  expect(rules.map((rule: { cooldownMs: number }) => rule.cooldownMs)).toEqual([2000, 3000, 6000, 8000, 12000]);
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  expect(await page.locator(".spell-slot").evaluateAll(cards =>
    cards.every(card => card.scrollWidth <= card.clientWidth + 1),
  )).toBe(true);
  await page.screenshot({ path: "/tmp/wandduel-battle.png", fullPage: true });
  await page.getByRole("region", { name: "Spell book" }).screenshot({ path: "/tmp/wandduel-hud.png" });

  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Stupefy: recharging/)).toBeVisible();
  expect((await cast(opponent, "protego")).accepted).toBe(true);
  await expect(opponent.getByLabel(/^Protego: recharging/)).toBeVisible();
  for (const player of [page, opponent])
    await expect.poll(async () => (await snapshot(player)).recentEvents.some(event => event.type === "impactBlocked")).toBe(true);
  await sharedHealth(page, opponent, 100);

  expect((await cast(page, "incendio")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  // The other attack can cast while Incendio is still cooling down: no shared cooldown.
  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  await sharedHealth(page, opponent, 50);
  expect(await cast(page, "incendio")).toMatchObject({ accepted: false, reason: "cooldown" });
  await sharedHealth(page, opponent, 50);

  expect((await cast(opponent, "episkey")).accepted).toBe(true);
  await sharedHealth(page, opponent, 68);
  await expect(opponent.getByLabel(/^Episkey: recharging/)).toBeVisible();
  expect(await cast(opponent, "episkey")).toMatchObject({ accepted: false, reason: "cooldown" });
  await sharedHealth(page, opponent, 68);

  expect((await cast(page, "expelliarmus")).accepted).toBe(true);
  await expect(page.getByLabel(/^Expelliarmus: recharging/)).toBeVisible();
  await sharedHealth(page, opponent, 58);
  await expect(page.getByLabel("Rival wizard").getByText(/DISARMED/)).toBeVisible();
  await expect(opponent.getByLabel("Your wizard", { exact: true }).getByText(/DISARMED/)).toBeVisible();
  await page.screenshot({ path: "/tmp/wandduel-disarm.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  await page.screenshot({ path: "/tmp/wandduel-battle-narrow.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  expect(await page.locator(".spell-slot").evaluateAll(cards =>
    cards.every(card => card.scrollWidth <= card.clientWidth + 1),
  )).toBe(true);
  expect(await page.locator(".wizard").evaluateAll(wizards =>
    wizards.every(wizard => getComputedStyle(wizard).animationName === "none"),
  )).toBe(true);
  await page.screenshot({ path: "/tmp/wandduel-battle-zoom-reduced.png", fullPage: true });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const hp of [38, 18, 0]) {
    expect((await cast(page, "stupefy")).accepted).toBe(true);
    await sharedHealth(page, opponent, hp);
  }
  await expect(page.getByRole("heading", { name: "Victory!" })).toBeVisible();
  await expect(opponent.getByRole("heading", { name: "Defeat!" })).toBeVisible();
  expect((await snapshot(page)).result).toMatchObject({ outcome: "win", winner: "P1" });
  expect((await snapshot(opponent)).result).toEqual((await snapshot(page)).result);
  await page.screenshot({ path: "/tmp/wandduel-victory.png", fullPage: true });
  await opponent.screenshot({ path: "/tmp/wandduel-defeat.png", fullPage: true });
  for (const player of [page, opponent]) await player.getByRole("button", { name: "Rematch", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  expect((await snapshot(page)).roundId).toBeGreaterThan(firstRound);
  await sharedHealth(page, opponent, 100);

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
  expect(errors).toEqual([]);
});
