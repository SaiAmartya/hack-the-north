/** Real hosted transport + generated acceleration/audio fixtures, NOT physical qualification. */
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const service = new URL(process.argv[2] ?? "");
const seconds = Number(process.argv[3] ?? 60), route = process.argv[4] ?? "direct";
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600 || !["direct", "relay"].includes(route)) throw new Error("Supply duration10..600 and direct|relay");
if (service.protocol !== "https:" || service.username || service.password || service.search || service.hash || service.pathname !== "/") throw new Error("Supply the approved phone-service origin");
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
let desktop, phone;
// Failure-only diagnostics: scalar counters, relative clocks and reason codes.
// Never retain envelopes, URLs, credentials, identities, SDP or speech content.
function traceRelay() {
  const trace = window.__qaRelayTrace = { buckets: [], events: [], syncs: [], totals: { motionFrames: 0, motionGaps: 0, discontinuities: 0, maxArrivalGapMs: 0, maxAcceptedAgeMs: 0, maxDeviceDropped: 0, syncRttMinMs: null, syncRttMaxMs: 0 } };
  const controls = new Map();
  let previousMotion;
  const uint = (bytes, offset) => new DataView(Uint8Array.from(bytes).buffer).getUint32(offset, true);
  const inspect = (direction, raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.v !== 2) return;
    const at = performance.now(), second = Math.floor(at / 1000);
    let bucket = trace.buckets.at(-1);
    if (!bucket || bucket.second !== second) { bucket = { second, tx: 0, rx: 0, frames: 0, discontinuities: 0 }; trace.buckets.push(bucket); if (trace.buckets.length > 30) trace.buckets.shift(); }
    bucket[direction]++; bucket.generation = m.generation;
    if (m.kind === "motion") for (const bytes of m.records) {
      if (direction === "rx") bucket.frames++;
      bucket.motionAt = Math.round(at); bucket.captureMs = uint(bytes, 4); bucket.sequence = bytes[2] | bytes[3] << 8;
      trace.totals.motionFrames++;
      if (previousMotion?.generation === m.generation) {
        const delta = (bucket.sequence - previousMotion.sequence) & 65535;
        if (delta > 0 && delta < 32768) trace.totals.motionGaps += delta - 1;
        trace.totals.maxArrivalGapMs = Math.max(trace.totals.maxArrivalGapMs, Math.round(at - previousMotion.at));
      }
      previousMotion = { generation: m.generation, sequence: bucket.sequence, at };
      if (bytes[1] & 4) { bucket.discontinuities++; trace.totals.discontinuities++; }
    }
    if (m.kind === "receipt" && m.accepted) { bucket.accepted = m.accepted.accepted; bucket.ageMs = Math.round(m.accepted.ageMs); trace.totals.maxAcceptedAgeMs = Math.max(trace.totals.maxAcceptedAgeMs, bucket.ageMs); trace.totals.accepted = m.accepted.accepted; }
    if (direction === "tx" && m.kind === "op" && m.operation === "control") { controls.set(m.data[2] | m.data[3] << 8, at); if (controls.size > 16) controls.delete(controls.keys().next().value); }
    if (m.kind === "status") {
      if (m.data[1] === 0) { bucket.dropped = uint(m.data, 12); bucket.health = uint(m.data, 16); trace.totals.maxDeviceDropped = Math.max(trace.totals.maxDeviceDropped, bucket.dropped); }
      else if (direction === "rx") {
        const seq = m.data[2] | m.data[3] << 8, sent = controls.get(seq);
        if (sent !== undefined) {
          const opcode = uint(m.data, 12), rtt = Math.round(at - sent);
          trace.syncs.push({ at: Math.round(at), opcode, rtt, deviceMs: uint(m.data, 8), offset: Math.round((sent + at) / 2 - uint(m.data, 8)) }); if (trace.syncs.length > 20) trace.syncs.shift(); controls.delete(seq);
          if (opcode === 2) { trace.totals.syncRttMinMs = Math.min(trace.totals.syncRttMinMs ?? Infinity, rtt); trace.totals.syncRttMaxMs = Math.max(trace.totals.syncRttMaxMs, rtt); }
        }
      }
    }
    if (m.type !== "data" && m.type !== "signal" || m.kind === "issue") {
      trace.events.push({ at: Math.round(at), direction, type: m.type, kind: m.kind, code: m.code, generation: m.generation, route: m.route }); if (trace.events.length > 40) trace.events.shift();
    }
  };
  const Socket = window.WebSocket;
  window.WebSocket = new Proxy(Socket, { construct(Target, args) {
    const socket = new Target(...args), send = socket.send.bind(socket);
    socket.send = raw => { inspect("tx", raw); return send(raw); };
    socket.addEventListener("message", event => inspect("rx", event.data));
    socket.addEventListener("close", event => { trace.events.push({ at: Math.round(performance.now()), type: "close", code: event.code }); if (trace.events.length > 40) trace.events.shift(); });
    return socket;
  } });
}
try {
  for (const path of ["/api/speech/health", "/api/game/health", "/src/main.tsx", "/__qa/game", "/@vite/client"]) {
    if ((await fetch(new URL(path, service), { redirect: "error" })).status !== 404) throw new Error(`Public isolation failed: ${path}`);
  }
  desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await Promise.all([desktop.addInitScript(traceRelay), phone.addInitScript(traceRelay)]);
  await desktop.addInitScript(({ route }) => {
    const counts = window.__qaCounts = { frames: 0, gaps: 0, previous: undefined, last: undefined, maxGap: 0 };
    const receive = raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type !== "data" || m.kind !== "motion") return;
      const now = performance.now(); if (counts.last !== undefined) counts.maxGap = Math.max(counts.maxGap, now - counts.last); counts.last = now;
      for (const data of m.records) {
        const seq = data[2] | data[3] << 8;
        if (counts.previous !== undefined) { const delta = (seq - counts.previous) & 65535; if (!delta || delta >= 32768) continue; counts.gaps += delta - 1; }
        counts.previous = seq; counts.frames++;
      }
    };
    const Socket = window.WebSocket;
    window.WebSocket = new Proxy(Socket, { construct(Target, args) { const s = new Target(...args); s.addEventListener("message", e => receive(e.data)); return s; } });
    const Peer = window.RTCPeerConnection;
    // For relay QA, withhold host candidates while retaining the phone RTC API.
    window.RTCPeerConnection = new Proxy(Peer, { construct(Target, args) {
      if (route === "relay") args[0] = { ...args[0], iceTransportPolicy: "relay" };
      const peer = new Target(...args), create = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (...options) => { const c = create(...options); c.addEventListener("message", e => receive(e.data)); return c; }; return peer;
    } });
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.audio) return native(constraints);
      const context = new AudioContext({ sampleRate: 16000 }), out = context.createMediaStreamDestination(), tone = context.createOscillator(), gain = context.createGain();
      gain.gain.value = 0; tone.frequency.value = 240; tone.connect(gain).connect(out); tone.start(); await context.resume();
      window.__qaSpeak = () => { const t = context.currentTime; gain.gain.setValueAtTime(.16, t); gain.gain.setValueAtTime(0, t + .6); }; return out.stream;
    };
  }, { route });
  let spell = "stupefy";
  await desktop.route("**/api/speech/health", r => r.fulfill({ json: { status: "ok", ready: true, warm: true, busy: false, workerAvailable: true } }));
  await desktop.route("**/api/speech/transcribe", r => {
    const h = r.request().headers(); return r.fulfill({ json: { utteranceId: h["x-wand-utterance-id"], generation: Number(h["x-wand-generation"]), text: spell, spell } });
  });
  await phone.addInitScript(() => {
    let gesture = "rest", start = 0;
    window.__qaGesture = name => { gesture = name; start = performance.now(); };
    class Motion extends Event {
      static requestPermission = async () => "granted";
      constructor() {
        super("devicemotion"); const t = performance.now() - start - 260; let y = 1, z = 0;
        if (gesture === "stupefy" && t >= 0 && t < 320) z = -.9 * [.05,.15,.3,.55,.8,1,.8,.5,.15,-.2,-.45,-.3,-.12,0,0,0][Math.min(15, Math.floor(t / 20))];
        if (gesture === "protego" && t >= 0) {
          const fraction = t < 320 ? t / 320 : t < 580 ? 1 : Math.max(0, 1 - (t - 580) / 320);
          const angle = fraction * 35 * Math.PI / 180; y = Math.cos(angle); z = Math.sin(angle);
        }
        this.accelerationIncludingGravity = { x: 0, y: y * 9.80665, z: z * 9.80665 };
      }
    }
    Object.defineProperty(window, "DeviceMotionEvent", { value: Motion, configurable: true });
    setInterval(() => window.dispatchEvent(new Motion()), 16);
  });
  await desktop.goto("http://127.0.0.1:5173/");
  const pairing = desktop.waitForResponse(r => r.url().endsWith("/api/phone/pair") && r.request().method() === "POST");
  await desktop.getByRole("button", { name: "Connect iPhone" }).click();
  const response = await pairing; if (!response.ok()) throw new Error("Local broker unavailable");
  const { phoneUrl } = await response.json(); if (new URL(phoneUrl).origin !== service.origin) throw new Error("Wrong destination");
  const qr = desktop.getByRole("img", { name: "Scan this code with your iPhone" }); await qr.waitFor();
  if (await qr.evaluate(el => getComputedStyle(el).stroke) !== "none") throw new Error("QR destructive stroke");
  await phone.goto(phoneUrl); await phone.getByRole("button", { name: "Connect wand" }).click();
  const code = phone.getByLabel("Confirmation code"); await code.waitFor(); const challenge = await code.textContent();
  await desktop.getByRole("heading", { name: `Does ${challenge} match your iPhone?` }).waitFor();
  await desktop.getByRole("button", { name: "Yes, connect" }).click();
  if (route === "relay") await desktop.getByRole("button", { name: "Use internet connection" }).click();
  await desktop.getByRole("button", { name: "Enable microphone" }).waitFor({ timeout: 20_000 });
  await phone.getByText("Sensor active", { exact: true }).waitFor(); await phone.getByText("Reaching laptop", { exact: true }).waitFor();
  await desktop.getByRole("button", { name: "Enable microphone" }).click();
  await desktop.getByRole("button", { name: "Start calibration" }).waitFor({ timeout: 10_000 });
  await desktop.screenshot({ path: `/tmp/wandduel-${route}-grip.png` });
  await desktop.getByRole("button", { name: "Start calibration" }).click();
  await desktop.getByRole("progressbar", { name: "Stillness calibration" }).waitFor();
  await desktop.getByRole("button", { name: "Practice Stupefy", exact: true }).waitFor({ timeout: 8_000 });
  for (const name of ["stupefy", "protego"]) {
    await desktop.getByRole("button", { name: `Practice ${name[0].toUpperCase() + name.slice(1)}`, exact: true }).click();
    for (let i = 0; i < 3; i++) { await phone.evaluate(n => window.__qaGesture(n), name); await desktop.waitForTimeout(name === "protego" ? 1600 : 1100); }
  }
  await desktop.getByRole("heading", { name: "Cast each spell once." }).waitFor({ timeout: 5000 });
  for (const name of ["stupefy", "protego"]) {
    spell = name;
    await Promise.all([phone.evaluate(n => window.__qaGesture(n), name), desktop.evaluate(() => window.__qaSpeak())]); await desktop.waitForTimeout(1800);
  }
  await desktop.getByRole("heading", { name: "Ready to duel?" }).waitFor({ timeout: 5000 });
  await desktop.screenshot({ path: `/tmp/wandduel-${route}-practice.png` }); await phone.screenshot({ path: `/tmp/wandduel-${route}-sensing.png` });
  const before = await desktop.evaluate(() => ({ ...window.__qaCounts })), started = performance.now();
  while (performance.now() - started < seconds * 1000) {
    await desktop.waitForTimeout(1000);
    if (!await desktop.getByRole("heading", { name: "Ready to duel?" }).isVisible()) throw new Error("Input failed during rehearsal");
    if (!await phone.getByText("Reaching laptop", { exact: true }).isVisible()) throw new Error("Receipt indicator expired");
  }
  const after = await desktop.evaluate(() => ({ ...window.__qaCounts }));
  const frames = after.frames - before.frames, gaps = after.gaps - before.gaps, hz = frames * 1000 / (performance.now() - started), delivery = frames / Math.max(1, frames + gaps);
  if (hz < 45 || delivery < .95) throw new Error(`Delivery ${hz.toFixed(1)}Hz ${(100 * delivery).toFixed(2)}%`);
  await desktop.getByRole("button", { name: "Leave", exact: true }).click();
  console.log(`PASS ${route}: isolation, QR approval, sensing, explicit calibration, six examples, two fused practice spells, ${seconds}s rehearsal ${hz.toFixed(1)}Hz ${(100 * delivery).toFixed(2)}%; max arrival gap ${after.maxGap.toFixed(0)}ms.`);
  if (route === "relay") console.log("Bounded relay totals (setup + rehearsal):", JSON.stringify({ desktop: await desktop.evaluate(() => window.__qaRelayTrace.totals), phone: await phone.evaluate(() => window.__qaRelayTrace.totals) }));
  console.log("Injected Chromium movement and tone/ASR fixtures. NOT physical Safari, human speech, badge or venue-peer qualification.");
} catch (error) {
  console.error("Desktop alerts:", await desktop?.getByRole("alert").allTextContents());
  console.error("Desktop headings:", await desktop?.getByRole("heading").allTextContents());
  console.error("Phone headings:", await phone?.getByRole("heading").allTextContents());
  console.error("Desktop relay counters:", JSON.stringify(await desktop?.evaluate(() => window.__qaRelayTrace)));
  console.error("Phone relay counters:", JSON.stringify(await phone?.evaluate(() => window.__qaRelayTrace)));
  throw error;
} finally { await browser.close(); }
