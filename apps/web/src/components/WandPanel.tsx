import { useCallback, useEffect, useRef, useState } from "react";
import {
  addExample,
  classify,
  emptyCalibration,
  GESTURES,
  loadCalibration,
  saveCalibration,
  Segmenter,
  type Calibration,
  type GestureKind,
  type Segment,
  type Verdict,
} from "../lib/motion";
import { healthText, WandLink, type LinkState, type MotionEvent, type WandTransport } from "../lib/wandBle";
import { deviceIdHex, EFFECT, PHASE, SPELL, STATUS_BIT } from "../lib/wandProtocol";
import { VirtualWand, type SimGesture } from "../lib/wandSim";

/** A classified movement, in browser time, ready for voice fusion. */
export type MotionEvidence = {
  id: number;
  wandId: string;
  kind: GestureKind;
  confidence: number;
  startedAt: number; // performance.now() estimate of movement onset
  endedAt: number;   // performance.now() when the movement settled
};

type LogRow = { id: number; seg: Segment; verdict: Verdict | null; recordedAs: GestureKind | null };

const GESTURE_LABEL: Record<GestureKind, string> = { jab: "jab = Stupefy", guard: "raise + hold = Protego", sweep: "sweep = Expelliarmus" };

export function WandPanel({ onEvidence }: { onEvidence?: (e: MotionEvidence) => void }) {
  const transportRef = useRef<WandTransport | null>(null);
  const simRef = useRef<VirtualWand | null>(null);
  const segmenterRef = useRef(new Segmenter());
  const calRef = useRef<Calibration>(emptyCalibration());
  const recordRef = useRef<GestureKind | null>(null);
  const wandIdRef = useRef("");
  const evidenceId = useRef(0);

  const [link, setLink] = useState<LinkState>({ supported: WandLink.supported(), connected: false, opened: false, nonce: 0, epoch: 0, generation: 0, motionCount: 0, motionLost: 0, motionRateHz: 0 });
  const [live, setLive] = useState<{ x: number; y: number; z: number; age: number | null } | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [cal, setCal] = useState<Calibration>(emptyCalibration());
  const [recording, setRecording] = useState<GestureKind | null>(null);
  const [virtual, setVirtual] = useState(false);
  const [open, setOpen] = useState(true);
  const [hp, setHp] = useState(100);

  const handleMotion = useCallback(
    (e: MotionEvent) => {
      const m = e.motion;
      if (e.lost > 0 && e.lost * 20 > 150) segmenterRef.current.reset(); // a gap breaks any movement in flight
      if (!(m.flags & 1) || m.flags & 2) return; // invalid or clipped samples never become gestures
      const seg = segmenterRef.current.push({ x: m.ax, y: m.ay, z: m.az, ms: m.captureMs });
      setLive({ x: m.ax, y: m.ay, z: m.az, age: e.ageMs });
      if (!seg) return;
      const id = ++evidenceId.current;
      let verdict: Verdict | null = null;
      let recordedAs: GestureKind | null = null;
      if (!seg.rejected && recordRef.current) {
        recordedAs = recordRef.current;
        const next = addExample(calRef.current, recordedAs, seg);
        calRef.current = next;
        setCal(next);
        saveCalibration(wandIdRef.current, next);
        recordRef.current = null;
        setRecording(null);
      } else {
        verdict = classify(seg, calRef.current);
        if (verdict.kind && onEvidence) {
          const offset = e.captureAt === null ? e.receivedAt - m.captureMs : e.captureAt - m.captureMs;
          onEvidence({ id, wandId: wandIdRef.current, kind: verdict.kind, confidence: verdict.confidence, startedAt: seg.startMs + offset, endedAt: seg.endMs + offset });
        }
      }
      setLog((rows) => [{ id, seg, verdict, recordedAs }, ...rows].slice(0, 8));
    },
    [onEvidence],
  );

  const handleState = useCallback((s: LinkState) => {
    setLink(s);
    const id = s.info ? deviceIdHex(s.info.deviceId) : "";
    if (id !== wandIdRef.current) {
      wandIdRef.current = id;
      segmenterRef.current = new Segmenter();
      const next = id ? loadCalibration(id) : emptyCalibration();
      calRef.current = next;
      setCal(next);
      setLog([]);
    }
  }, []);

  useEffect(() => {
    return () => {
      void transportRef.current?.disconnect();
    };
  }, []);

  const start = async (t: WandTransport) => {
    await transportRef.current?.disconnect();
    transportRef.current = t;
    await t.connect();
    if (!t.state().connected) return;
    if (await t.open()) await t.sync(5);
  };

  const connectReal = () => void start(new WandLink({ onMotion: handleMotion, onState: handleState }));
  const toggleVirtual = () => {
    if (virtual) {
      void transportRef.current?.disconnect();
      transportRef.current = null;
      simRef.current = null;
      setVirtual(false);
      return;
    }
    const sim = new VirtualWand({ onMotion: handleMotion, onState: handleState });
    simRef.current = sim;
    setVirtual(true);
    void start(sim);
  };
  const disconnect = () => {
    void transportRef.current?.disconnect();
    transportRef.current = null;
    simRef.current = null;
    setVirtual(false);
  };

  const record = (kind: GestureKind) => {
    recordRef.current = kind;
    setRecording(kind);
  };
  const clearCalibration = () => {
    const next = emptyCalibration();
    calRef.current = next;
    setCal(next);
    if (wandIdRef.current) saveCalibration(wandIdRef.current, next);
  };

  const feedback = async (what: string) => {
    const t = transportRef.current;
    if (!t) return;
    switch (what) {
      case "practice":
        await t.setState(PHASE.PRACTICE, 100);
        break;
      case "playing":
        await t.setState(PHASE.PLAYING, hp);
        break;
      case "shield":
        await t.setState(PHASE.PLAYING, hp, STATUS_BIT.SHIELD);
        break;
      case "stupefy":
        await t.cue(EFFECT.ACCEPTED_CAST, SPELL.STUPEFY, 400);
        break;
      case "protego":
        await t.cue(EFFECT.ACCEPTED_CAST, SPELL.PROTEGO, 600);
        break;
      case "blocked":
        await t.cue(EFFECT.BLOCKED, SPELL.STUPEFY, 500);
        break;
      case "damage":
        setHp((h) => Math.max(0, h - 20));
        await t.setState(PHASE.PLAYING, Math.max(0, hp - 20));
        await t.cue(EFFECT.DAMAGE, SPELL.STUPEFY, 400);
        break;
      case "won":
        await t.setState(PHASE.WON, hp);
        await t.cue(EFFECT.RESULT, SPELL.NONE, 1000);
        break;
      case "lost":
        await t.setState(PHASE.LOST, 0);
        await t.cue(EFFECT.RESULT, SPELL.NONE, 1000);
        break;
      case "reset":
        t.newEpoch();
        setHp(100);
        await t.setState(PHASE.IDLE, 100);
        break;
    }
  };

  const bar = (v: number, color: string) => {
    const pct = Math.max(0, Math.min(100, ((v + 2000) / 4000) * 100));
    return (
      <div style={{ position: "relative", height: 10, background: "#1c2030", borderRadius: 4, margin: "2px 0" }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#555" }} />
        <div style={{ position: "absolute", left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%`, top: 0, bottom: 0, background: color, borderRadius: 4 }} />
      </div>
    );
  };

  const tone = link.opened ? "ok" : link.connected ? "warn" : "bad";
  const wandLabel = link.info ? `${link.name ?? "wand"} fw ${link.info.fw.join(".")} boot ${link.info.bootId.toString(16)}` : link.supported ? "not connected" : "needs Chrome/Edge";
  const health = link.health ? healthText(link.health.detail1) : "";

  return (
    <div className="wand-panel" style={{ background: "#0f1320", color: "#e6e6f0", padding: "8px 12px", fontSize: 13, borderBottom: "1px solid #232840" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} Wand
        </strong>
        <span className="pill">
          <span className={`dot ${tone}`} />
          {wandLabel}
          {link.connected ? (link.opened ? "  session open" : "  opening...") : ""}
        </span>
        {link.connected && (
          <span className="pill">
            {link.motionRateHz.toFixed(0)} Hz · lost {link.motionLost} · sync {link.offsetMs === undefined ? "none" : `±${link.uncertaintyMs?.toFixed(0)} ms (rtt ${link.syncRttMs?.toFixed(0)})`}
          </span>
        )}
        {health && <span className="pill">{health}</span>}
        {link.lastResultText && <span className="pill" style={{ opacity: 0.7 }}>{link.lastResultText}</span>}
        {link.error && <span className="pill" style={{ color: "#ff8080" }}>{link.error}</span>}
        <span className="spacer" />
        {link.connected ? (
          <button onClick={disconnect}>Disconnect</button>
        ) : (
          <button disabled={!link.supported} onClick={connectReal}>
            Connect wand (Bluetooth)
          </button>
        )}
        <button onClick={toggleVirtual} style={{ outline: virtual ? "2px solid #ffb020" : undefined }} title="Development only. Never a stand-in for a real wand in a duel.">
          {virtual ? "VIRTUAL WAND ON (dev)" : "Virtual wand (dev)"}
        </button>
        {virtual &&
          (["jab", "guard", "sweep"] as SimGesture[]).map((g) => (
            <button key={g} onClick={() => simRef.current?.perform(g)}>
              sim {g}
            </button>
          ))}
      </div>

      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr", gap: 16, marginTop: 8 }}>
          <div>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Live acceleration (contract axes, mg)</div>
            {live ? (
              <>
                <div style={{ opacity: 0.7 }}>
                  x {live.x} y {live.y} z {live.z} · age {live.age === null ? "?" : `${live.age.toFixed(0)} ms`} · {segmenterRef.current.phaseName}
                </div>
                {bar(live.x, "#ff6a6a")}
                {bar(live.y, "#6aff9a")}
                {bar(live.z, "#6ab0ff")}
              </>
            ) : (
              <div style={{ opacity: 0.5 }}>no samples yet (face up on a table should read 0, 0, +1000)</div>
            )}
            <div style={{ opacity: 0.7, margin: "10px 0 4px" }}>Badge feedback test (sends SET_STATE / CUE)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {["practice", "playing", "shield", "stupefy", "protego", "blocked", "damage", "won", "lost", "reset"].map((w) => (
                <button key={w} disabled={!link.opened} onClick={() => void feedback(w)}>
                  {w}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Calibration for {wandIdRef.current || "no wand"}</div>
            {GESTURES.map((g) => (
              <div key={g} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
                <span style={{ width: 170 }}>{GESTURE_LABEL[g]}</span>
                <span style={{ width: 70, opacity: 0.7 }}>{cal[g]?.examples ?? 0} examples</span>
                <button disabled={!link.opened} onClick={() => record(g)} style={{ outline: recording === g ? "2px solid #8fd3ff" : undefined }}>
                  {recording === g ? "move now..." : "record next"}
                </button>
              </div>
            ))}
            <button onClick={clearCalibration} disabled={!link.opened} style={{ marginTop: 6 }}>
              clear calibration
            </button>
            <div style={{ opacity: 0.6, marginTop: 6 }}>Record 3 to 5 gentle examples of each, holding the badge the way you will on stage. Stored in this browser per wand.</div>
          </div>

          <div>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>Movements</div>
            {log.length === 0 && <div style={{ opacity: 0.5 }}>none detected yet</div>}
            {log.map((r) => (
              <div key={r.id} style={{ padding: "2px 0", borderBottom: "1px solid #1c2030" }}>
                <span style={{ color: r.recordedAs ? "#8fd3ff" : r.verdict?.kind ? "#8fff9a" : "#ffb080" }}>
                  {r.recordedAs ? `recorded ${r.recordedAs}` : r.verdict?.kind ? `${r.verdict.kind} ${(r.verdict.confidence * 100).toFixed(0)}%` : `rejected: ${r.verdict?.reason ?? r.seg.rejected}`}
                </span>
                <span style={{ opacity: 0.6 }}>
                  {" "}
                  · {r.seg.durationMs} ms · peak {r.seg.peakMg.toFixed(0)} mg · tilt {r.seg.tiltDeg.toFixed(0)}° {r.seg.held ? "· held" : ""} · rev {r.seg.reversals}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
