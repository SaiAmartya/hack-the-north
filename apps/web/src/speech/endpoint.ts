export const SPEECH_SAMPLE_RATE = 16_000;

const CALIBRATION_FRAMES = SPEECH_SAMPLE_RATE * 2;
const START_FRAMES = Math.ceil(SPEECH_SAMPLE_RATE * 0.06);
const PRE_ROLL_FRAMES = Math.ceil(SPEECH_SAMPLE_RATE * 0.15);
const END_SILENCE_FRAMES = Math.ceil(SPEECH_SAMPLE_RATE * 0.2);
const MAX_VOICE_FRAMES = Math.ceil(SPEECH_SAMPLE_RATE * 2.2);  // "Petrificus Totalus" fits with margin
const MAX_CLIP_FRAMES = SPEECH_SAMPLE_RATE * 3;
const HISTORY_FRAMES = PRE_ROLL_FRAMES + START_FRAMES + 512;

export type CapturedAudioFrame = {
  generation: number;
  startFrame: number;
  sampleRate: number;
  channelCount: number;
  rms: number;
  samples: Float32Array;
  discontinuity: boolean;
  nonFinite: boolean;
};

export type SpeechEndpointEvent =
  | { type: "calibrated"; noiseFloor: number }
  | { type: "onset"; startMs: number }
  | {
      type: "clip";
      startMs: number;
      endMs: number;
      samples: Float32Array;
    }
  | { type: "fault"; issue: string };

type ActiveVoice = {
  voiceStartFrame: number;
  clipStartFrame: number;
  clipNextFrame: number;
  silenceStartFrame?: number;
  parts: Float32Array[];
};

class SampleHistory {
  private readonly values: Float32Array;
  private writeIndex = 0;
  private length = 0;
  private nextFrame?: number;

  constructor(capacity: number) {
    this.values = new Float32Array(capacity);
  }

  append(startFrame: number, samples: Float32Array): boolean {
    if (this.nextFrame !== undefined && startFrame !== this.nextFrame) return false;
    for (const sample of samples) {
      this.values[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.values.length;
      this.length = Math.min(this.length + 1, this.values.length);
    }
    this.nextFrame = startFrame + samples.length;
    return true;
  }

  slice(startFrame: number, endFrame: number): Float32Array {
    if (this.nextFrame === undefined) return new Float32Array();
    const oldestFrame = this.nextFrame - this.length;
    const start = Math.max(startFrame, oldestFrame);
    const end = Math.min(endFrame, this.nextFrame);
    if (end <= start) return new Float32Array();
    const output = new Float32Array(end - start);
    const oldestIndex =
      (this.writeIndex - this.length + this.values.length) % this.values.length;
    const offset = start - oldestFrame;
    for (let index = 0; index < output.length; index++) {
      output[index] =
        this.values[(oldestIndex + offset + index) % this.values.length];
    }
    return output;
  }
}

export class SpeechEndpoint {
  private readonly history = new SampleHistory(HISTORY_FRAMES);
  private calibrationEnergy = 0;
  private calibrationFrames = 0;
  private noiseFloor = 0;
  private calibrated = false;
  private noiseFrozen = false;
  private candidateStartFrame?: number;
  private active?: ActiveVoice;
  private failed = false;
  private quietFramesNeeded = 0;

  constructor(
    private readonly generation: number,
    private readonly timeOriginMs: number,
  ) {}

  push(frame: CapturedAudioFrame): SpeechEndpointEvent[] {
    if (this.failed || frame.generation !== this.generation) return [];
    const issue = this.validate(frame);
    if (issue) return this.fail(issue);
    if (!this.history.append(frame.startFrame, frame.samples)) {
      return this.fail("Audio frame continuity was lost");
    }

    if (!this.calibrated) return this.calibrate(frame);
    if (this.quietFramesNeeded > 0) {
      this.quietFramesNeeded = frame.rms <= this.endThreshold()
        ? Math.max(0, this.quietFramesNeeded - frame.samples.length)
        : END_SILENCE_FRAMES;
      return [];
    }

    const events: SpeechEndpointEvent[] = [];
    const frameEnd = frame.startFrame + frame.samples.length;
    if (this.active) {
      this.appendActive(frame);
      const active = this.active;
      if (frame.rms <= this.endThreshold()) {
        active.silenceStartFrame ??= frame.startFrame;
      } else {
        active.silenceStartFrame = undefined;
      }

      const clipLimit = active.clipStartFrame + MAX_CLIP_FRAMES;
      const voiceLimit = active.voiceStartFrame + MAX_VOICE_FRAMES;
      if (
        active.silenceStartFrame !== undefined &&
        frameEnd - active.silenceStartFrame >= END_SILENCE_FRAMES
      ) {
        events.push(this.finish(active.silenceStartFrame, frameEnd));
      } else if (frameEnd >= voiceLimit) {
        events.push(this.finish(voiceLimit, Math.min(frameEnd, clipLimit)));
      } else if (frameEnd >= clipLimit) {
        events.push(this.finish(Math.min(frameEnd, clipLimit), clipLimit));
      }
      return events;
    }

    if (!this.noiseFrozen && frame.rms <= this.endThreshold()) {
      const weight = 0.01;
      this.noiseFloor = Math.sqrt(
        (1 - weight) * this.noiseFloor ** 2 + weight * frame.rms ** 2,
      );
    }

    if (frame.rms >= this.startThreshold()) {
      this.candidateStartFrame ??= frame.startFrame;
      if (frameEnd - this.candidateStartFrame >= START_FRAMES) {
        const voiceStartFrame = this.candidateStartFrame;
        const clipStartFrame = Math.max(0, voiceStartFrame - PRE_ROLL_FRAMES);
        const initial = this.history.slice(clipStartFrame, frameEnd);
        this.active = {
          voiceStartFrame,
          clipStartFrame,
          clipNextFrame: frameEnd,
          parts: [initial],
        };
        this.candidateStartFrame = undefined;
        this.noiseFrozen = true;
        events.push({ type: "onset", startMs: this.toMs(voiceStartFrame) });
      }
    } else {
      this.candidateStartFrame = undefined;
    }
    return events;
  }

  resolve(): void {
    if (!this.active) this.noiseFrozen = false;
  }

  requireQuiet(): void {
    this.active = undefined;
    this.candidateStartFrame = undefined;
    this.noiseFrozen = false;
    this.quietFramesNeeded = END_SILENCE_FRAMES;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  private validate(frame: CapturedAudioFrame): string {
    if (frame.sampleRate !== SPEECH_SAMPLE_RATE)
      return `Audio sample rate changed to ${frame.sampleRate} Hz`;
    if (frame.channelCount !== 1) return "Audio worklet input is not mono";
    if (
      frame.discontinuity ||
      !Number.isSafeInteger(frame.startFrame) ||
      frame.startFrame < 0
    )
      return "Audio frame continuity was lost";
    if (
      frame.nonFinite ||
      !Number.isFinite(frame.rms) ||
      frame.rms < 0 ||
      frame.samples.length === 0
    )
      return "Microphone produced invalid PCM";
    for (const sample of frame.samples) {
      if (!Number.isFinite(sample)) return "Microphone produced invalid PCM";
    }
    return "";
  }

  private calibrate(frame: CapturedAudioFrame): SpeechEndpointEvent[] {
    this.calibrationEnergy += frame.rms ** 2 * frame.samples.length;
    this.calibrationFrames += frame.samples.length;
    if (this.calibrationFrames < CALIBRATION_FRAMES) return [];
    this.noiseFloor = Math.max(
      0.0001,
      Math.sqrt(this.calibrationEnergy / this.calibrationFrames),
    );
    this.calibrated = true;
    return [{ type: "calibrated", noiseFloor: this.noiseFloor }];
  }

  private appendActive(frame: CapturedAudioFrame): void {
    const active = this.active;
    if (!active) return;
    const offset = Math.max(0, active.clipNextFrame - frame.startFrame);
    if (offset < frame.samples.length) active.parts.push(frame.samples.slice(offset));
    active.clipNextFrame = Math.max(
      active.clipNextFrame,
      frame.startFrame + frame.samples.length,
    );
  }

  private finish(voiceEndFrame: number, clipEndFrame: number): SpeechEndpointEvent {
    const active = this.active!;
    const wantedFrames = Math.max(
      0,
      Math.min(MAX_CLIP_FRAMES, clipEndFrame - active.clipStartFrame),
    );
    const samples = new Float32Array(wantedFrames);
    let written = 0;
    for (const part of active.parts) {
      const remaining = samples.length - written;
      if (remaining <= 0) break;
      const length = Math.min(remaining, part.length);
      samples.set(part.subarray(0, length), written);
      written += length;
    }
    this.active = undefined;
    this.candidateStartFrame = undefined;
    return {
      type: "clip",
      startMs: this.toMs(active.voiceStartFrame),
      endMs: this.toMs(Math.max(active.voiceStartFrame, voiceEndFrame)),
      samples: written === samples.length ? samples : samples.slice(0, written),
    };
  }

  private startThreshold(): number {
    return Math.max(0.02, this.noiseFloor * 3, this.noiseFloor + 0.012);
  }

  private endThreshold(): number {
    return Math.max(0.012, this.noiseFloor * 1.8, this.noiseFloor + 0.006);
  }

  private toMs(frame: number): number {
    return this.timeOriginMs + (frame * 1000) / SPEECH_SAMPLE_RATE;
  }

  private fail(issue: string): SpeechEndpointEvent[] {
    this.failed = true;
    this.active = undefined;
    return [{ type: "fault", issue }];
  }
}
