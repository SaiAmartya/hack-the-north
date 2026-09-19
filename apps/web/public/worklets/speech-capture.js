class WandSpeechCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.generation = options.processorOptions.generation;
    this.expectedFrame = null;
    this.pendingStart = null;
  }

  process(inputs) {
    const input = inputs[0] ?? [];
    const channel = input[0];
    if (!channel || channel.length === 0) {
      // Chrome may prime a newly connected graph with empty or isolated input
      // quanta. There is no established sequence to lose until two real blocks
      // arrive consecutively.
      if (this.expectedFrame === null) {
        this.pendingStart = null;
        return true;
      }
      this.port.postMessage({
        generation: this.generation,
        startFrame: currentFrame,
        sampleRate,
        channelCount: input.length,
        rms: 0,
        samples: new Float32Array(),
        discontinuity: true,
        nonFinite: true,
      });
      return true;
    }

    const samples = new Float32Array(channel.length);
    let energy = 0;
    let nonFinite = false;
    for (let index = 0; index < channel.length; index++) {
      const sample = channel[index];
      samples[index] = sample;
      if (Number.isFinite(sample)) energy += sample * sample;
      else nonFinite = true;
    }
    const startFrame = currentFrame;
    const message = {
      generation: this.generation,
      startFrame,
      sampleRate,
      channelCount: input.length,
      rms: Math.sqrt(energy / samples.length),
      samples,
      discontinuity: false,
      nonFinite,
    };
    if (this.expectedFrame === null) {
      if (nonFinite || input.length !== 1) {
        this.port.postMessage(message, [samples.buffer]);
        return true;
      }
      const pending = this.pendingStart;
      if (
        !pending ||
        startFrame !== pending.startFrame + pending.samples.length
      ) {
        this.pendingStart = message;
        return true;
      }
      this.pendingStart = null;
      this.expectedFrame = startFrame + samples.length;
      this.port.postMessage(pending, [pending.samples.buffer]);
      this.port.postMessage(message, [samples.buffer]);
      return true;
    }

    message.discontinuity = startFrame !== this.expectedFrame;
    this.expectedFrame = startFrame + samples.length;
    this.port.postMessage(message, [samples.buffer]);
    return true;
  }
}

registerProcessor("wand-speech-capture", WandSpeechCaptureProcessor);
