import { useEffect, useRef, useState } from "react";
import { WandClient, type WandSnapshot } from "../wand/client";
import { VirtualWandTransport, type ReplayName } from "../wand/virtual";
import { BleWandTransport } from "../wand/transport";
import {
  CueEffect,
  HealthFlag,
  PresentationPhase,
  SpellCode,
} from "../wand/protocol";
import type { PresentationSnapshot } from "../wand/endpoint";
import "./lab.css";

type Session = {
  client: WandClient;
  virtual?: VirtualWandTransport;
  presentationEpoch: number;
};
const emptyPreview: PresentationSnapshot = {
  state: null,
  cue: null,
  cueRevision: 0,
};

function WizardStar() {
  return (
    <svg
      className="wizard-star"
      viewBox="0 0 300 240"
      fill="none"
      aria-hidden="true"
    >
      <ellipse cx="156" cy="218" rx="70" ry="10" fill="#e8cf89" />
      <circle cx="156" cy="126" r="89" fill="#ffe39a" />
      <path
        d="m149 75 27 44 49 11-35 37 3 46-43-22-45 20 5-47-32-37 48-8Z"
        fill="#e6a92e"
      />
      <path
        d="m149 68 27 44 49 11-35 37 3 46-43-22-45 20 5-47-32-37 48-8Z"
        fill="#ffc857"
        stroke="#c38c28"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M116 91c18-24 24-49 41-68 2 20 17 22 25 35 6 10 8 20 8 34"
        fill="#7054cf"
        stroke="#4c3796"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M113 88c21-7 62-9 82 2 13 8 8 16-4 18-25 5-59 5-81-3-10-4-9-13 3-17Z"
        fill="#8364de"
        stroke="#4c3796"
        strokeWidth="3"
      />
      <path d="m153 52 4 8 9 1-6 6 1 9-8-4-7 4 1-9-6-6 9-1Z" fill="#fff0bf" />
      <ellipse cx="134" cy="139" rx="5" ry="8" fill="#252641" />
      <ellipse cx="172" cy="139" rx="5" ry="8" fill="#252641" />
      <path
        d="M143 158q10 12 20-1"
        stroke="#252641"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <ellipse cx="119" cy="153" rx="9" ry="5" fill="#ee9470" />
      <ellipse cx="186" cy="153" rx="9" ry="5" fill="#ee9470" />
      <path
        d="m204 163 32-49"
        stroke="#674737"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="m230 123 6-9"
        stroke="#fffefa"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="m239 80 3 11 11 3-11 3-3 11-3-11-11-3 11-3ZM59 125l3 10 10 3-10 3-3 10-3-10-10-3 10-3Z"
        fill="#7054cf"
      />
      <path d="m82 59 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z" fill="#c38c28" />
      <circle cx="213" cy="46" r="4" fill="#c38c28" />
      <circle cx="57" cy="184" r="4" fill="#7054cf" />
    </svg>
  );
}

export function DeviceLab() {
  const session = useRef<Session>();
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<WandSnapshot>();
  const [preview, setPreview] = useState(emptyPreview);
  const [source, setSource] = useState<"replay" | "ble">("replay");
  const [message, setMessage] = useState("");
  const [host, setHost] = useState("not checked");
  const [refresh, setRefresh] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.hidden) session.current?.client.suspend();
    };
    document.addEventListener("visibilitychange", hidden);
    const timer = window.setInterval(() => {
      const current = session.current;
      if (!current) return;
      setSnapshot(current.client.getSnapshot());
      setPreview(current.virtual?.endpoint.getPresentation() ?? emptyPreview);
      const context = canvas.current?.getContext("2d");
      if (!context) return;
      const samples = current.client.getSamples();
      const width = context.canvas.width;
      const height = context.canvas.height;
      context.clearRect(0, 0, width, height);
      context.strokeStyle = "#ffffff12";
      context.beginPath();
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
      context.stroke();
      const colors = ["#ed7a86", "#81dcd0", "#baa8f7"];
      const axes = ["axMg", "ayMg", "azMg"] as const;
      axes.forEach((axis, index) => {
        context.strokeStyle = colors[index];
        context.lineWidth = 2;
        context.beginPath();
        samples.forEach((sample, i) => {
          const x =
            width -
            (((samples.at(-1)?.browserMs ?? 0) - sample.browserMs) * width) /
              2000;
          const y = height / 2 - ((sample[axis] / 4000) * height) / 2;
          if (i === 0 || sample.breaksGesture) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      });
    }, 100);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hidden);
      session.current?.client.disconnect();
      session.current = undefined;
    };
  }, []);

  async function connect() {
    session.current?.client.disconnect();
    setRefresh(false);
    setMessage("");
    setPreview(emptyPreview);
    try {
      const virtual =
        source === "replay" ? new VirtualWandTransport() : undefined;
      if (!virtual && (!window.isSecureContext || !navigator.bluetooth))
        throw new Error(
          "Web Bluetooth requires supported desktop Chrome and a secure context",
        );
      const client = new WandClient(
        virtual ?? new BleWandTransport(navigator.bluetooth),
      );
      session.current = {
        client,
        virtual,
        presentationEpoch: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
      };
      const connection = client.connect();
      setSnapshot(client.getSnapshot());
      await connection;
      if (session.current?.client === client) setSnapshot(client.getSnapshot());
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error ? error.message : "Connection failed",
        );
    }
  }

  function disconnect() {
    session.current?.client.disconnect();
    setSnapshot(session.current?.client.getSnapshot());
    setPreview(emptyPreview);
    setRefresh(false);
  }

  function feedback() {
    const current = session.current;
    if (!current) return;
    current.client.setState({
      phase: PresentationPhase.Practice,
      hp: 100,
      maxHp: 100,
      statusFlags: 0,
      presentationEpoch: current.presentationEpoch,
    });
    setRefresh(true);
  }

  async function checkHost() {
    try {
      const response = await fetch("/api/game/health", {
        signal: AbortSignal.timeout(2000),
      });
      const body: unknown = await response.json();
      const valid =
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        "version" in body &&
        body.version === 1 &&
        "stage" in body &&
        body.stage === "device-lab" &&
        "multiplayerReady" in body &&
        body.multiplayerReady === false;
      if (mounted.current)
        setHost(
          valid
            ? "isolated host online · multiplayer not built"
            : "unexpected host response",
        );
    } catch {
      if (mounted.current) setHost("offline · Device Lab replay still works");
    }
  }

  const streaming = snapshot?.phase === "streaming";
  const connecting =
    snapshot?.phase === "connecting" || snapshot?.phase === "synchronizing";
  const inactive =
    !snapshot ||
    snapshot.phase === "disconnected" ||
    snapshot.phase === "fault";
  const sample = snapshot?.lastSample;
  const virtual = session.current?.virtual;
  const health = snapshot?.healthFlags ?? 0;
  const pretty = (value: number | undefined) =>
    value === undefined ? "—" : value.toFixed(1);

  return (
    <div className="lab">
      <a className="skip-link" href="#practice-lab">
        Skip to practice lab
      </a>
      <aside className="lab-sidebar" aria-label="Wizarding workshop">
        <a className="lab-brand" href="#practice-lab">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <span>
            wand<span className="brand-accent">duel</span>
            <small>THE WIZARDING WORKSHOP</small>
          </span>
        </a>
        <p className="nav-caption">YOUR WORKSHOP</p>
        <nav aria-label="Practice sections">
          <a href="#practice-lab" className="nav-current" aria-current="page">
            <span aria-hidden="true">✦</span> Practice lab
          </a>
          <a href="#signal">
            <span aria-hidden="true">⌁</span> Motion journal
          </a>
          <a href="#feedback">
            <span aria-hidden="true">☼</span> Wand feedback
          </a>
          <a href="#recovery">
            <span aria-hidden="true">↻</span> Recovery trials
          </a>
        </nav>
        <div className="sidebar-next">
          <span className="next-symbol" aria-hidden="true">
            ⚔
          </span>
          <strong>The dueling club</strong>
          <p>
            First, the fundamentals.
            <br />
            Real duels are a later chapter.
          </p>
          <span className="soon-label">NOT BUILT YET</span>
        </div>
        <div className="sidebar-note">
          <span aria-hidden="true">◇</span>
          <p>
            Small steps.
            <br />
            <strong>Extraordinary spells.</strong>
          </p>
        </div>
      </aside>
      <div className="lab-workspace">
        <header className="lab-header">
          <div>
            <span className="header-breadcrumb">The workshop</span>
            <span aria-hidden="true"> / </span>
            <strong>Practice lab</strong>
          </div>
          <span className="lab-tag">
            <span className="status-dot" /> DEVELOPMENT BUILD · 0–1
          </span>
        </header>
        <main id="practice-lab" tabIndex={-1}>
          <section className="lab-intro">
            <div className="intro-copy">
              <p className="lab-eyebrow">THE WAND COMES FIRST</p>
              <h1>
                Every great wizard
                <br />
                starts here.
              </h1>
              <p>
                A little practice before the magic. Connect a virtual wand,
                watch it move, and put its feedback to the test.
              </p>
              <a className="hero-link" href="#connect">
                Let's meet your wand <span aria-hidden="true">→</span>
              </a>
              <span className="intro-meta">
                5-minute check · No hardware needed for replay
              </span>
            </div>
            <WizardStar />
          </section>
          <ol className="practice-path" aria-label="Your practice checklist">
            <li>
              <a href="#connect">
                <span>1</span> Connect
              </a>
            </li>
            <li>
              <a href="#signal">
                <span>2</span> Watch motion
              </a>
            </li>
            <li>
              <a href="#feedback">
                <span>3</span> Test feedback
              </a>
            </li>
            <li>
              <a href="#recovery">
                <span>4</span> Try recovery
              </a>
            </li>
          </ol>
          <div className="lab-notice">
            <span className="notice-icon" aria-hidden="true">
              i
            </span>
            <div>
              <strong>A practice bench, not a spell lesson. Yet.</strong>
              <p>
                Diagnostic build — no spell recognition, speech, phone pairing
                or multiplayer yet. No microphone or camera is requested.
              </p>
            </div>
          </div>
          <div className="lab-grid">
            <section
              className="lab-panel"
              id="connect"
              aria-labelledby="connect-title"
            >
              <div className="lab-section">
                <span>
                  <b className="step-number">1</b> CONNECTION
                </span>
                <span className="source-pill" data-testid="source-label">
                  {snapshot?.source ?? "REPLAY"}
                </span>
              </div>
              <h2 id="connect-title">Meet your wand.</h2>
              <p className="panel-description">
                Start with replay. No badge, phone, or permissions needed.
              </p>
              <label htmlFor="source">Transport</label>
              <select
                id="source"
                value={source}
                disabled={!inactive}
                onChange={(e) =>
                  setSource(e.target.value === "ble" ? "ble" : "replay")
                }
              >
                <option value="replay">Virtual wand · raw replay</option>
                <option value="ble">
                  Real BLE · hardware qualification pending
                </option>
              </select>
              <div className="lab-actions">
                <button
                  onClick={() => void connect()}
                  disabled={connecting || !inactive}
                >
                  Connect wand
                </button>
                <button
                  className="secondary"
                  onClick={disconnect}
                  disabled={inactive}
                >
                  Disconnect
                </button>
              </div>
              <p
                className={`lab-state state-${snapshot?.phase ?? "disconnected"}`}
                data-testid="phase"
                role="status"
              >
                {snapshot?.phase ?? "disconnected"}
              </p>
              {(message || snapshot?.issue) && (
                <p className="lab-warning" role="alert">
                  {message || snapshot?.issue}
                </p>
              )}
              <dl>
                <dt>Device ID</dt>
                <dd>
                  {snapshot?.info?.deviceId
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("")
                    .toUpperCase() ?? "—"}
                </dd>
                <dt>Boot / generation</dt>
                <dd>
                  {snapshot?.info?.bootId.toString(16) ?? "—"} /{" "}
                  {snapshot?.generation ?? 0}
                </dd>
                <dt>Reported profile</dt>
                <dd>
                  {snapshot?.info
                    ? `${snapshot.info.sampleHz} Hz / ±${snapshot.info.rangeG} g`
                    : "—"}
                </dd>
                <dt>Speech / casting</dt>
                <dd>Not implemented · no Ready</dd>
              </dl>
              <button className="text-button" onClick={() => void checkHost()}>
                Check isolated host
              </button>
              <p className="lab-small">{host}</p>
            </section>
            <section
              className="lab-panel signal"
              id="signal"
              aria-labelledby="signal-title"
            >
              <div className="lab-section">
                <span>
                  <b className="step-number">2</b> MOTION JOURNAL
                </span>
                <span className="quiet-tag">RAW SIGNAL</span>
              </div>
              <h2 id="signal-title">Give it a little wave.</h2>
              <p className="panel-description">
                A peek at the raw signal. Gravity included, spellcasting not
                included.
              </p>
              <div className="signal-screen">
                <div className="signal-caption">
                  <span>
                    <i className={streaming ? "live-dot active" : "live-dot"} />
                    {streaming ? "RECEIVING MOTION" : "WAITING FOR YOUR WAND"}
                  </span>
                  <span>LAST 2 SECONDS</span>
                </div>
                <canvas
                  ref={canvas}
                  width={720}
                  height={180}
                  aria-label="Two-second acceleration trace; X pink, Y teal, Z violet"
                />
                <div className="axis-values">
                  <span>
                    X <b>{sample?.axMg ?? "—"}</b>
                  </span>
                  <span>
                    Y <b>{sample?.ayMg ?? "—"}</b>
                  </span>
                  <span>
                    Z <b>{sample?.azMg ?? "—"}</b>
                    <small> mg</small>
                  </span>
                </div>
              </div>
              <dl className="metrics">
                <dt>Accepted</dt>
                <dd data-testid="accepted">{snapshot?.accepted ?? 0}</dd>
                <dt>Rejected / lost</dt>
                <dd data-testid="rejected">
                  {snapshot?.rejected ?? 0} / {snapshot?.lost ?? 0}
                </dd>
                <dt>Last delivery age upper bound</dt>
                <dd>{pretty(sample?.ageUpperMs)} ms</dd>
                <dt>Valid cadence / largest observed gap</dt>
                <dd>
                  {pretty(snapshot?.observedHz)} Hz / {snapshot?.maxGapMs ?? 0}{" "}
                  ms
                </dd>
                <dt>Endpoint-reported drops</dt>
                <dd>{snapshot?.deviceDropped ?? 0}</dd>
                <dt>Clock uncertainty / RTT</dt>
                <dd>
                  {pretty(snapshot?.uncertaintyMs)} / {pretty(snapshot?.rttMs)}{" "}
                  ms
                </dd>
                <dt>Last ACK</dt>
                <dd>{pretty(snapshot?.ackMs)} ms</dd>
              </dl>
              <p className="lab-small">
                Replay timer delivery is not a measurement of real sensor or
                Bluetooth performance. Traces below are synthetic diagnostic
                inputs, never cast buttons.
              </p>
              <div className="lab-actions">
                {(["rest", "jab", "guard", "sweep"] as ReplayName[]).map(
                  (name) => (
                    <button
                      className="secondary"
                      key={name}
                      disabled={!streaming || !virtual}
                      onClick={() => virtual?.play(name)}
                    >
                      {name} trace
                    </button>
                  ),
                )}
              </div>
            </section>
            <section
              className="lab-panel"
              id="feedback"
              aria-labelledby="feedback-title"
            >
              <div className="lab-section">
                <span>
                  <b className="step-number">3</b> FEEDBACK LOOP
                </span>
                <span className="quiet-tag">DECODED CONTROL</span>
              </div>
              <h2 id="feedback-title">A little light magic.</h2>
              <p className="panel-description">
                Send a practice cue. This preview only shows what the device
                decodes.
              </p>
              <div className="preview-stage">
                <div className="wand-preview" data-testid="feedback">
                  <div className="wand-preview-label">
                    WAND DUEL{" "}
                    <span>
                      {source === "replay"
                        ? "VIRTUAL DEVICE"
                        : "PREVIEW UNAVAILABLE"}
                    </span>
                  </div>
                  <div className="wand-screen">
                    {preview.state
                      ? PresentationPhase[preview.state.phase].toUpperCase()
                      : "NEUTRAL / LINK STALE"}
                    <small>
                      {preview.cue
                        ? `${CueEffect[preview.cue.effect]} · ${SpellCode[preview.cue.spell]}`
                        : "No active cue"}
                    </small>
                  </div>
                  <div className={`wand-leds ${preview.cue ? "on" : ""}`}>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <i key={i} />
                    ))}
                  </div>
                </div>
              </div>
              <p className="lab-small">
                {source === "replay"
                  ? "Virtual display only. ACKs do not prove physical LEDs."
                  : "Real output must be inspected on the badge."}{" "}
                Cue executions:{" "}
                <span data-testid="cue-count">{preview.cueRevision}</span>
                {preview.state && (
                  <>
                    {" "}
                    · epoch{" "}
                    <span data-testid="presentation-epoch">
                      {preview.state.presentationEpoch}
                    </span>
                  </>
                )}
              </p>
              <div className="lab-actions">
                <button disabled={!streaming} onClick={feedback}>
                  Refresh practice state
                </button>
                <button
                  className="secondary"
                  disabled={!streaming || !refresh}
                  onClick={() =>
                    session.current?.client.cue({
                      effect: CueEffect.AcceptedCast,
                      spell: SpellCode.Stupefy,
                      durationMs: 300,
                      presentationEpoch: session.current.presentationEpoch,
                    })
                  }
                >
                  Test cue (not a cast)
                </button>
                <button
                  className="secondary"
                  disabled={!streaming || !refresh}
                  onClick={() => {
                    session.current?.client.stopFeedback();
                    setRefresh(false);
                  }}
                >
                  Stop refresh
                </button>
              </div>
              <p className="lab-small">
                Sensor{" "}
                {health & HealthFlag.SensorHealthy
                  ? "healthy"
                  : "unknown/fault"}{" "}
                · presentation{" "}
                {health & HealthFlag.PresentationHealthy
                  ? "healthy"
                  : "unknown/fault"}{" "}
                · lease{" "}
                {health === 0
                  ? "not checked"
                  : health & HealthFlag.HostStateStale
                    ? "stale"
                    : "current"}
              </p>
              {snapshot?.feedbackWarning && (
                <p role="alert" className="lab-warning">
                  {snapshot.feedbackWarning}
                </p>
              )}
            </section>
            <section
              className="lab-panel recovery"
              id="recovery"
              aria-labelledby="recovery-title"
            >
              <div className="lab-section">
                <span>
                  <b className="step-number">4</b> RECOVERY TRIALS
                </span>
                <span className="quiet-tag">REPLAY ONLY</span>
              </div>
              <h2 id="recovery-title">Even magic has hiccups.</h2>
              <p>
                Duplicates must not count twice. A stale clock or 600 ms outage
                must invalidate input. Reconnect establishes a new session.
              </p>
              <div className="lab-actions vertical">
                <button
                  className="secondary"
                  disabled={!streaming || !virtual}
                  onClick={() => virtual?.injectDuplicate()}
                >
                  Duplicate next sample
                </button>
                <button
                  className="secondary"
                  disabled={!streaming || !virtual}
                  onClick={() => virtual?.injectOutage()}
                >
                  Inject 600 ms outage
                </button>
                <button
                  className="secondary"
                  disabled={!streaming || !virtual}
                  onClick={() => virtual?.injectStale()}
                >
                  Inject backward / stale capture
                </button>
                <button
                  className="secondary"
                  disabled={!streaming || !virtual}
                  onClick={() => virtual?.injectLostAck()}
                >
                  Drop next command ACK
                </button>
              </div>
              <p className="lab-small">
                Switching away from this page ends the input session. Nothing
                resumes automatically. No trace is saved or uploaded.
              </p>
            </section>
          </div>
          <footer>
            <span aria-hidden="true">✦</span> A strong foundation makes the
            magic possible.
            <p>
              Next: local speech, then motion + voice. iPhone and badge
              qualification remain open.
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
