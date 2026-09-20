import { expect, type Page } from "@playwright/test";
import type { Snapshot, Spell } from "../src/game/contracts";

// Browser-boundary fixtures retain the real BLE adapter, protocol, controller and referee.
export async function scriptedLaptop(page: Page) {
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
  return endpoint.emitMotion({ ...sample, version: 1, flags: sample.flags ?? 1,
    seq: sequence++ & 65535, captureMs, bootId: 1 });
};
probe.play = async (movement, recording) => {
  if (replaying) throw new Error("Concurrent scripted movement");
  const samples = recording ?? (movement === "guard" ? traces.guard(32, 320, 320, 500)
    : movement === "lower" ? traces.lower(32) : traces.jab(850, 0, undefined, 1, 0));
  replaying = true;
  const startedAt = Math.ceil(performance.now()) + 20;
  const delivery = { movement, maxLateMs: 0 };
  probe.deliveries.push(delivery);
  try {
    for (const sample of samples) {
      const captureAt = startedAt + sample.captureMs - samples[0].captureMs;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.ceil(captureAt - performance.now()))));
      delivery.maxLateMs = Math.max(delivery.maxLateMs, performance.now() - captureAt);
      if (performance.now() - captureAt > 100) throw new Error("Scripted motion stalled: " + JSON.stringify({
        movement, lateMs: performance.now() - captureAt, captureAt,
        nativeVisibility: Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState").get.call(document),
        focused: document.hasFocus(), longTasks: probe.longTasks,
      }));
      // Rebase the device clock into a fresh boot while preserving acquisition intervals.
      // Browser delivery jitter must not change the recorded stroke's duration.
      if (!emit({ ...sample, captureMs: Math.floor(captureAt) >>> 0 })) throw new Error("Scripted badge is not streaming");
    }
  } finally {
    if (recording) {
      const last = recording.at(-1);
      probe.pose = [last.axMg, last.ayMg, last.azMg];
    }
    replaying = false;
  }
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
      const [axMg, ayMg, azMg] = (probe.pose ?? traces.currentPose()).map(Math.round);
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
        Reflect.set(window, "__scriptedMicrophone", source);
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

export async function connectBadge(page: Page) {
  await page.getByRole("button", { name: "Connect badge", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your wand.*is ready/ })).toBeVisible();
}

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => Reflect.get(window, "__duelController").game.snapshot);
}

/** Script only recognized speech; the deliberately wrong movement still crosses the raw BLE boundary. */
export async function miscast(page: Page, spell: Spell): Promise<void> {
  await page.evaluate(async spellName => {
    const controller = Reflect.get(window, "__duelController");
    const badge = Reflect.get(window, "__scriptedBadge");
    if (!controller.healthy()) throw new Error("Scripted laptop input is unhealthy");
    controller.fusion.reset(controller.generation);
    controller.motion.clearPending("scripted mismatched gesture");
    let gesture: { id: string; spell: string; startMs: number; endMs: number } | undefined;
    const originalGesture = controller.fusion.pushGesture.bind(controller.fusion);
    controller.fusion.pushGesture = (evidence: typeof gesture) => { gesture = evidence; originalGesture(evidence); };
    const support = spellName === "protego" || spellName === "episkey";
    try {
      await badge.play(support ? "jab" : "guard");
      if (!gesture || gesture.spell !== (support ? "stupefy" : "protego"))
        throw new Error(`No mismatched raw gesture: ${JSON.stringify(controller.motion.getDiagnostics())}`);
      const id = crypto.randomUUID(), startMs = gesture.startMs + 20;
      const endMs = Math.max(startMs + 20, gesture.endMs);
      controller.fusion.beginUtterance({ id, generation: controller.generation, startMs });
      controller.fusion.pushUtterance({ id, generation: controller.generation, spell: spellName,
        startMs, endMs, finalAtMs: Math.max(endMs, performance.now()) });
      if (controller.fusion.getState().lastRejection !== "spell-gesture-mismatch")
        throw new Error(`Expected wrong-gesture rejection: ${JSON.stringify(controller.fusion.getState())}`);
    } finally {
      controller.fusion.pushGesture = originalGesture;
    }
  }, spell);
}

export async function cast(page: Page, spell: Spell): Promise<{ accepted: boolean; reason?: string; projectileId?: string }> {
  return page.evaluate(async spellName => {
    const controller = Reflect.get(window, "__duelController");
    const badge = Reflect.get(window, "__scriptedBadge");
    if (!controller.healthy()) throw new Error("Scripted laptop input is unhealthy");
    controller.fusion.reset(controller.generation);
    controller.motion.clearPending("scripted browser test");
    let gesture: { id: string; spell: string; startMs: number; endMs: number } | undefined;
    let ack: { accepted: boolean; reason?: string; projectileId?: string } | undefined;
    const originalGesture = controller.fusion.pushGesture.bind(controller.fusion);
    const originalAck = controller.game.onAck;
    controller.fusion.pushGesture = (evidence: typeof gesture) => { gesture = evidence; originalGesture(evidence); };
    controller.game.onAck = (message: { command: string; accepted: boolean; reason?: string; projectileId?: string }) => {
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
      return { accepted: ack.accepted, reason: ack.reason, projectileId: ack.projectileId };
    } finally {
      controller.fusion.pushGesture = originalGesture;
      controller.game.onAck = originalAck;
    }
  }, spell);
}
