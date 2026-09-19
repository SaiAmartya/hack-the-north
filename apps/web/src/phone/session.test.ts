import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneSession } from "./session";
import { PhoneAccessory } from "./accessory";
import { PhoneTrace } from "./trace";
import { isPhoneMessage, type PhoneMessage } from "../../../../shared/phone-v2";
import { ControlOpcode, MotionFlag, StatusKind, decodeMotion, decodeStatus, encodeControl, type InfoRecord } from "../wand/protocol";

class Socket {
  static OPEN = 1; static CLOSING = 2; static all: Socket[] = [];
  readyState = 0; bufferedAmount = 0; sent: PhoneMessage[] = [];
  onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { Socket.all.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: PhoneMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
class Channel {
  readyState = "connecting"; bufferedAmount = 0; sent: string[] = [];
  onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: string }) => void;
  constructor(readonly label: string, readonly options: RTCDataChannelInit) {}
  get ordered() { return this.options.ordered ?? true; }
  get maxRetransmits() { return this.options.maxRetransmits ?? null; }
  get maxPacketLifeTime() { return this.options.maxPacketLifeTime ?? null; }
  send(text: string) { this.sent.push(text); }
  open() { this.readyState = "open"; this.onopen?.(); }
  receive(message: PhoneMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = "closed"; this.onclose?.(); }
}
class Peer {
  static all: Peer[] = []; channels: Channel[] = [];
  localDescription?: RTCSessionDescriptionInit; remoteDescription?: RTCSessionDescriptionInit;
  onicecandidate?: (event: RTCPeerConnectionIceEvent) => void; onconnectionstatechange?: () => void; ondatachannel?: (event: RTCDataChannelEvent) => void;
  connectionState = "connecting";
  constructor(readonly config: RTCConfiguration) { Peer.all.push(this); }
  createDataChannel(label: string, options: RTCDataChannelInit) { const channel = new Channel(label, options); this.channels.push(channel); return channel; }
  async createOffer() { return { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" }; }
  async createAnswer() { return { type: "answer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
  async addIceCandidate() {}
  close() { this.connectionState = "closed"; }
}
const info: InfoRecord = { version: 1, capabilities: 15, sampleHz: 50, rangeG: 8, axisConvention: 1, bootId: 10, deviceId: [1,2,3,4,5,6], firmware: { major: 0, minor: 2, patch: 0 } };
const pair = () => ({ roomId: "a".repeat(32), ownerToken: "b".repeat(64), expiresAtMs: Date.now() + 120000, socketUrl: "wss://wand.test/ws/" + "a".repeat(32), phoneUrl: "https://wand.test/phone?room=" + "a".repeat(32) });
const paired = (generation = 1, route: "direct" | "relay" = "relay"): Extract<PhoneMessage, { type: "paired" }> => ({ v: 2, type: "paired", generation, route, resumed: generation > 1, resumeToken: "c".repeat(64), expiresAtMs: Date.now() + 120000 });
const data = <T extends object>(extra: T, generation = 1) => ({ v: 2 as const, type: "data" as const, generation, ...extra });
function setup() { vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("RTCPeerConnection", Peer); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Socket.all = []; Peer.all = []; });

describe("phone v2 session", () => {
  it("does not resolve pairing before idempotent device reset, and fences old generations on recovery", async () => {
    setup(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} });
    const ready = session.connect(() => {}); const socket = Socket.all[0]; socket.open(); socket.receive(paired());
    expect(socket.sent.at(-1)).toEqual(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "begun", id: "begin-1" })); await ready;
    const seen = vi.fn(); const subscribe = session.subscribe("motion", seen);
    const op = socket.sent.at(-1); expect(op?.type).toBe("data");
    socket.receive(data({ kind: "reply", id: String(1) })); await subscribe;
    socket.receive(data({ kind: "motion", sequence: 1, records: [Array(20).fill(0)] })); expect(seen).toHaveBeenCalledTimes(1);
    const recovery = session.recover(() => {}); expect(socket.sent.at(-1)?.type).toBe("reset-link");
    socket.receive(paired(2)); socket.receive(data({ kind: "begun", id: "begin-1" }));
    socket.receive(data({ kind: "motion", sequence: 2, records: [Array(20).fill(0)] })); expect(seen).toHaveBeenCalledTimes(1);
    socket.receive(data({ kind: "begun", id: "begin-2" }, 2)); await recovery;
    session.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });
  it("uses two data-only channels and keeps direct input alive when signalling is lost", async () => {
    setup(); const failed = vi.fn(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} });
    const ready = session.connect(failed); const socket = Socket.all[0]; socket.open(); socket.receive(paired(1, "direct"));
    const peer = Peer.all[0]; expect(peer.config).toEqual({ iceServers: [] });
    expect(peer.channels.map(c => c.options)).toEqual([{ ordered: true }, { ordered: false, maxRetransmits: 0 }]);
    peer.channels.forEach(c => c.open()); peer.channels[0].receive(data({ kind: "begun", id: "begin-1" })); await ready;
    socket.close(); expect(failed).not.toHaveBeenCalled(); expect(session.getState().phase).toBe("direct");
    await vi.advanceTimersByTimeAsync(500); const resumed = Socket.all[1]; resumed.open();
    expect(resumed.sent[0]).toEqual({ v: 2, type: "resume", role: "owner", token: "c".repeat(64) });
    resumed.receive({ ...paired(1, "direct"), resumed: true }); expect(Peer.all).toHaveLength(1);
    session.disconnect();
  });
  it("offers relay after ten seconds without silently sending motion through it", async () => {
    setup(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} });
    const ready = session.connect(() => {}); const socket = Socket.all[0]; socket.open(); socket.receive(paired(1, "direct"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.getState().relayAvailable).toBe(true); expect(socket.sent.filter(x => x.type === "route")).toHaveLength(0);
    session.chooseRelay(); expect(socket.sent.at(-1)).toEqual({ v: 2, type: "route", generation: 1, route: "relay" });
    socket.receive({ v: 2, type: "route", generation: 2, route: "relay" }); socket.receive(data({ kind: "begun", id: "begin-2" }, 2)); await ready; session.disconnect();
  });
  it("does not repeatedly re-assert an old accepted-sample count", async () => {
    setup(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} }); const ready = session.connect(() => {});
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begun", id: "begin-1" })); await ready;
    session.reportAccepted({ sequence: 3, accepted: 4, receivedHz: 50, ageMs: 40 }); await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.at(-1)).toMatchObject({ kind: "receipt", accepted: { accepted: 4 } });
    await vi.advanceTimersByTimeAsync(600); expect(socket.sent.at(-1)).not.toHaveProperty("accepted"); session.disconnect();
  });
  it("keeps healthy direct motion after signalling grace expires, then requires fresh pairing on carrier failure", async () => {
    setup(); const failed = vi.fn(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} });
    const ready = session.connect(failed); const socket = Socket.all[0]; socket.open(); socket.receive(paired(1, "direct"));
    const peer = Peer.all[0]; peer.channels.forEach(c => c.open()); peer.channels[0].receive(data({ kind: "begun", id: "begin-1" })); await ready;
    socket.receive({ v: 2, type: "error", code: "signalling-expired" });
    expect(failed).not.toHaveBeenCalled(); expect(session.getState().phase).toBe("direct");
    await vi.advanceTimersByTimeAsync(5000); expect(Socket.all).toHaveLength(1);
    peer.channels[0].close(); expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: "expired", recoverable: false }));
    const retry = session.recover(failed); await expect(retry).rejects.toThrow("Scan a new code");
    expect(Socket.all).toHaveLength(1); session.disconnect();
  });
  it("does not confuse signalling grace with absolute pair expiry or an unready direct connection", async () => {
    setup(); const failed = vi.fn(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} });
    const ready = session.connect(failed); const socket = Socket.all[0]; socket.open(); socket.receive(paired(1, "direct"));
    socket.receive({ v: 2, type: "error", code: "signalling-expired" }); await expect(ready).rejects.toThrow("Scan a new code");
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: "expired", recoverable: false })); session.disconnect();
    const expired = new PhoneSession({ pair: pair(), onClaim: () => {} }); const connected = expired.connect(failed);
    const second = Socket.all[1]; second.open(); second.receive(paired(1, "direct"));
    const peer = Peer.all[1]; peer.channels.forEach(c => c.open()); peer.channels[0].receive(data({ kind: "begun", id: "begin-1" })); await connected;
    second.receive({ v: 2, type: "error", code: "expired" }); expect(peer.connectionState).toBe("closed"); expired.disconnect();
  });
  it("announces an active carrier generation change and re-handshakes that link without another reset", async () => {
    setup(); const session = new PhoneSession({ pair: pair(), onClaim: () => {} });
    let recovery: Promise<void> | undefined;
    const failed = vi.fn(() => { recovery = session.recover(failed); });
    const ready = session.connect(failed); const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begun", id: "begin-1" })); await ready;
    const oldMotion = vi.fn(); const subscription = session.subscribe("motion", oldMotion); socket.receive(data({ kind: "reply", id: "1" })); await subscription;
    socket.receive({ v: 2, type: "route", generation: 2, route: "relay" });
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: "link_changed", recoverable: true }));
    expect(socket.sent.at(-1)).toEqual(data({ kind: "begin-link", id: "begin-2" }, 2));
    expect(socket.sent.some(x => x.type === "reset-link")).toBe(false);
    socket.receive(data({ kind: "motion", sequence: 1, records: [Array(20).fill(0)] }, 2)); expect(oldMotion).not.toHaveBeenCalled();
    socket.receive(data({ kind: "begun", id: "begin-2" }, 2)); await recovery;
    const freshMotion = vi.fn(); const freshSubscription = session.subscribe("motion", freshMotion); socket.receive(data({ kind: "reply", id: "2" }, 2)); await freshSubscription;
    socket.receive(data({ kind: "motion", sequence: 2, records: [Array(20).fill(0)] }, 2)); expect(freshMotion).toHaveBeenCalledTimes(1); session.disconnect();
  });
});

describe("phone sensing endpoint", () => {
  it("requires real observations, clears endpoint on a new link, and expires laptop receipt independently", async () => {
    setup(); const phone = new PhoneAccessory(info, "wss://wand.test/ws/test"); phone.start();
    await vi.advanceTimersByTimeAsync(200); expect(Socket.all).toHaveLength(0);
    phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "op", id: "1", operation: "subscribe-status" }));
    const open = encodeControl({ version: 1, opcode: ControlOpcode.Open, commandSeq: 0, linkNonce: 44 });
    socket.receive(data({ kind: "op", id: "2", operation: "control", data: [...open] }));
    const result = socket.sent.find(x => x.type === "data" && x.kind === "status");
    expect(result?.type === "data" && result.kind === "status" && decodeStatus(new Uint8Array(result.data)).linkNonce).toBe(44);
    socket.receive(data({ kind: "receipt", through: 0, statusIds: [], accepted: { sequence: 1, accepted: 1, receivedHz: 50, ageMs: 20 } }));
    expect(phone.getState()).toMatchObject({ sensorActive: true, reachingLaptop: true });
    await vi.advanceTimersByTimeAsync(600); expect(phone.getState()).toMatchObject({ sensorActive: false, reachingLaptop: false });
    socket.receive(paired(2)); socket.receive(data({ kind: "begin-link", id: "begin-2" }, 2));
    socket.receive(data({ kind: "op", id: "3", operation: "status" }, 2));
    const reply = socket.sent.at(-1); expect(reply?.type === "data" && reply.kind === "reply" && decodeStatus(new Uint8Array(reply.data ?? [])).linkNonce).toBe(0);
    phone.close();
  });
  it("preserves observation timestamps and caps relay batches at two samples", async () => {
    setup(); const phone = new PhoneAccessory(info, "wss://wand.test/ws/test"); phone.start(); phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "op", id: "1", operation: "subscribe-motion" }));
    socket.receive(data({ kind: "op", id: "2", operation: "subscribe-status" }));
    socket.receive(data({ kind: "op", id: "3", operation: "control", data: [...encodeControl({ version: 1, opcode: ControlOpcode.Open, commandSeq: 0, linkNonce: 44 })] }));
    const at = performance.now(); phone.observe(1, 9.80665, 0, at); await vi.advanceTimersByTimeAsync(40);
    const batch = socket.sent.find(x => x.type === "data" && x.kind === "motion");
    expect(batch?.type === "data" && batch.kind === "motion" && decodeMotion(new Uint8Array(batch.records[0])).captureMs).toBe(Math.floor(at));
    await vi.advanceTimersByTimeAsync(100); expect(socket.sent.filter(x => x.type === "data" && x.kind === "motion")).toHaveLength(1); phone.close();
  });
  it("bounds diagnostics to one minute and rejects media or malformed wire messages", () => {
    let time = 0; const trace = new PhoneTrace(() => time); trace.add({ event: "observation", generation: 1, x: 1 }); time = 61000; trace.add({ event: "accepted", generation: 1, count: 1 });
    expect(JSON.parse(trace.export()).entries).toHaveLength(1);
    expect(isPhoneMessage({ v: 2, type: "signal", generation: 1, signal: { type: "offer", sdp: "m=audio 9" } })).toBe(false);
    expect(isPhoneMessage(data({ kind: "motion", sequence: 1, records: [Array(19).fill(0)] }))).toBe(false);
    expect(isPhoneMessage(data({ kind: "motion", sequence: 1, records: Array(3).fill(Array(20).fill(0)) }))).toBe(false);
  });
  it("keeps a minute at normal sensing rates and preserves allowlisted calibration context", () => {
    let time = 0; const trace = new PhoneTrace(() => time);
    trace.add({ event: "coaching", generation: 3, calibration: { version: 2, neutralMg: [0, -1000, 0], noiseMg: 9 } });
    for (let i = 0; i < 5000; i++) { time = i * 12; trace.add({ event: "observation", generation: 3, x: .1 }); }
    expect(JSON.parse(trace.export()).entries).toHaveLength(5001);
    time = 61_000;
    const exported = JSON.parse(trace.export());
    expect(exported.calibration).toMatchObject({ generation: 3, value: { neutralMg: [0, -1000, 0] } });
    expect(exported.entries[0].at).toBeGreaterThanOrEqual(1000);
    // Invalid extra diagnostic keys are discarded, not copied into support files.
    trace.add({ event: "coaching", generation: 3, calibration: { version: 2, noiseMg: 2, token: "not-allowed" } as never });
    expect(trace.export()).not.toContain("not-allowed");
    for (let i = 0; i < 11000; i++) trace.add({ event: "accepted", generation: 3, count: i });
    expect(JSON.parse(trace.export()).entries).toHaveLength(10000);
  });
  it("does not reset an already-open endpoint for a duplicate begin, or resume while paused", async () => {
    setup(); const phone = new PhoneAccessory(info, "wss://wand.test/ws/test"); phone.start(); phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "op", id: "1", operation: "control", data: [...encodeControl({ version: 1, opcode: ControlOpcode.Open, commandSeq: 0, linkNonce: 44 })] }));
    socket.receive(data({ kind: "begin-link", id: "begin-1" })); socket.receive(data({ kind: "op", id: "2", operation: "status" }));
    let reply = socket.sent.at(-1); expect(reply?.type === "data" && reply.kind === "reply" && decodeStatus(new Uint8Array(reply.data ?? [])).linkNonce).toBe(44);
    phone.pause(); socket.receive(paired(2)); socket.receive(data({ kind: "begin-link", id: "begin-2" }, 2));
    expect(socket.sent.filter(x => x.type === "data" && x.kind === "begun" && x.generation === 2)).toHaveLength(0);
    phone.resume(); expect(socket.sent.at(-1)).toEqual(data({ kind: "begun", id: "begin-2" }, 2));
    socket.receive(data({ kind: "op", id: "3", operation: "status" }, 2));
    reply = socket.sent.at(-1); expect(reply?.type === "data" && reply.kind === "reply" && decodeStatus(new Uint8Array(reply.data ?? [])).linkNonce).toBe(0); phone.close();
  });
  it("bounds unsatisfied motion receipts and reports congestion rather than sending catch-up", async () => {
    setup(); const phone = new PhoneAccessory(info, "wss://wand.test/ws/test"); phone.start(); phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "op", id: "1", operation: "subscribe-motion" }));
    socket.receive(data({ kind: "op", id: "2", operation: "control", data: [...encodeControl({ version: 1, opcode: ControlOpcode.Open, commandSeq: 0, linkNonce: 44 })] }));
    for (let i = 0; i < 60; i++) { phone.observe(i / 100, 9.80665, 0); await vi.advanceTimersByTimeAsync(20); }
    expect(socket.sent.filter(x => x.type === "data" && x.kind === "motion")).toHaveLength(8);
    expect(socket.sent.some(x => x.type === "data" && x.kind === "issue" && x.code === "congestion")).toBe(true);
    expect(phone.getState().lastIssue).toContain("too slow"); phone.close();
  });
  it("marks and counts selected samples discarded by queue capacity or residence, without leaking loss across generations", async () => {
    setup(); const phone = new PhoneAccessory(info, "wss://wand.test/ws/test"); phone.start(); phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "op", id: "1", operation: "subscribe-motion" }));
    socket.receive(data({ kind: "op", id: "2", operation: "control", data: [...encodeControl({ version: 1, opcode: ControlOpcode.Open, commandSeq: 0, linkNonce: 44 })] }));
    phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(40);
    socket.receive(data({ kind: "receipt", through: 1, statusIds: [] }));
    socket.bufferedAmount = 20000;
    for (let i = 0; i < 5; i++) { phone.observe(i, 9.80665, 0); await vi.advanceTimersByTimeAsync(20); }
    await vi.advanceTimersByTimeAsync(140);
    socket.bufferedAmount = 0; phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(40);
    const motions = socket.sent.filter((x): x is Extract<PhoneMessage, { kind: "motion" }> => x.type === "data" && x.kind === "motion");
    expect(motions).toHaveLength(2); expect(motions[1].records[0][1] & MotionFlag.Discontinuity).toBe(MotionFlag.Discontinuity);
    socket.receive(data({ kind: "op", id: "3", operation: "status" }));
    let reply = socket.sent.at(-1); let status = reply?.type === "data" && reply.kind === "reply" ? decodeStatus(new Uint8Array(reply.data ?? [])) : undefined;
    expect(status?.kind === StatusKind.Health && status.droppedCount).toBe(5);
    socket.receive(paired(2)); socket.receive(data({ kind: "begin-link", id: "begin-2" }, 2)); socket.receive(data({ kind: "op", id: "4", operation: "status" }, 2));
    reply = socket.sent.at(-1); status = reply?.type === "data" && reply.kind === "reply" ? decodeStatus(new Uint8Array(reply.data ?? [])) : undefined;
    expect(status?.kind === StatusKind.Health && status.droppedCount).toBe(0); phone.close();
  });
  it("batches every two selected samples without dropping at ordinary sub-millisecond timer jitter", async () => {
    setup(); const origin = Date.now(); let jitter = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin + jitter);
    const phone = new PhoneAccessory(info, "wss://wand.test/ws/test"); phone.start(); phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
    const socket = Socket.all[0]; socket.open(); socket.receive(paired()); socket.receive(data({ kind: "begin-link", id: "begin-1" }));
    socket.receive(data({ kind: "op", id: "1", operation: "subscribe-motion" }));
    socket.receive(data({ kind: "op", id: "2", operation: "control", data: [...encodeControl({ version: 1, opcode: ControlOpcode.Open, commandSeq: 0, linkNonce: 44 })] }));
    for (let i = 0; i < 100; i++) {
      jitter = i % 2 ? -.2 : .2; phone.observe(0, 9.80665, 0); await vi.advanceTimersByTimeAsync(20);
      const batches = socket.sent.filter((x): x is Extract<PhoneMessage, { kind: "motion" }> => x.type === "data" && x.kind === "motion");
      if (batches.length) socket.receive(data({ kind: "receipt", through: batches.at(-1)!.sequence, statusIds: [] }));
    }
    const batches = socket.sent.filter((x): x is Extract<PhoneMessage, { kind: "motion" }> => x.type === "data" && x.kind === "motion");
    expect(batches).toHaveLength(50); expect(batches.flatMap(x => x.records)).toHaveLength(100);
    socket.receive(data({ kind: "op", id: "3", operation: "status" }));
    const reply = socket.sent.at(-1); const status = reply?.type === "data" && reply.kind === "reply" ? decodeStatus(new Uint8Array(reply.data ?? [])) : undefined;
    expect(status?.kind === StatusKind.Health && status.droppedCount).toBe(0); phone.close(); clock.mockRestore();
  });
});
