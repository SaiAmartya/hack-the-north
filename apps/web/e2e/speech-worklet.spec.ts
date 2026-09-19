import { expect, test } from "@playwright/test";

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
    source.stop();
    node.disconnect();
    await context.close();
    return { beforeSource, first, reportedLoss };
  });

  expect(result.beforeSource).toBe(0);
  expect(result.first).toEqual({ length: 128, discontinuity: false });
  expect(result.reportedLoss).toBe(true);
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
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
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
  });
});
