import { useEffect, useRef, useState } from "react";
import type { InfoRecord } from "../wand/protocol";
import { PhoneAccessory, type AccessoryState } from "./accessory";
import { socketUrl } from "./relay";

export function HostedPhoneWand({ roomId, infoFactory }: { roomId: string; infoFactory: () => InfoRecord }) {
  const [info] = useState(infoFactory);
  const [state, setState] = useState<AccessoryState>();
  const [message, setMessage] = useState("Connect your wand");
  const [busy, setBusy] = useState(false);
  const [awakeHint, setAwakeHint] = useState(false);
  const accessory = useRef<PhoneAccessory>();
  const wake = useRef<WakeLockSentinel>();
  const attempt = useRef(0);
  const valid = /^[0-9a-f]{32}$/.test(roomId);
  const releaseWake = () => { const lock = wake.current; wake.current = undefined; if (lock) void lock.release().catch(() => undefined); };
  useEffect(() => {
    const motion = (event: DeviceMotionEvent) => { const a = event.accelerationIncludingGravity; if (a) accessory.current?.observe(a.x, a.y, a.z); };
    const pause = () => { attempt.current++; setBusy(false); accessory.current?.pause(); releaseWake(); };
    const hide = () => { if (document.hidden) pause(); };
    window.addEventListener("devicemotion", motion);
    window.addEventListener("pagehide", pause);
    document.addEventListener("visibilitychange", hide);
    return () => { attempt.current++; window.removeEventListener("devicemotion", motion); window.removeEventListener("pagehide", pause); document.removeEventListener("visibilitychange", hide); accessory.current?.close(); accessory.current = undefined; releaseWake(); };
  }, []);
  async function stayAwake(current: number) {
    if (!navigator.wakeLock) { setAwakeHint(true); return; }
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (attempt.current !== current) { void lock.release().catch(() => undefined); return; }
      wake.current = lock; setAwakeHint(false);
      lock.addEventListener("release", () => { if (wake.current === lock) { wake.current = undefined; setAwakeHint(true); } }, { once: true });
    } catch { if (attempt.current === current) setAwakeHint(true); }
  }
  async function connect() {
    if (busy || !valid) return;
    const current = ++attempt.current; setBusy(true); setMessage("Requesting motion access…");
    try {
      if (!window.isSecureContext || typeof DeviceMotionEvent === "undefined") throw new Error("Open this link in Safari with HTTPS.");
      const motion = DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> };
      if (motion.requestPermission && await motion.requestPermission() !== "granted") throw new Error("Allow motion to use your wand.");
      if (current !== attempt.current) return;
      accessory.current?.close();
      const next = new PhoneAccessory(info, socketUrl(`/ws/${roomId}`));
      accessory.current = next; next.subscribe(setState); next.start();
      setMessage("Move your iPhone gently…"); void stayAwake(current);
    } catch (error) { if (current === attempt.current) setMessage(error instanceof Error ? error.message : "Unable to connect."); }
    finally { if (current === attempt.current) setBusy(false); }
  }
  function resume() {
    if (document.hidden) return;
    accessory.current?.resume(); void stayAwake(++attempt.current);
  }
  function disconnect() { attempt.current++; accessory.current?.close(); accessory.current = undefined; releaseWake(); setState(undefined); setMessage("Connect your wand"); }
  function downloadTrace() {
    if (!accessory.current) return;
    const url = URL.createObjectURL(new Blob([accessory.current.exportTrace()], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "wandduel-phone-trace.json"; anchor.click(); URL.revokeObjectURL(url);
  }
  const heading = !valid ? "Scan the code again." : state?.paused ? "Your wand is paused" : state?.challenge ? "Confirm on your laptop" : state?.link.phase === "choice" ? "Choose on your laptop" : state?.link.issue ? state.link.issue.message : state?.coaching?.instruction || (state?.reachingLaptop ? "Your wand is listening" : state?.sensorActive ? "Finding your laptop…" : message);
  return <main className="phone-page phone-live">
    <span className="wordmark">wandduel<span>✦</span></span>
    <div className={`wand-orb cue-${state?.cue ?? 0}`} style={{ transform: `scale(${1 + (state?.movement ?? 0) * 0.08})` }} aria-hidden="true">✧</div>
    <h1>{heading}</h1>
    {state ? <>
      <div className="phone-signals" aria-label="Wand sensing">
        <span className={state.sensorActive ? "live" : ""}><i aria-hidden="true" />{state.sensorActive ? "Sensor active" : "Waiting for motion"}</span>
        <span className={state.reachingLaptop ? "live" : ""}><i aria-hidden="true" />{state.reachingLaptop ? "Reaching laptop" : "Waiting for laptop"}</span>
      </div>
      {state.challenge ? <><output className="pair-code" aria-label="Confirmation code">{state.challenge}</output><p>Confirm this code on your laptop.</p></> : null}
      {state.coaching?.total ? <div className="phone-progress" role="status" aria-label={`${state.coaching.completed} of ${state.coaching.total} gestures`}>
        {Array.from({ length: state.coaching.total }, (_, i) => <span key={i} className={i < state.coaching!.completed ? "done" : ""} aria-hidden="true">{i < state.coaching!.completed ? "✓" : "·"}</span>)}
      </div> : null}
      {state.coaching?.hint ? <p role="status">{state.coaching.hint}</p> : null}
      {state.hp !== undefined ? <output className="phone-health">{state.hp} ♥</output> : null}
      {state.paused ? <button onClick={resume}>Resume</button> : null}
      {awakeHint ? <p className="phone-note">Keep this screen awake during your duel.</p> : null}
      <details className="phone-details"><summary>Connection details</summary>
        <dl><dt>Connection</dt><dd>{state.link.route === "direct" ? "Direct Wi-Fi" : "Internet"}</dd><dt>Observed</dt><dd>{state.observedHz} readings/s</dd><dt>Received</dt><dd>{Math.round(state.receivedHz)} readings/s</dd><dt>Reading age</dt><dd>{state.ageMs === undefined ? "Waiting" : `${Math.round(state.ageMs)} ms`}</dd><dt>Last issue</dt><dd>{state.lastIssue ?? "None"}</dd></dl>
        <button className="quiet" onClick={downloadTrace}>Save last minute for support</button>
      </details>
      <button className="quiet" onClick={disconnect}>Disconnect</button>
    </> : <><button disabled={busy || !valid} onClick={() => void connect()}>Connect wand</button>{!valid ? <p>Scan a fresh code from your laptop.</p> : null}</>}
  </main>;
}
