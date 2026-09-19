import type { ArenaState, PlayerId } from "../types";
import { MODIFIER_NAMES, PLAYER_COLORS, SPELL_NAMES } from "../types";

type Props = {
  state: ArenaState | null;
  serverNowMs: number;
};

/**
 * Text readout of both players.
 *
 * Deliberately redundant with the canvas plates: if a marker is lost, a frame
 * fails to decode, or the projector is far away, this strip still reads clearly.
 */
export function Hud({ state, serverNowMs }: Props) {
  if (!state) {
    return (
      <div className="hud">
        <div className="side" />
        <div className="middle">waiting for the host</div>
        <div className="side right" />
      </div>
    );
  }

  return (
    <div className="hud">
      <PlayerSide state={state} playerId="P1" serverNowMs={serverNowMs} />
      <div className="middle">
        <div>{state.phase}</div>
        {state.modifier !== "none" ? (
          <div style={{ color: "var(--warn)" }}>{MODIFIER_NAMES[state.modifier]}</div>
        ) : null}
      </div>
      <PlayerSide state={state} playerId="P2" serverNowMs={serverNowMs} align="right" />
    </div>
  );
}

function PlayerSide({
  state,
  playerId,
  serverNowMs,
  align,
}: {
  state: ArenaState;
  playerId: PlayerId;
  serverNowMs: number;
  align?: "right";
}) {
  const player = state.players[playerId];
  if (!player) {
    return <div className={align ? "side right" : "side"} />;
  }

  const shielded = player.shieldUntilMs > serverNowMs;
  const lastSpell = player.lastSpell
    ? (SPELL_NAMES[player.lastSpell] ?? player.lastSpell)
    : "-";

  return (
    <div className={align ? "side right" : "side"}>
      <div className="name" style={{ color: PLAYER_COLORS[playerId] }}>
        {playerId}
        {player.ready && state.phase === "lobby" ? " ready" : ""}
      </div>
      <div className="bar">
        <span
          style={{
            width: `${player.health}%`,
            background: PLAYER_COLORS[playerId],
          }}
        />
      </div>
      <div className="bar mana">
        <span style={{ width: `${player.mana}%` }} />
      </div>
      <div className="numbers">
        {player.health} hp - {player.mana} mana - {lastSpell}
        {shielded ? <span className="shield"> - shielded</span> : null}
      </div>
    </div>
  );
}
