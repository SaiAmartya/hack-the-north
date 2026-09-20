import { useEffect, useRef, useState } from "react";
import type { DuelController } from "./controller";

interface LogSnapshot {
  entries: readonly { id: number; atMs: number; kind: string; data: unknown }[];
  total: number;
  dropped: number;
}

export function TelemetryPanel({ controller }: { controller: DuelController }) {
  const [paused, setPaused] = useState<LogSnapshot | null>(null);
  const [lastHeard, setLastHeard] = useState<string | null>(null);
  const snapshot = paused ?? controller.telemetry.snapshot(80);
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const latestId = snapshot.entries.at(-1)?.id;
  const speechResult = snapshot.entries.filter(entry => entry.kind === "speech.result").at(-1);
  useEffect(() => {
    const data = speechResult?.data;
    if (data && typeof data === "object" && "transcript" in data && typeof data.transcript === "string")
      setLastHeard(data.transcript);
  }, [speechResult]);
  useEffect(() => {
    if (!paused && follow.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [latestId, paused]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([controller.exportTelemetry()], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `wandduel-telemetry-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <section className="telemetry-panel" aria-label="Developer telemetry">
      <div className="telemetry-toolbar">
        <div className="telemetry-title"><span className={paused ? "log-paused" : "log-live"} aria-hidden="true" /> <h2>Wand log</h2><span>{paused ? "VIEW PAUSED" : "LIVE"}</span></div>
        <div className="telemetry-actions">
          <button className="quiet" aria-pressed={!!paused} onClick={() => setPaused(paused ? null : controller.telemetry.snapshot(80))}>{paused ? "Resume view" : "Pause view"}</button>
          <button className="quiet" onClick={() => { controller.telemetry.clear(); setLastHeard(null); if (paused) setPaused(controller.telemetry.snapshot(80)); }}>Clear</button>
          <button className="quiet" onClick={download}>Export JSON <span aria-hidden="true">↓</span></button>
        </div>
      </div>
      <p className="telemetry-heard"><span>Last heard</span><span aria-label="Latest raw transcription">{lastHeard === null ? "Waiting for speech…" : lastHeard || "(empty transcription)"}</span></p>
      <div
        ref={viewport}
        className="telemetry-entries"
        tabIndex={0}
        aria-label="Raw wand, speech and battle events"
        onScroll={(event) => {
          const view = event.currentTarget;
          follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
        }}
      >
        {snapshot.entries.length === 0 ? <p className="telemetry-empty">Move your wand or say a spell to capture an event.</p> : snapshot.entries.map((entry) => (
          <article className="telemetry-entry" key={entry.id}>
            <header><time>{(entry.atMs / 1000).toFixed(3)}s</time><strong>{entry.kind}</strong><span>#{entry.id}</span></header>
            <pre>{JSON.stringify(entry.data, null, 2)}</pre>
          </article>
        ))}
      </div>
      <p className="telemetry-caption">Showing {snapshot.entries.length} recent events · {snapshot.total} retained{snapshot.dropped ? ` · ${snapshot.dropped} older events discarded` : ""}{paused ? " · Recording continues" : ""}</p>
    </section>
  );
}
