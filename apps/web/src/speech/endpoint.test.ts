import { describe, expect, it } from "vitest";
import {
  SPEECH_SAMPLE_RATE,
  SpeechEndpoint,
  type CapturedAudioFrame,
  type SpeechEndpointEvent,
} from "./endpoint";

const BLOCK = 128;

function harness() {
  const endpoint = new SpeechEndpoint(7, 1000);
  let frame = 0;
  const push = (
    amplitude: number,
    overrides: Partial<CapturedAudioFrame> = {},
  ): SpeechEndpointEvent[] => {
    const samples = new Float32Array(BLOCK).fill(amplitude);
    const input: CapturedAudioFrame = {
      generation: 7,
      startFrame: frame,
      sampleRate: SPEECH_SAMPLE_RATE,
      channelCount: 1,
      rms: Math.abs(amplitude),
      samples,
      discontinuity: false,
      nonFinite: false,
      ...overrides,
    };
    const events = endpoint.push(input);
    frame += BLOCK;
    return events;
  };
  const many = (amplitude: number, count: number): SpeechEndpointEvent[] => {
    const events: SpeechEndpointEvent[] = [];
    for (let index = 0; index < count; index++) events.push(...push(amplitude));
    return events;
  };
  return { endpoint, push, many, get frame() { return frame; } };
}

describe("speech endpoint", () => {
  it("calibrates for two seconds and keeps padded PCM outside the voice interval", () => {
    const test = harness();
    const calibration = test.many(0.002, 250);
    expect(calibration).toHaveLength(1);
    expect(calibration[0]).toMatchObject({ type: "calibrated" });

    const voiceStartFrame = test.frame;
    const events = [
      ...test.many(0.08, 20),
      ...test.many(0.001, 25),
    ];
    const onset = events.find((event) => event.type === "onset");
    const clip = events.find(
      (event): event is Extract<SpeechEndpointEvent, { type: "clip" }> =>
        event.type === "clip",
    );
    expect(onset).toEqual({
      type: "onset",
      startMs: 1000 + (voiceStartFrame * 1000) / SPEECH_SAMPLE_RATE,
    });
    expect(clip?.startMs).toBe(
      1000 + (voiceStartFrame * 1000) / SPEECH_SAMPLE_RATE,
    );
    expect(clip?.endMs).toBe(
      1000 + ((voiceStartFrame + 20 * BLOCK) * 1000) / SPEECH_SAMPLE_RATE,
    );
    expect(clip?.samples.length).toBe(150 * 16 + 20 * BLOCK + 25 * BLOCK);
  });

  it("does not start on less than 60 ms of loud input", () => {
    const test = harness();
    test.many(0.002, 250);
    const events = [
      ...test.many(0.08, 7),
      ...test.many(0.001, 30),
    ];
    expect(events.some((event) => event.type === "onset")).toBe(false);
    expect(events.some((event) => event.type === "clip")).toBe(false);
  });

  it("caps the unpadded active voice interval at 2.2 seconds", () => {
    const test = harness();
    test.many(0.002, 250);
    const events = test.many(0.08, 300);
    const clip = events.find(
      (event): event is Extract<SpeechEndpointEvent, { type: "clip" }> =>
        event.type === "clip",
    );
    expect(clip).toBeDefined();
    expect(clip!.endMs - clip!.startMs).toBe(2200);
    expect(clip!.samples.byteLength).toBeLessThanOrEqual(3 * 16_000 * 4);
  });

  it("retains calibration but requires uninterrupted quiet before accepting fresh voice", () => {
    const test = harness();
    test.many(0.002, 250);
    test.many(0.08, 20);
    test.endpoint.requireQuiet();
    expect(test.endpoint.isCalibrated()).toBe(true);
    expect(test.many(0.08, 300)).toEqual([]);
    expect(test.many(0.001, 24)).toEqual([]);
    expect(test.push(0.08)).toEqual([]);
    expect(test.many(0.001, 25)).toEqual([]);
    const voiceStartFrame = test.frame;
    const events = [...test.many(0.08, 20), ...test.many(0.001, 25)];
    expect(events.map((event) => event.type)).toEqual(["onset", "clip"]);
    expect(events[0]).toMatchObject({
      startMs: 1000 + (voiceStartFrame * 1000) / SPEECH_SAMPLE_RATE,
    });
    test.endpoint.requireQuiet();
    expect(test.push(0.001, { discontinuity: true })).toEqual([
      { type: "fault", issue: "Audio frame continuity was lost" },
    ]);
  });

  it("faults on discontinuity and ignores old-generation callbacks", () => {
    const test = harness();
    test.many(0.002, 250);
    expect(
      test.push(0.001, { generation: 6, discontinuity: true }),
    ).toEqual([]);
    expect(test.push(0.001, { discontinuity: true })).toEqual([
      { type: "fault", issue: "Audio frame continuity was lost" },
    ]);
    expect(test.push(0.08)).toEqual([]);
  });

  it("faults instead of accepting non-finite PCM", () => {
    const test = harness();
    test.many(0.002, 250);
    const samples = new Float32Array(BLOCK);
    samples[3] = Number.NaN;
    expect(test.push(0.001, { samples, nonFinite: true })).toEqual([
      { type: "fault", issue: "Microphone produced invalid PCM" },
    ]);
  });
});
