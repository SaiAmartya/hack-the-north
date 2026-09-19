import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type WorkletMessage = {
  startFrame: number;
  samples: Float32Array;
  discontinuity: boolean;
};

type Processor = {
  process(inputs: Float32Array[][]): boolean;
};

describe("speech capture worklet", () => {
  it("ignores only pre-capture empty quanta and still reports later loss", () => {
    const messages: WorkletMessage[] = [];
    let ProcessorClass:
      | (new (options: { processorOptions: { generation: number } }) => Processor)
      | undefined;
    class TestAudioWorkletProcessor {
      readonly port = {
        postMessage: (message: WorkletMessage) => messages.push(message),
      };
    }
    const context: Record<string, unknown> = {
      AudioWorkletProcessor: TestAudioWorkletProcessor,
      Float32Array,
      Math,
      Number,
      currentFrame: 0,
      sampleRate: 16_000,
      registerProcessor: (
        name: string,
        constructor: new (options: {
          processorOptions: { generation: number };
        }) => Processor,
      ) => {
        expect(name).toBe("wand-speech-capture");
        ProcessorClass = constructor;
      },
    };
    runInNewContext(
      readFileSync(
        resolve(process.cwd(), "public/worklets/speech-capture.js"),
        "utf8",
      ),
      context,
    );
    expect(ProcessorClass).toBeDefined();
    const processor = new ProcessorClass!({
      processorOptions: { generation: 9 },
    });

    expect(processor.process([[]])).toBe(true);
    expect(messages).toEqual([]);

    context.currentFrame = 128;
    expect(processor.process([[new Float32Array(128).fill(0.01)]])).toBe(true);
    expect(messages).toEqual([]);

    context.currentFrame = 384;
    expect(processor.process([[new Float32Array(128).fill(0.01)]])).toBe(true);
    expect(messages).toEqual([]);

    context.currentFrame = 512;
    expect(processor.process([[new Float32Array(128).fill(0.01)]])).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages.map(({ startFrame, discontinuity }) => ({
      startFrame,
      discontinuity,
    }))).toEqual([
      { startFrame: 384, discontinuity: false },
      { startFrame: 512, discontinuity: false },
    ]);

    context.currentFrame = 768;
    expect(processor.process([[new Float32Array(128).fill(0.01)]])).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({
      startFrame: 768,
      discontinuity: true,
    });
    expect(messages[2].samples).toHaveLength(128);

    context.currentFrame = 896;
    expect(processor.process([[]])).toBe(true);
    expect(messages).toHaveLength(4);
    expect(messages[3]).toMatchObject({
      startFrame: 896,
      discontinuity: true,
    });
    expect(messages[3].samples).toHaveLength(0);
  });
});
