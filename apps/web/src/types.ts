// Mirror of apps/host/phantom_host/contracts.py.
// The host serializes with camelCase aliases; a test in tests/test_contracts.py
// pins these exact field names. Change both files together.

export type PlayerId = "P1" | "P2";
export type Phase = "lobby" | "countdown" | "playing" | "finished";
export type Modifier = "none" | "meteor" | "mana_rain" | "double_damage";
export type Spell = "F" | "S" | "A" | "U";

export type EffectType =
  | "cast"
  | "damage"
  | "shield_absorb"
  | "modifier"
  | "reject"
  | "phase"
  | "win"
  | "ready";

export type Effect = {
  type: EffectType;
  player?: PlayerId | null;
  spell?: string | null;
  amount?: number | null;
  note?: string | null;
};

export type PlayerState = {
  id: PlayerId;
  health: number;
  mana: number;
  cooldownUntilMs: Record<string, number>;
  shieldUntilMs: number;
  ready: boolean;
  lastSpell?: string | null;
};

export type ArenaState = {
  phase: Phase;
  players: Record<string, PlayerState>;
  modifier: Modifier;
  modifierUntilMs: number;
  countdownEndsMs: number;
  startedAtMs: number;
  lastTickMs: number;
  winner?: PlayerId | null;
};

export type MarkerPose = {
  playerId: PlayerId;
  x: number;
  y: number;
  visible: boolean;
};

export type ArenaEnvelope = {
  type: "state";
  state: ArenaState;
  markers: Record<string, MarkerPose>;
  effects: Effect[];
  directorCommentary?: string | null;
  frameJpegBase64?: string | null;
  gatewayConnected: boolean;
  serverNowMs: number;
};

export type ConnectionState = "connecting" | "open" | "closed";

export const SPELL_NAMES: Record<string, string> = {
  F: "Fireball",
  S: "Shield",
  A: "Arc Slash",
  U: "Ultimate",
};

export const MODIFIER_NAMES: Record<Modifier, string> = {
  none: "",
  meteor: "Meteor",
  mana_rain: "Mana Rain",
  double_damage: "Double Damage",
};

export const PLAYER_COLORS: Record<PlayerId, string> = {
  P1: "#ff4d4d",
  P2: "#4d9dff",
};
