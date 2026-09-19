import { useEffect, useRef, useState } from "react";
import { GameQaHarness, type GameQaReport } from "./harness";

const initial: GameQaReport = { stage: "idle", detail: "Ready to run" };

export function GameQa() {
  const [report, setReport] = useState(initial);
  const harness = useRef<GameQaHarness>();

  useEffect(
    () => () => {
      harness.current?.destroy();
      harness.current = undefined;
    },
    [],
  );

  async function run(): Promise<void> {
    harness.current?.destroy();
    const next = new GameQaHarness(setReport);
    harness.current = next;
    try {
      await next.run();
    } catch {
      // The harness publishes the bounded failure reason for Playwright.
    }
  }

  return (
    <main>
      <h1>Scripted duel QA</h1>
      <p>QA only: raw replay motion plus explicitly scripted speech.</p>
      <button disabled={report.stage === "running"} onClick={() => void run()}>
        Run scripted duel QA
      </button>
      <output data-testid="qa-stage">{report.stage}</output>
      <p data-testid="qa-detail">{report.detail}</p>
      <dl aria-label="QA outcomes">
        <dt>Attack accepted</dt>
        <dd data-testid="qa-attack">{String(report.attackAccepted ?? false)}</dd>
        <dt>Defense accepted</dt>
        <dd data-testid="qa-defense">{String(report.defenseAccepted ?? false)}</dd>
        <dt>Impact blocked</dt>
        <dd data-testid="qa-blocked">{String(report.blocked ?? false)}</dd>
        <dt>Defender health</dt>
        <dd data-testid="qa-health">{report.defenderHp ?? "—"}</dd>
        <dt>Abort result</dt>
        <dd data-testid="qa-abort">{report.abortOutcome ?? "—"}</dd>
        <dt>Rematch round</dt>
        <dd data-testid="qa-rematch">{report.rematchRound ?? "—"}</dd>
      </dl>
    </main>
  );
}
