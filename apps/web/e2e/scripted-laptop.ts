import { expect, type Page, type Route } from "@playwright/test";
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
  const batch = [];
  let batchStart = startedAt;
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
      batch.push({ ...sample, captureMs: Math.floor(captureAt) >>> 0 });
      if (!probe.batchMs || captureAt - batchStart >= probe.batchMs || sample === samples.at(-1)) {
        for (const queued of batch) if (!emit(queued)) throw new Error("Scripted badge is not streaming");
        batch.length = 0;
        batchStart = captureAt;
      }
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
    const network = { castDelayMs: 0, casts: [] as { queuedAtMs: number; sentAtMs?: number }[], acknowledgements: [] as unknown[] };
    Reflect.set(window, "__scriptedNetwork", network);
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args: ConstructorParameters<typeof WebSocket>) {
        const socket = new Target(...args);
        if (new URL(socket.url).pathname === "/ws/game") {
          Reflect.set(window, "__battleSocket", socket);
          socket.addEventListener("message", event => {
            const message = JSON.parse(event.data);
            if (message.type === "ack") network.acknowledgements.push({ command: message.command,
              accepted: message.accepted, reason: message.reason, atMs: performance.now() });
          });
          const send = socket.send.bind(socket);
          socket.send = data => {
            if (typeof data !== "string" || JSON.parse(data).type !== "cast") return send(data);
            const delivery: { queuedAtMs: number; sentAtMs?: number } = { queuedAtMs: performance.now() };
            network.casts.push(delivery);
            const deliver = () => { delivery.sentAtMs = performance.now(); send(data); };
            if (network.castDelayMs) setTimeout(deliver, network.castDelayMs);
            else deliver();
          };
        }
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

export type CastOrder = "overlap" | "speech-first" | "movement-first";

/** Real microphone capture/endpoint and raw BLE; only local ASR decoding is scripted. */
export async function castWithMicrophone(
  page: Page,
  spell: "stupefy" | "protego",
  order: CastOrder,
  { gapMs = 1_400, inferenceDelayMs = 350 } = {},
) {
  const requests: { bytes: number; startMs: number; endMs: number }[] = [];
  const transcribe = async (route: Route) => {
    const request = route.request(), headers = request.headers();
    requests.push({ bytes: request.postDataBuffer()?.byteLength ?? 0,
      startMs: Number(headers["x-wand-voice-start-ms"]), endMs: Number(headers["x-wand-voice-end-ms"]) });
    await new Promise(resolve => setTimeout(resolve, inferenceDelayMs));
    await route.fulfill({ json: {
      utteranceId: headers["x-wand-utterance-id"], generation: Number(headers["x-wand-generation"]),
      text: spell, transcript: spell, spell, accepted: true, inferenceMs: inferenceDelayMs,
    } });
  };
  await page.route("**/api/speech/transcribe", transcribe);
  try {
    const proof = await page.evaluate(async ({ spellName, order, gapMs }) => {
      const c = Reflect.get(window, "__duelController");
      const badge = Reflect.get(window, "__scriptedBadge");
      const network = Reflect.get(window, "__scriptedNetwork");
      const microphone = Reflect.get(window, "__scriptedMicrophone") as ConstantSourceNode;
      if (!c.healthy() || c.devMode || c.simpleMotion || c.speech.getSnapshot().phase !== "listening")
        throw new Error("Microphone timing QA requires healthy normal-mode input");
      type Interval = { id: string; spell: string; startMs: number; endMs: number };
      const gestures: Interval[] = [];
      const voices: (Interval & { arrivedMs: number })[] = [];
      const acknowledgements: { accepted: boolean; reason?: string; atMs: number }[] = [];
      const originalGesture = c.fusion.pushGesture.bind(c.fusion), originalAck = c.game.onAck;
      const generation = c.generation, sendsBefore = network.casts.length;
      // Observers delegate unchanged. No fusion reset, fabricated interval or direct evidence injection.
      c.fusion.pushGesture = (evidence: Interval) => { gestures.push({ ...evidence }); originalGesture(evidence); };
      const unsubscribe = c.speech.onSpeech((evidence: Interval & { arrivedMs: number }) => voices.push({ ...evidence }));
      c.game.onAck = (message: { command: string; accepted: boolean; reason?: string }) => {
        originalAck(message);
        if (message.command === "cast") acknowledgements.push({ accepted: message.accepted, reason: message.reason, atMs: performance.now() });
      };
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
      const until = async (condition: () => boolean, label: string) => {
        const deadline = performance.now() + 5_000;
        while (!condition() && performance.now() < deadline) await delay(10);
        if (!condition()) throw new Error(`${label}: ${JSON.stringify({ voices, gestures, acknowledgements,
          fusion: c.fusion.getState(), speech: c.speech.getSnapshot(), motion: c.motion.getDiagnostics(),
          wand: c.wand.getSnapshot().issue, phase: c.game.snapshot?.phase })}`);
      };
      const say = async () => {
        microphone.offset.value = 0.08;
        await delay(320);
        microphone.offset.value = 0;
        await until(() => voices.length > 0, "No real speech evidence from synthetic PCM");
      };
      const movement = spellName === "protego" ? "guard" : "jab";
      try {
        if (order === "overlap") {
          const moving = badge.play(movement);
          await delay(200);
          await say();
          await moving;
        } else if (order === "speech-first") {
          await say();
          // The existing trace begins with ~350 ms of grip/wind-up before detected onset.
          // Assertions check the captured interval, not this scheduling approximation.
          await delay(voices[0].endMs + gapMs - 350 - performance.now());
          await badge.play(movement);
        } else {
          await badge.play(movement);
          await until(() => gestures.length > 0, "Raw BLE gesture did not classify");
          await delay(gestures[0].endMs + gapMs - performance.now());
          await say();
        }
        await until(() => acknowledgements.length > 0, "No referee acknowledgement");
        if (spellName === "protego") await badge.play("lower");
        await delay(500); // Keep live callbacks/timers running to catch duplicate submissions.
        if (c.generation !== generation) throw new Error("Input generation changed during cast proof");
        return { gestures, voices, acknowledgements, sends: network.casts.slice(sendsBefore),
          healthy: c.healthy(), rejectedSamples: c.wand.getSnapshot().rejected };
      } finally {
        microphone.offset.value = 0;
        unsubscribe();
        c.fusion.pushGesture = originalGesture;
        c.game.onAck = originalAck;
      }
    }, { spellName: spell, order, gapMs });
    expect(requests).toHaveLength(1);
    expect(requests[0].bytes).toBeGreaterThan(0);
    expect(requests[0].bytes).toBeLessThanOrEqual(96_000);
    expect(proof.voices).toHaveLength(1);
    expect(proof.gestures).toHaveLength(1);
    expect(proof.voices[0].spell).toBe(spell);
    expect(proof.gestures[0].spell).toBe(spell);
    expect(proof.acknowledgements).toEqual([expect.objectContaining({ accepted: true })]);
    expect(proof.sends).toHaveLength(1);
    expect(proof.healthy).toBe(true);
    expect(proof.rejectedSamples).toBe(0);
    const voice = proof.voices[0], motion = proof.gestures[0];
    const intervalGap = Math.max(0, voice.startMs - motion.endMs, motion.startMs - voice.endMs);
    if (order === "overlap") {
      expect(Math.min(voice.endMs, motion.endMs) - Math.max(voice.startMs, motion.startMs)).toBeGreaterThan(0);
    } else {
      expect(intervalGap).toBeGreaterThanOrEqual(1_200);
      expect(intervalGap).toBeLessThanOrEqual(1_600);
      if (order === "speech-first") expect(voice.arrivedMs).toBeLessThan(motion.startMs);
    }
    return { ...proof, intervalGap, requests };
  } finally {
    await page.unroute("**/api/speech/transcribe", transcribe);
  }
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
      const expires = performance.now() + 7_500;
      while (controller.fusion.getState().pendingUtterance && performance.now() < expires)
        await new Promise(resolve => setTimeout(resolve, 20));
      if (controller.fusion.getState().lastRejection !== "spell-gesture-mismatch")
        throw new Error(`Expected wrong-gesture rejection: ${JSON.stringify(controller.fusion.getState())}`);
    } finally {
      controller.fusion.pushGesture = originalGesture;
    }
  }, spell);
}

export async function cast(page: Page, spell: Spell, speechGapMs = 0): Promise<{ accepted: boolean; reason?: string; projectileId?: string }> {
  return page.evaluate(async ({ spellName, speechGapMs }) => {
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
      const id = crypto.randomUUID(), startMs = speechGapMs ? gesture.endMs + speechGapMs : gesture.startMs + 20;
      const endMs = speechGapMs ? startMs + 240 : Math.max(startMs + 20, gesture.endMs);
      if (endMs > performance.now()) await new Promise(resolve => setTimeout(resolve, Math.ceil(endMs - performance.now())));
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
  }, { spellName: spell, speechGapMs });
}
