import { describe, expect, it } from "vitest";
import { GestureTrialRecorder, TRIAL_DURATION_MS, type TrialContext } from "./trials";
import type { TelemetryEntry } from "./telemetry";

const context: TrialContext = {
  source: "ble", inputGeneration: 3, wandGeneration: 2, bootId: 42,
  profile: "50Hz/8g", streaming: true, hidden: false, enabled: true, inRoom: false,
  speechPhase: "listening", speechGeneration: 7,
};
const sample = (id: number, atMs: number): TelemetryEntry => ({ id, atMs, kind: "wand.sample", data: { axMg: 0, ayMg: 0, azMg: 1000 } });
function started() {
  const recorder = new GestureTrialRecorder();
  recorder.start(100, context, 0, { firmware: { major: 0, minor: 3, patch: 0 } });
  return recorder;
}

describe("labelled physical gesture trials", () => {
  it("records ten failed-to-classify movements without requiring a recognized speech result or cast", () => {
    const recorder = started();
    for (let index = 1; index <= 1000; index++)
      recorder.update(100 + index * 100, context, [sample(index, 99 + index * 100)]);
    expect(recorder.running).toBe(false);
    expect(recorder.trials.map(trial => trial.status)).toEqual(Array(10).fill("completed"));
    expect(recorder.trials.every(trial => trial.entries.length === 100)).toBe(true);
    const result = JSON.parse(recorder.export());
    expect(result).toMatchObject({ format: "wandduel-gesture-trials-v1", intendedLabel: "protego", expectedGesture: "raise", completed: 10 });
    expect(result.trials[0].phases).toEqual([
      { phase: "countdown", startMs: 100, endMs: 3100 },
      { phase: "move", startMs: 3100, endMs: 6100 },
      { phase: "settle", startMs: 6100, endMs: 8100 },
      { phase: "rest", startMs: 8100, endMs: 10100 },
    ]);
    expect(result.metadata.firmware).toEqual({ major: 0, minor: 3, patch: 0 });
  });

  it("retains raw packets and inaccurate transcripts rather than filtering to recognized spells", () => {
    const recorder = started();
    recorder.update(200, context, [
      { id: 1, atMs: 120, kind: "wand.raw_motion", data: { hex: "0102000304" } },
      { id: 2, atMs: 150, kind: "speech.result", data: { transcript: "Potato", spell: null } },
    ]);
    recorder.interrupt(210, "user_cancelled");
    expect(recorder.trials[0]).toMatchObject({ status: "interrupted", interruption: { atMs: 210, reason: "user_cancelled" } });
    expect(recorder.trials[0].entries).toHaveLength(2);
    expect(JSON.parse(recorder.export()).trials[0].entries[1].data.transcript).toBe("Potato");
    expect(recorder.trials.slice(1).every(trial => trial.status === "pending" && !trial.entries.length)).toBe(true);
  });

  it.each([
    [{ hidden: true }, "page_hidden"],
    [{ source: "phone" }, "source_changed"],
    [{ streaming: false }, "wand_not_streaming"],
    [{ inputGeneration: 4 }, "input_context_changed"],
    [{ wandGeneration: 9 }, "input_context_changed"],
    [{ bootId: 99 }, "input_context_changed"],
    [{ profile: "50Hz/2g" }, "input_context_changed"],
    [{ enabled: false }, "dev_mode_disabled"],
    [{ inRoom: true }, "duel_opened"],
    [{ speechPhase: "fault" }, "microphone_not_ready"],
    [{ speechPhase: "calibrating" }, "microphone_not_ready"],
    [{ speechGeneration: 8 }, "speech_generation_changed"],
  ] as const)("interrupts changed capture context %j", (change, reason) => {
    const recorder = started();
    recorder.update(200, context, [sample(1, 190)]);
    recorder.update(300, { ...context, ...change }, [sample(2, 290)]);
    recorder.update(400, context, [sample(3, 390)]);
    expect(recorder.trials[0].status).toBe("interrupted");
    expect(recorder.stoppedReason).toBe(reason);
    expect(recorder.trials[0].entries.map(entry => entry.id)).toEqual([1, 2]);
  });

  it("never advances through a suspended timer or silently missing ring entries", () => {
    const stalled = started();
    stalled.update(TRIAL_DURATION_MS * 2, context, [sample(1, 190), sample(2, 19_900)]);
    expect(stalled.trials.filter(trial => trial.status === "completed")).toHaveLength(0);
    expect(stalled.stoppedReason).toBe("capture_timer_gap");
    expect(stalled.trials[0].entries.map(entry => entry.id)).toEqual([1]);
    expect(stalled.trials[1].entries).toHaveLength(0);
    const dropped = started();
    dropped.update(200, context, [sample(10, 190)]);
    expect(dropped.stoppedReason).toBe("telemetry_buffer_gap");
    expect(dropped.trials[0].entries.map(entry => entry.id)).toEqual([10]);
    expect(dropped.trials[0].status).toBe("interrupted");
  });

  it.each(["off", "starting", "calibrating", "fault"] as const)("requires a ready microphone for spoken trials, not %s", speechPhase => {
    const recorder = new GestureTrialRecorder();
    recorder.start(100, { ...context, speechPhase }, 0, {});
    expect(recorder.running).toBe(false);
    expect(recorder.trials).toHaveLength(0);
    recorder.speak = false;
    recorder.start(100, { ...context, speechPhase }, 0, {});
    expect(recorder.running).toBe(true);
    recorder.update(200, { ...context, speechPhase: "fault", speechGeneration: 99 }, [sample(1, 190)]);
    expect(recorder.running).toBe(true);
  });

  it("permits in-flight transcription but keeps its final fault evidence on interruption", () => {
    const recorder = started();
    recorder.update(200, { ...context, speechPhase: "busy" }, [sample(1, 190)]);
    expect(recorder.running).toBe(true);
    recorder.update(300, { ...context, speechPhase: "fault" }, [
      { id: 2, atMs: 280, kind: "speech.fault", data: { detail: "Microphone disconnected" } },
    ]);
    expect(recorder.stoppedReason).toBe("microphone_not_ready");
    expect(recorder.trials[0].entries.at(-1)?.kind).toBe("speech.fault");
    expect(recorder.trials[0].status).toBe("interrupted");
  });

  it.each([
    { label: "protego", speak: false }, { label: "still", speak: true }, { label: "fidget", speak: true },
  ] as const)("excludes speech from movement-only exports %j", settings => {
    const recorder = new GestureTrialRecorder();
    recorder.label = settings.label;
    recorder.speak = settings.speak;
    recorder.start(100, { ...context, speechPhase: "off" }, 0, {
      speech: "private microphone data", microphonePhaseAtStart: "off",
      profile: { sampleHz: 50 },
      context: { speech: { rawTranscript: "private words" }, fusion: { pendingUtterance: { spell: "protego" }, pendingGesture: { kind: "raise" } } },
    });
    recorder.update(200, { ...context, speechPhase: "off" }, [
      sample(1, 110),
      { id: 2, atMs: 120, kind: "speech.result", data: { transcript: "private words" } },
      { id: 3, atMs: 130, kind: "gesture.classifier", data: { phase: "idle", nested: { rawTranscript: "private words", voiceStartMs: 110 } } },
      { id: 4, atMs: 140, kind: "fusion.state", data: { activeUtterance: { spell: "protego" }, pendingGesture: { kind: "raise" } } },
    ]);
    expect(recorder.running).toBe(true);
    recorder.interrupt(210, "user_cancelled");
    const exported = JSON.parse(recorder.export());
    expect(exported.speakDuringMovement).toBe(false);
    expect(exported.context).not.toHaveProperty("speechPhase");
    expect(exported.context).not.toHaveProperty("speechGeneration");
    expect(exported.metadata).toEqual({ profile: { sampleHz: 50 }, context: { fusion: { pendingGesture: { kind: "raise" } } } });
    expect(exported.trials[0].entries.map((entry: TelemetryEntry) => entry.kind)).toEqual(["wand.sample", "gesture.classifier", "fusion.state"]);
    expect(recorder.export()).not.toContain("private words");
    expect(recorder.export()).not.toContain("rawTranscript");
    expect(recorder.export()).not.toContain("activeUtterance");
  });

  it("preserves the unseen active-window tail without completing or filling future trials on a hidden-page interruption", () => {
    const recorder = started();
    recorder.update(200, context, [sample(1, 190)]);
    recorder.update(10_300, { ...context, hidden: true }, [sample(2, 250), sample(3, 10_200)]);
    expect(recorder.trials[0].status).toBe("interrupted");
    expect(recorder.trials[0].entries.map(entry => entry.id)).toEqual([1, 2]);
    expect(recorder.trials.slice(1).every(trial => trial.status === "pending" && trial.entries.length === 0)).toBe(true);
  });

  it("cannot report a complete trial with no sensor data or grow without a bound", () => {
    const empty = started();
    for (let now = 200; now <= 10_100; now += 100) empty.update(now, context, []);
    expect(empty.stoppedReason).toBe("no_motion_samples");
    expect(empty.trials[0].status).toBe("interrupted");
    const flooded = started();
    flooded.update(200, context, Array.from({ length: 6001 }, (_, i) => sample(i + 1, 190)));
    expect(flooded.stoppedReason).toBe("trial_event_limit");
    expect(flooded.trials[0].entries).toHaveLength(6000);
  });

  it("keeps completed trials on cancellation and requires explicit reset before replacing them", () => {
    const recorder = started();
    for (let index = 1; index <= 105; index++) recorder.update(100 + index * 100, context, [sample(index, 99 + index * 100)]);
    recorder.interrupt(10_700, "user_cancelled");
    recorder.start(10_800, context, 105, {});
    expect(recorder.trials[0].status).toBe("completed");
    expect(recorder.trials[1].status).toBe("interrupted");
    expect(recorder.trials[0].startedAtMs).toBe(100);
    recorder.reset();
    recorder.label = "fidget";
    recorder.start(11_000, context, 105, {});
    expect(recorder.trials[0].startedAtMs).toBe(11_000);
    expect(JSON.parse(recorder.export())).toMatchObject({ expectedGesture: "none", speakDuringMovement: false, completed: 0 });
  });
});
