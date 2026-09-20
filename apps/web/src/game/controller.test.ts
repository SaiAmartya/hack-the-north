import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DuelController } from "./controller";
import { SpeechClient, type SpeechOnset } from "../speech/client";
import { WandClient, type CapturedMotion } from "../wand/client";
import { GameClient } from "./client";
import { createCoreMotionFixtures } from "../input/traceFixtures";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

async function flushPromises() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.instances = [];
});

it("stops renewing badge feedback and clears evidence when the referee is lost", () => {
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  const stopFeedback = vi.fn();
  controller.wand = {
    stopFeedback,
    disconnect: vi.fn(),
  } as unknown as WandClient;
  controller.fusion.beginUtterance({
    id: "pending",
    generation: 0,
    startMs: 0,
  });
  controller.game.issue = "Game disconnected";
  controller.game.onChange();
  expect(stopFeedback).toHaveBeenCalledOnce();
  expect(controller.fusion.getState().activeUtterance).toBeUndefined();
  controller.destroy();
});

it("does not admit speech beginning during calibration into fusion", () => {
  let onset!: (event: SpeechOnset) => void;
  vi.spyOn(SpeechClient.prototype, "onOnset").mockImplementation((callback) => {
    onset = callback;
    return () => {};
  });
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  const begin = vi.spyOn(controller.fusion, "beginUtterance");
  onset({ id: "calibrating", generation: 1, startMs: 0 });
  expect(begin).not.toHaveBeenCalled();
  vi.spyOn(controller.motion, "getState").mockReturnValue({
    ...controller.motion.getState(),
    phase: "ready",
  });
  onset({ id: "ready", generation: 1, startMs: 10 });
  expect(begin).toHaveBeenCalledOnce();
  controller.destroy();
});

it("keeps recognition paused through motion calibration and enables it for practice", async () => {
  let sample!: (value: CapturedMotion) => void;
  vi.spyOn(WandClient.prototype, "onSample").mockImplementation((callback) => {
    sample = callback;
    return () => {};
  });
  vi.spyOn(WandClient.prototype, "connect").mockResolvedValue();
  const getSnapshot = WandClient.prototype.getSnapshot;
  vi.spyOn(WandClient.prototype, "getSnapshot").mockImplementation(function (this: WandClient) {
    return { ...getSnapshot.call(this), phase: "streaming" };
  });
  vi.spyOn(GameClient.prototype, "connect").mockResolvedValue();
  vi.stubGlobal("navigator", { bluetooth: { requestDevice: vi.fn() } });
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  controller.quickPlay = false; // the personal calibration flow
  const recognition = vi.spyOn(controller.speech, "setRecognitionEnabled");
  const microphone = vi.spyOn(controller.speech, "start").mockResolvedValue();
  await controller.startMic();
  expect(recognition).toHaveBeenLastCalledWith(false);
  expect(recognition.mock.invocationCallOrder[0]).toBeLessThan(
    microphone.mock.invocationCallOrder[0],
  );
  await controller.connect("ble");
  const fixtures = createCoreMotionFixtures();
  fixtures.stillness.forEach(sample);
  expect(controller.motion.getState().phase).toBe("uncalibrated");
  controller.startCalibration();
  fixtures.stillness.forEach(sample);
  controller.calibrate("stupefy");
  fixtures.calibration.stupefy.forEach((trace) => trace.forEach(sample));
  controller.calibrate("protego");
  // Two guards, each followed by lowering the wand again.
  fixtures.calibration.protego.slice(0, 4).forEach((trace) => trace.forEach(sample));
  expect(recognition.mock.calls.every(([enabled]) => !enabled)).toBe(true);

  fixtures.calibration.protego.slice(4).forEach((trace) => trace.forEach(sample));
  expect(controller.motion.getState().phase).toBe("ready");
  expect(recognition).toHaveBeenLastCalledWith(true);
  controller.calibrate("stupefy");
  expect(recognition).toHaveBeenLastCalledWith(false);
  controller.destroy();
});

it("uses POST-only local brokers and requires explicit hosted phone approval", async () => {
  const roomId = "1".repeat(32),
    ownerToken = "2".repeat(64),
    claimId = "3".repeat(32);
  const pair = {
    roomId,
    ownerToken,
    expiresAtMs: Date.now() + 120_000,
    socketUrl: `wss://wand.example/ws/${roomId}`,
    phoneUrl: `https://wand.example/phone?room=${roomId}`,
  };
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ enabled: true }))
    .mockResolvedValueOnce(Response.json(pair, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    protocol: "http:",
    origin: "http://127.0.0.1:5173",
    host: "127.0.0.1:5173",
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(GameClient.prototype, "connect").mockResolvedValue();
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";

  const connecting = controller.connect("phone");
  await flushPromises();
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/phone/config",
    expect.objectContaining({ method: "POST" }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/phone/pair",
    expect.objectContaining({ method: "POST" }),
  );
  expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined();

  const socket = FakeWebSocket.instances[0];
  expect(socket.url).toBe(pair.socketUrl);
  expect(socket.url).not.toContain(ownerToken);
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  expect(JSON.parse(socket.sent[0])).toEqual({
    v: 2,
    type: "owner",
    token: ownerToken,
  });
  socket.onmessage?.({
    data: JSON.stringify({
      v: 2,
      type: "claim",
      claimId,
      challenge: "482193",
    }),
  });
  expect(controller.phoneClaim?.challenge).toBe("482193");
  expect(socket.sent).toHaveLength(1);
  controller.confirmPhoneClaim();
  expect(JSON.parse(socket.sent[1])).toEqual({
    v: 2,
    type: "approve",
    claimId,
  });

  controller.cancelPhonePairing();
  await connecting;
  expect(socket.closed).toBe(true);
  expect(controller.source).toBeUndefined();
  controller.destroy();
});

it("keeps the trusted-LAN code flow when hosted pairing is disabled", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ enabled: false }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    protocol: "https:",
    origin: "https://wand.test",
    host: "wand.test",
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(GameClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(GameClient.prototype, "pair").mockResolvedValue({
    code: "ABCDEFGHIJ",
    expiresAtMs: 60_000,
  });
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";

  const connecting = controller.connect("phone");
  await flushPromises();
  expect(controller.phoneHosted).toBe(false);
  expect(controller.phoneUrl).toBe("https://wand.test/phone");
  expect(controller.pairingCode).toBe("ABCDEFGHIJ");
  expect(FakeWebSocket.instances[0].url).toBe(
    "wss://wand.test/ws/dev-wand",
  );

  controller.cancelPhonePairing();
  await connecting;
  controller.destroy();
});

it("quick play readies with a connected wand: generic profile, microphone started, no practice", async () => {
  vi.spyOn(WandClient.prototype, "onSample").mockImplementation(() => () => {});
  vi.spyOn(WandClient.prototype, "connect").mockResolvedValue();
  const getSnapshot = WandClient.prototype.getSnapshot;
  vi.spyOn(WandClient.prototype, "getSnapshot").mockImplementation(function (this: WandClient) {
    return { ...getSnapshot.call(this), phase: "streaming" };
  });
  vi.spyOn(GameClient.prototype, "connect").mockResolvedValue();
  vi.stubGlobal("navigator", { bluetooth: { requestDevice: vi.fn() } });
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  const microphone = vi.spyOn(controller.speech, "start").mockResolvedValue();
  expect(controller.quickPlay).toBe(true);
  await controller.connect("ble");
  await flushPromises();
  expect(controller.motion.getState().phase).toBe("ready");
  expect(controller.motion.getState().calibratedSpells).toEqual(["stupefy", "protego"]);
  expect(microphone).toHaveBeenCalledTimes(1);
  expect(controller.practiceComplete()).toBe(true);
  controller.enterBattle();
  expect(controller.battleLobby).toBe(true);

  controller.startCalibration();
  expect(controller.battleLobby).toBe(false);
  expect(controller.quickPlay).toBe(false);
  expect(controller.motion.getState().phase).toBe("stillness");
  expect(controller.practiceComplete()).toBe(false);
  controller.enterBattle();
  expect(controller.battleLobby).toBe(true);
  expect(controller.quickPlay).toBe(true);
  expect(controller.motion.getState().phase).toBe("ready");
  expect(controller.healthy()).toBe(false);
  controller.destroy();
});

it("pauses hidden input without disconnecting the wand or automatically readying on return", async () => {
  vi.spyOn(WandClient.prototype, "connect").mockResolvedValue();
  const getSnapshot = WandClient.prototype.getSnapshot;
  vi.spyOn(WandClient.prototype, "getSnapshot").mockImplementation(function (this: WandClient) {
    return { ...getSnapshot.call(this), phase: "streaming" };
  });
  vi.spyOn(GameClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(SpeechClient.prototype, "start").mockResolvedValue();
  vi.stubGlobal("navigator", { bluetooth: { requestDevice: vi.fn() } });
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  await controller.connect("ble");
  controller.enterBattle();
  const disconnect = vi.spyOn(controller.wand!, "disconnect");
  const suspend = vi.spyOn(controller.wand!, "suspend").mockImplementation(() => {});
  const resume = vi.spyOn(controller.wand!, "resume").mockResolvedValue();
  const stopSpeech = vi.spyOn(controller.speech, "stop");
  const send = vi.spyOn(controller.game, "send");
  controller.fusion.beginUtterance({ id: "before-hide", generation: controller.generation, startMs: 0 });
  const visibility = vi.mocked(document.addEventListener).mock.calls.find(([name]) => name === "visibilitychange")![1] as () => void;
  Reflect.set(document, "hidden", true);
  visibility();
  expect(suspend).toHaveBeenCalledOnce();
  expect(stopSpeech).toHaveBeenCalledOnce();
  expect(controller.healthy()).toBe(false);
  expect(controller.fusion.getState().activeUtterance).toBeUndefined();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "heartbeat", healthy: false }));
  Reflect.set(document, "hidden", false);
  visibility();
  await flushPromises();
  expect(resume).toHaveBeenCalledOnce();
  expect(disconnect).not.toHaveBeenCalled();
  expect(send.mock.calls.some(([message]) => message.type === "ready")).toBe(false);
  expect(controller.battleLobby).toBe(true);
  controller.destroy();
});

it.each([true, false])("restores the battle independently of the wand (retained session: %s)", async (retained) => {
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  controller.source = "ble";
  const reattach = vi.spyOn(controller.game, "reconnect").mockResolvedValue(retained);
  const connect = vi.spyOn(controller.game, "connect").mockResolvedValue();
  const pair = vi.spyOn(controller, "connect");
  const ready = vi.spyOn(controller, "ready");
  await controller.reconnectBattle();
  expect(reattach).toHaveBeenCalledOnce();
  expect(connect.mock.calls).toEqual(retained ? [] : [["ble", "K7X2PD"]]);
  expect(pair).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  expect(controller.motion.getState().phase).toBe("ready");
  expect(controller.busy).toBe(false);
  controller.destroy();
});

it("re-establishes the referee session when a badge retry succeeds after an initial fault", async () => {
  vi.spyOn(WandClient.prototype, "onSample").mockImplementation(() => () => {});
  let phase: "fault" | "streaming" = "fault";
  vi.spyOn(WandClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(WandClient.prototype, "retryRecovery").mockImplementation(async () => { phase = "streaming"; });
  const getSnapshot = WandClient.prototype.getSnapshot;
  vi.spyOn(WandClient.prototype, "getSnapshot").mockImplementation(function (this: WandClient) {
    return { ...getSnapshot.call(this), phase, canRetry: phase === "fault", issue: phase === "fault" ? "GATT operation failed" : "" };
  });
  const gameConnect = vi.spyOn(GameClient.prototype, "connect").mockResolvedValue();
  vi.stubGlobal("navigator", { bluetooth: { requestDevice: vi.fn() } });
  const controller = new DuelController();
  controller.roomCode = "K7X2PD";
  await controller.connect("ble");
  expect(gameConnect).not.toHaveBeenCalled();
  await controller.retryWand();
  expect(gameConnect).toHaveBeenCalledWith("ble", "K7X2PD");
  expect(controller.busy).toBe(false);
  controller.destroy();
});
