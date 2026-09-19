import { ArenaStage } from "./components/ArenaStage";
import { EventBanner } from "./components/EventBanner";
import { Hud } from "./components/Hud";
import { WandPanel } from "./components/WandPanel";
import { useArenaSocket } from "./hooks/useArenaSocket";
import type { ArenaState, ConnectionState } from "./types";
import { PLAYER_COLORS } from "./types";

export function App() {
  const { envelope, connection, effectsRef } = useArenaSocket();
  const state = envelope?.state ?? null;
  const serverNowMs = envelope?.serverNowMs ?? 0;

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">Phantom Arena</span>
        <ConnectionPill connection={connection} />
        <GatewayPill connected={envelope?.gatewayConnected ?? false} />
        <CameraPill hasFrame={Boolean(envelope?.frameJpegBase64)} />
        <span className="spacer" />
        <span className="pill">{state?.phase ?? "offline"}</span>
      </div>

      <WandPanel onEvidence={(e) => console.info("motion evidence", e)} />

      <div className="stage">
        <ArenaStage envelope={envelope} effectsRef={effectsRef} />
        <EventBanner
          modifier={state?.modifier ?? "none"}
          commentary={envelope?.directorCommentary}
        />
        <PhaseOverlay state={state} serverNowMs={serverNowMs} connection={connection} />
      </div>

      <Hud state={state} serverNowMs={serverNowMs} />
    </div>
  );
}

function ConnectionPill({ connection }: { connection: ConnectionState }) {
  const tone =
    connection === "open" ? "ok" : connection === "connecting" ? "warn" : "bad";
  return (
    <span className="pill">
      <span className={`dot ${tone}`} />
      host {connection}
    </span>
  );
}

function GatewayPill({ connected }: { connected: boolean }) {
  return (
    <span className="pill">
      <span className={`dot ${connected ? "ok" : "bad"}`} />
      gateway {connected ? "up" : "down"}
    </span>
  );
}

function CameraPill({ hasFrame }: { hasFrame: boolean }) {
  return (
    <span className="pill">
      <span className={`dot ${hasFrame ? "ok" : "warn"}`} />
      camera {hasFrame ? "live" : "off"}
    </span>
  );
}

function PhaseOverlay({
  state,
  serverNowMs,
  connection,
}: {
  state: ArenaState | null;
  serverNowMs: number;
  connection: ConnectionState;
}) {
  if (!state) {
    return (
      <div className="overlay">
        <div className="panel">
          <h2>Waiting for the host</h2>
          <p>
            {connection === "open"
              ? "connected, no state yet"
              : "start the host, then reload is not needed - this reconnects"}
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === "lobby") {
    return (
      <div className="overlay">
        <div className="panel">
          <h2>Ready up</h2>
          <p>Press DOWN on each player badge</p>
          <div className="ready-row">
            {(["P1", "P2"] as const).map((playerId) => {
              const ready = state.players[playerId]?.ready ?? false;
              return (
                <div
                  key={playerId}
                  className={`ready-chip ${ready ? "on" : ""}`}
                  style={ready ? undefined : { color: PLAYER_COLORS[playerId] }}
                >
                  {playerId} {ready ? "ready" : "waiting"}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "countdown") {
    const remaining = Math.max(0, state.countdownEndsMs - serverNowMs);
    return (
      <div className="overlay">
        <div className="panel">
          <div className="countdown">{Math.ceil(remaining / 1000)}</div>
        </div>
      </div>
    );
  }

  if (state.phase === "finished") {
    const winner = state.winner;
    return (
      <div className="overlay">
        <div className="panel">
          <p>winner</p>
          <div
            className="winner"
            style={{ color: winner ? PLAYER_COLORS[winner] : "var(--text)" }}
          >
            {winner ?? "draw"}
          </div>
          <p>judge badge UP resets the match</p>
        </div>
      </div>
    );
  }

  return null;
}
