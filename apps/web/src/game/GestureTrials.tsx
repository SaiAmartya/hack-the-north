import { useEffect, useMemo, useState } from "react";
import type { DuelController } from "./controller";
import { GestureTrialRecorder, microphoneReady, TRIAL_COUNT, type TrialContext, type TrialLabel } from "./trials";
import "./GestureTrials.css";

const sessions = new WeakMap<DuelController, GestureTrialRecorder>();
const labels: { value: TrialLabel; name: string }[] = [
  { value: "protego", name: "Protego · raise" }, { value: "episkey", name: "Episkey · raise" },
  { value: "stupefy", name: "Stupefy · jab" }, { value: "expelliarmus", name: "Expelliarmus · jab" },
  { value: "incendio", name: "Incendio · jab" }, { value: "still", name: "Still · negative" },
  { value: "fidget", name: "Fidget · negative" },
];

function context(controller: DuelController): TrialContext {
  const wand = controller.wand?.getSnapshot();
  const speech = controller.speech.getSnapshot();
  return {
    source: controller.source, inputGeneration: controller.generation, wandGeneration: wand?.generation,
    bootId: wand?.info?.bootId,
    profile: JSON.stringify(wand?.info ? { sampleHz: wand.info.sampleHz, rangeG: wand.info.rangeG, axisConvention: wand.info.axisConvention } : null),
    streaming: wand?.phase === "streaming", hidden: document.hidden, enabled: controller.devMode, inRoom: !!controller.roomCode,
    speechPhase: speech.phase, speechGeneration: speech.generation,
  };
}

export function GestureTrials({ controller }: { controller: DuelController }) {
  const recorder = useMemo(() => {
    let session = sessions.get(controller);
    if (!session) { session = new GestureTrialRecorder(); sessions.set(controller, session); }
    return session;
  }, [controller]);
  const [now, setNow] = useState(() => performance.now());
  const [, refresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const changed = () => refresh(revision => revision + 1);
  useEffect(() => {
    const update = () => {
      const time = performance.now();
      if (recorder.running) recorder.update(time, context(controller), controller.telemetry.snapshot(30_000).entries);
      setNow(time);
    };
    const timer = setInterval(update, 100);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      if (recorder.running) {
        recorder.update(performance.now(), context(controller), controller.telemetry.snapshot(30_000).entries);
        recorder.interrupt(performance.now(), "recorder_closed");
      }
    };
  }, [controller, recorder]);

  const current = recorder.trials.find(trial => trial.status === "recording");
  const phase = current?.phases.find(item => now >= item.startMs && now < item.endMs);
  const complete = recorder.trials.filter(trial => trial.status === "completed").length;
  const name = labels.find(item => item.value === recorder.label)!.name.split(" · ")[0];
  const negative = recorder.label === "still" || recorder.label === "fidget";
  const action = recorder.label === "still" ? "Hold still"
    : recorder.label === "fidget" ? "Fidget normally"
    : recorder.label === "protego" || recorder.label === "episkey" ? "Raise and hold" : "Jab once";
  const microphone = controller.speech.getSnapshot().phase;
  const wandReady = context(controller).streaming && !controller.roomCode;
  const needsMicrophone = recorder.includesSpeech && !microphoneReady(microphone);
  const ready = wandReady && !needsMicrophone;
  const hasData = recorder.trials.length > 0;
  const start = () => {
    // The marker gives a reliable cursor even after the shared log was cleared.
    controller.telemetry.record("trial.session_started", { intendedLabel: recorder.label, count: TRIAL_COUNT });
    const { entries, total: _total, dropped: _dropped, ...metadata } = JSON.parse(controller.exportTelemetry());
    recorder.start(performance.now(), context(controller), entries.at(-1)?.id ?? 0, {
      ...metadata, firmware: controller.wand?.getSnapshot().info?.firmware ?? null,
      microphonePhaseAtStart: controller.speech.getSnapshot().phase,
    });
    setExpanded(true);
    changed();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([recorder.export()], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `wandduel-trials-${recorder.label}-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <section className="gesture-trials" aria-label="Gesture trial recorder">
    <button className="quiet trial-heading" aria-expanded={expanded} disabled={recorder.running} onClick={() => setExpanded(!expanded)}>
      <span aria-hidden="true">{expanded ? "−" : "+"}</span> Record gesture trials <span>{hasData ? `${complete}/${TRIAL_COUNT}` : "DEV"}</span>
    </button>
    {expanded && <div className="trial-body">
      <p>Ten attempts, recorded whether the gesture is recognized or missed. No duel required.</p>
      <div className="trial-settings">
        <label>Movement<select aria-label="Trial movement" disabled={hasData} value={recorder.label} onChange={event => { recorder.label = event.target.value as TrialLabel; changed(); }}>
          {labels.map(label => <option key={label.value} value={label.value}>{label.name}</option>)}
        </select></label>
        <label className="trial-speech"><input type="checkbox" checked={recorder.speak && !negative} disabled={hasData || negative} onChange={event => { recorder.speak = event.target.checked; changed(); }} />Say the spell while moving · include raw transcripts</label>
      </div>
      <p className="trial-hint">{recorder.includesSpeech ? "Microphone required for these spoken trials. Raw transcripts will be included." : "Movement recording only. Speech events and transcripts are excluded from this export; the microphone is optional."} Microphone audio is never saved. {controller.source !== "ble" && "This records your iPhone; use a badge for badge qualification."}</p>
      {(microphone === "off" || microphone === "fault") && <button className="quiet" disabled={recorder.running} onClick={() => void controller.startMic()}>Enable microphone</button>}
      <label className="trial-notes">Grip / environment / observations<input maxLength={1000} placeholder="For example: right hand, badge upright, quiet room" value={recorder.notes} onChange={event => { recorder.notes = event.target.value; changed(); }} /></label>
      <div className={`trial-prompt ${phase?.phase === "move" ? "trial-moving" : ""}`} role="status" aria-live="polite" aria-atomic="true">
        <span>{recorder.running ? `Trial ${current?.number ?? TRIAL_COUNT} of ${TRIAL_COUNT}` : complete === TRIAL_COUNT ? "Recording complete" : hasData ? "Recording stopped" : `${name} · 10 trials`}</span>
        <strong>{phase?.phase === "countdown" ? `Ready in ${Math.max(1, Math.ceil((phase.endMs - now) / 1000))}`
          : phase?.phase === "move" ? `${action}${recorder.speak && !negative ? ` · say ${name}` : ""}`
          : phase?.phase === "settle" ? "Return to your resting grip"
          : phase?.phase === "rest" ? "Rest"
          : recorder.stoppedReason ? "Interrupted — your captured trials are kept"
          : complete === TRIAL_COUNT ? "Export this movement, then reset for the next"
          : "Hold your badge naturally; follow each cue"}</strong>
      </div>
      <div className="trial-actions">
        {!hasData && <button disabled={!ready} onClick={start}>Start 10 trials</button>}
        {recorder.running && <button className="secondary" onClick={() => { recorder.update(performance.now(), context(controller), controller.telemetry.snapshot(30_000).entries); recorder.interrupt(performance.now(), "user_cancelled"); changed(); }}>Stop recording</button>}
        {hasData && <button className="secondary" disabled={recorder.running} onClick={download}>Export trial JSON ↓</button>}
        {hasData && !recorder.running && <button className="quiet" onClick={() => { recorder.reset(); changed(); }}>Reset trials</button>}
      </div>
      {!wandReady && <p className="trial-hint">Reconnect your wand to start. Existing trials can still be exported.</p>}
      {needsMicrophone && <p className="trial-hint">{microphone === "starting" || microphone === "calibrating" ? "Wait for microphone calibration, then start." : "Enable the microphone to record spoken trials, or uncheck speech to record movement only."}</p>}
      {hasData && <details className="trial-observations"><summary>{complete} completed · add notes for individual trials</summary>
        {recorder.trials.filter(trial => trial.status !== "pending").map(trial => <label key={trial.number}>#{trial.number} · {trial.status}{trial.interruption ? ` (${trial.interruption.reason})` : ""}<input maxLength={500} aria-label={`Trial ${trial.number} observation`} placeholder="Optional: smaller raise, wrong spell heard…" value={trial.observation} onChange={event => { trial.observation = event.target.value; changed(); }} /></label>)}
      </details>}
      <p className="trial-hint">Stay on this page. Switching tabs, changing wand or losing connection stops the capture. Export before leaving or reloading.</p>
    </div>}
  </section>;
}
