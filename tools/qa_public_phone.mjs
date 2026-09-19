/** Live hosted-path smoke with injected sensors, never physical-iPhone evidence. */
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const service = new URL(process.argv[2] ?? "");
const durationSeconds = Number(process.argv[3] ?? 60);
if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 600)
  throw new Error("Supply a rehearsal duration of 10..600 seconds");
if (service.protocol !== "https:" || service.username || service.password || service.search || service.hash || service.pathname !== "/")
  throw new Error("Supply the approved HTTPS phone service origin");
const browser = await chromium.launch({ headless: true });
let passed = false;
let desktop, phone;
const receivedKinds = {};
const relayErrors = [];
try {
  for (const path of ["/api/speech/health", "/api/game/health", "/src/main.tsx", "/__qa/game", "/@vite/client"]) {
    const response = await fetch(new URL(path, service), { redirect: "error" });
    if (response.status !== 404) throw new Error(`Public isolation failed for ${path}`);
  }
  desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let motionFrames = 0, sequenceGaps = 0, lastSequence, lastArrival;
  let maxArrivalGapMs = 0;
  const syncSent = new Map();
  const syncRtts = [];
  desktop.on("websocket", (socket) => {
    if (!socket.url().startsWith(service.origin.replace("https:", "wss:") + "/ws/")) return;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type !== "op" || frame.operation !== "control" || frame.data?.[1] !== 2) return;
      syncSent.set(frame.data[2] | frame.data[3] << 8, performance.now());
      if (syncSent.size > 32) syncSent.delete(syncSent.keys().next().value);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      const kind = ["notify", "reply", "paired", "claim", "closed", "error"].includes(frame.type) ? frame.type : "other";
      receivedKinds[kind] = (receivedKinds[kind] ?? 0) + 1;
      if (frame.type === "error" && typeof frame.code === "string" && /^[a-z_]{1,40}$/.test(frame.code))
        relayErrors.push(frame.code);
      if (frame.type === "notify" && frame.kind === "status" && frame.data[1] === 1 && frame.data[12] === 2) {
        const sequence = frame.data[2] | frame.data[3] << 8;
        const sent = syncSent.get(sequence);
        if (sent !== undefined) {
          syncRtts.push(performance.now() - sent);
          syncSent.delete(sequence);
        }
      }
      if (frame.type !== "notify" || frame.kind !== "motion") return;
      const arrival = performance.now();
      if (lastArrival !== undefined) maxArrivalGapMs = Math.max(maxArrivalGapMs, arrival - lastArrival);
      lastArrival = arrival;
      const sequence = frame.data[2] | frame.data[3] << 8;
      if (lastSequence !== undefined) sequenceGaps += Math.max(0, ((sequence - lastSequence) & 65535) - 1);
      lastSequence = sequence;
      motionFrames++;
    });
  });
  await desktop.goto("http://127.0.0.1:5173/");
  const pairResponse = desktop.waitForResponse((response) => response.url().endsWith("/api/phone/pair") && response.request().method() === "POST");
  await desktop.getByRole("button", { name: "Connect iPhone" }).click();
  const response = await pairResponse;
  if (!response.ok()) throw new Error("Local phone broker unavailable");
  const { phoneUrl } = await response.json();
  if (new URL(phoneUrl).origin !== service.origin) throw new Error("Unexpected phone destination");
  await desktop.getByRole("img", { name: "Scan this code with your iPhone" }).waitFor();
  if (await desktop.getByRole("img", { name: "Scan this code with your iPhone" }).evaluate(element => getComputedStyle(element).stroke) !== "none")
    throw new Error("QR modules have a destructive inherited stroke");
  await phone.addInitScript(() => {
    class Motion extends Event {
      static requestPermission = async () => "granted";
      accelerationIncludingGravity = { x: 0, y: 0, z: 9.80665 };
    }
    Object.defineProperty(window, "DeviceMotionEvent", { value: Motion, configurable: true });
    setInterval(() => window.dispatchEvent(new Motion("devicemotion")), 16);
  });
  await phone.goto(phoneUrl);
  await phone.getByRole("button", { name: "Connect wand" }).click();
  const confirmation = phone.getByLabel("Confirmation code");
  await confirmation.waitFor();
  const challenge = await confirmation.textContent();
  await desktop.getByRole("heading", { name: `Does ${challenge} match your iPhone?` }).waitFor();
  await desktop.getByRole("button", { name: "Yes, connect" }).click();
  await phone.getByRole("heading", { name: "Your wand is ready" }).waitFor();
  await desktop.getByRole("button", { name: "Enable microphone" }).waitFor({ timeout: 15_000 });
  const started = performance.now();
  motionFrames = sequenceGaps = 0;
  lastSequence = lastArrival = undefined;
  maxArrivalGapMs = 0;
  let nextProgress = 30_000;
  while (performance.now() - started < durationSeconds * 1000) {
    await desktop.waitForTimeout(1000);
    if (!await desktop.getByRole("button", { name: "Enable microphone" }).isVisible())
      throw new Error(`Phone input failed after ${Math.round((performance.now() - started) / 1000)} seconds`);
    if (performance.now() - started >= nextProgress) {
      console.log(`Streaming ${Math.round(nextProgress / 1000)}/${durationSeconds}s; ${motionFrames} samples; ${sequenceGaps} missing; ${syncRtts.length} SYNC replies.`);
      nextProgress += 30_000;
    }
  }
  const hz = motionFrames * 1000 / (performance.now() - started);
  const delivery = motionFrames / Math.max(1, motionFrames + sequenceGaps);
  if (hz < 45 || delivery < 0.95) throw new Error(`Injected stream delivery failed: ${hz.toFixed(1)} Hz, ${(delivery * 100).toFixed(2)}%`);
  await desktop.getByRole("button", { name: "Leave", exact: true }).click();
  await phone.getByRole("heading", { name: /Connection (closed|interrupted)/ }).waitFor();
  syncRtts.sort((a, b) => a - b);
  console.log(`PASS: public route isolation, QR, explicit approval, protocol handshake, ${hz.toFixed(1)} Hz / ${(delivery * 100).toFixed(2)}% delivery for ${durationSeconds}s, leave disconnect.`);
  console.log(`Observed motion arrival gap max ${maxArrivalGapMs.toFixed(0)}ms; SYNC RTT p95 ${syncRtts[Math.max(0, Math.ceil(syncRtts.length * .95) - 1)]?.toFixed(0)}ms (${syncRtts.length} replies).`);
  console.log("Evidence: injected browser motion over real public HTTPS/WSS; no microphone, physical iPhone, or badge qualification.");
  passed = true;
} catch (error) {
  // Only player-facing errors and aggregate envelope counts, never socket payloads/tokens.
  console.error("Desktop alerts:", await desktop?.getByRole("alert").allTextContents());
  console.error("Phone alerts:", await phone?.getByRole("alert").allTextContents());
  console.error("Received envelope counts:", receivedKinds);
  console.error("Relay failure codes:", relayErrors.slice(-8));
  throw error;
} finally {
  await browser.close();
  if (!passed) process.exitCode = 1;
}
