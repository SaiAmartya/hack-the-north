import { expect, test } from "@playwright/test";
import { castWithMicrophone, connectBadge, scriptedLaptop, snapshot } from "./scripted-laptop";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test("audio worklet tolerates graph priming but reports loss after capture starts", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 16_000 });
    await context.audioWorklet.addModule("/worklets/speech-capture.js");
    const node = new AudioWorkletNode(context, "wand-speech-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { generation: 17 },
    });
    const messages: { length: number; discontinuity: boolean }[] = [];
    node.port.onmessage = ({ data }) =>
      messages.push({
        length: data.samples.length,
        discontinuity: data.discontinuity,
      });
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    node.connect(silentOutput).connect(context.destination);
    await context.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const beforeSource = messages.length;

    const source = context.createConstantSource();
    source.offset.value = 0.01;
    source.connect(node);
    source.start();
    const deadline = performance.now() + 1_000;
    while (!messages.length && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const first = messages[0];

    source.disconnect(node);
    const lossDeadline = performance.now() + 1_000;
    while (
      !messages.some((message) => message.discontinuity) &&
      performance.now() < lossDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const reportedLoss = messages.some((message) => message.discontinuity);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outageCount = messages.filter(message => message.discontinuity).length;
    const beforeResume = messages.length;
    source.connect(node);
    const resumeDeadline = performance.now() + 1_000;
    while (messages.length < beforeResume + 10 && performance.now() < resumeDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    const resumed = messages.slice(beforeResume);
    source.stop();
    node.disconnect();
    await context.close();
    return { beforeSource, first, reportedLoss, outageCount, resumed };
  });

  expect(result.beforeSource).toBe(0);
  expect(result.first).toEqual({ length: 128, discontinuity: false });
  expect(result.reportedLoss).toBe(true);
  expect(result.outageCount).toBe(1);
  expect(result.resumed.length).toBeGreaterThanOrEqual(10);
  expect(result.resumed.every(frame => frame.length === 128 && !frame.discontinuity)).toBe(true);
});

test("battle microphone ignores unrelated device changes and recovers a suspended audio clock before casting", async ({ page }) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => {
    const captureContexts: AudioContext[] = [];
    Reflect.set(window, "__captureContexts", captureContexts);
    const NativeAudioContext = window.AudioContext;
    class ObservedAudioContext extends NativeAudioContext {
      override createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
        // Observe only the production capture context, not the synthetic mic source.
        captureContexts.push(this);
        return super.createMediaStreamSource(stream);
      }
    }
    window.AudioContext = ObservedAudioContext;
  });
  const laptop = await scriptedLaptop(page);
  laptop.enableSpeech();
  await connectBadge(page);
  await page.getByRole("button", { name: "Duel a bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");

  const initial = await page.evaluate(() => {
    const controller = Reflect.get(window, "__duelController");
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    return { generation: controller.speech.getSnapshot().generation,
      contexts: Reflect.get(window, "__captureContexts").length };
  });
  await page.waitForTimeout(300); // Let asynchronous device-change handling settle.
  expect(await page.evaluate(() => {
    const controller = Reflect.get(window, "__duelController");
    return { generation: controller.speech.getSnapshot().generation,
      contexts: Reflect.get(window, "__captureContexts").length, healthy: controller.healthy() };
  })).toEqual({ ...initial, healthy: true });

  const interruptedAt = await page.evaluate(async () => {
    const contexts = Reflect.get(window, "__captureContexts") as AudioContext[];
    const atMs = performance.now();
    await contexts.at(-1)!.suspend();
    return atMs;
  });
  await expect.poll(() => page.evaluate(() => {
    const controller = Reflect.get(window, "__duelController");
    return controller.healthy() && controller.speech.getSnapshot().phase === "listening";
  }), { timeout: 10_000 }).toBe(true);
  const recovered = await page.evaluate(() => {
    const contexts = Reflect.get(window, "__captureContexts") as AudioContext[];
    return { contexts: contexts.length, first: contexts[0].state, last: contexts.at(-1)!.state,
      generation: Reflect.get(window, "__duelController").speech.getSnapshot().generation };
  });
  expect(recovered).toMatchObject({ contexts: initial.contexts + 1, first: "closed", last: "running" });
  expect(recovered.generation).toBeGreaterThan(initial.generation);
  expect((await snapshot(page)).phase).toBe("playing");

  // Real PCM/worklet + raw BLE + referee; only speech decoding is scripted.
  const proof = await castWithMicrophone(page, "stupefy", "speech-first", { speechFirst: "immediate" });
  expect(proof.voices[0].startMs).toBeGreaterThan(interruptedAt);
  await expect(page.getByRole("meter", { name: "Opponent health" })).toHaveAttribute("value", "80");
  await expect(page.getByRole("button", { name: "Enable microphone", exact: true })).toHaveCount(0);
});

test.describe("production browser speech capture", () => {
  test("streams contiguous mono 16 kHz frames and releases owned resources", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      type BrowserFrame = {
        generation: number;
        startFrame: number;
        sampleRate: number;
        channelCount: number;
        samples: Float32Array;
        discontinuity: boolean;
        nonFinite: boolean;
      };
      type BrowserPlatform = {
        openCapture(
          generation: number,
          workletUrl: string,
          onFrame: (frame: BrowserFrame, timeOriginMs: number) => void,
          onLost: (issue: string) => void,
        ): Promise<{ stop(): void }>;
      };

      const nativeGetUserMedia =
        navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let openedTrack: MediaStreamTrack | undefined;
      let requestedConstraints: MediaStreamConstraints | undefined;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          requestedConstraints = constraints;
          const stream = await nativeGetUserMedia(constraints);
          openedTrack = stream.getAudioTracks()[0];
          return stream;
        },
      });
      const NativeAudioContext = window.AudioContext;
      let openedContext: AudioContext | undefined;
      let closeCalls = 0;
      class TrackingAudioContext extends NativeAudioContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          openedContext = this;
        }
        override close(): Promise<void> {
          closeCalls++;
          return super.close();
        }
      }
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: TrackingAudioContext,
      });

      const modulePath = "/src/speech/client.ts";
      const speechModule = (await import(
        /* @vite-ignore */ modulePath
      )) as { browserSpeechPlatform(): BrowserPlatform };
      const frames: BrowserFrame[] = [];
      const timeOrigins: number[] = [];
      const lost: string[] = [];
      const capture = await speechModule.browserSpeechPlatform().openCapture(
        23,
        "/worklets/speech-capture.js",
        (frame, timeOriginMs) => {
          frames.push(frame);
          timeOrigins.push(timeOriginMs);
        },
        (issue) => lost.push(issue),
      );
      const deadline = performance.now() + 5_000;
      while (frames.length < 320 && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const summaries = frames.map((frame) => ({
        generation: frame.generation,
        startFrame: frame.startFrame,
        sampleRate: frame.sampleRate,
        channelCount: frame.channelCount,
        length: frame.samples.length,
        discontinuity: frame.discontinuity,
        nonFinite: frame.nonFinite,
      }));
      capture.stop();
      capture.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        summaries,
        timeOrigins,
        lost,
        trackState: openedTrack?.readyState,
        reportedTrackChannels: openedTrack?.getSettings().channelCount,
        contextState: openedContext?.state,
        closeCalls,
        requestedConstraints,
      };
    });

    expect(result.summaries.length).toBeGreaterThanOrEqual(320);
    expect(
      result.summaries.every(
        (frame) =>
          frame.generation === 23 &&
          frame.sampleRate === 16_000 &&
          frame.channelCount === 1 &&
          frame.length === 128 &&
          !frame.discontinuity &&
          !frame.nonFinite,
      ),
    ).toBe(true);
    expect(
      result.summaries.every(
        (frame, index, frames) =>
          index === 0 ||
          frame.startFrame ===
            frames[index - 1].startFrame + frames[index - 1].length,
      ),
    ).toBe(true);
    expect(result.timeOrigins.every(Number.isFinite)).toBe(true);
    expect(new Set(result.timeOrigins).size).toBe(1);
    const first = result.summaries[0],
      last = result.summaries.at(-1)!;
    expect(
      ((last.startFrame - first.startFrame) * 1000) / 16_000,
    ).toBeGreaterThan(2_000);
    expect(result.lost).toEqual([]);
    expect(result.trackState).toBe("ended");
    expect(result.contextState).toBe("closed");
    expect(result.closeCalls).toBe(1);
    expect(result.requestedConstraints).toEqual({
      audio: { channelCount: { exact: 1 }, echoCancellation: true,
        noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  });
});
