export type Slot = "P1" | "P2";
export const SPELLS = ["stupefy", "protego", "expelliarmus", "incendio", "episkey"] as const;
export type Spell = (typeof SPELLS)[number];
export type Source = "phone" | "ble" | "replay";
export type SpellRule = {
  spell: Spell;
  enabled: boolean;
  damage: number;
  heal: number;
  cooldownMs: number;
  flightMs: number;
  shieldMs: number;
  offenseLockMs: number;
};
export type Rules = {
  version: number;
  roundMs: number;
  maxHp: number;
  spells: SpellRule[];
};
export type Player = {
  slot: Slot;
  name: string;
  source: Source;
  connected: boolean;
  ready: boolean;
  inputHealthy: boolean;
  inputGeneration: number | null;
  deviceId: string | null;
  bootId: number | null;
  hp: number;
  maxHp: number;
  shieldUntilMs: number;
  offenseLockedUntilMs: number;
  cooldownUntilMs: Record<Spell, number>;
};
export type Projectile = {
  id: string;
  actionId: string;
  spell: "stupefy" | "expelliarmus" | "incendio";
  caster: Slot;
  target: Slot;
  launchAtMs: number;
  impactAtMs: number;
  damage: number;
  offenseLockMs: number;
};
export type GameEvent = {
  id: string;
  type: string;
  atMs: number;
  roundId: number;
  stateVersion: number;
  actor?: Slot | null;
  target?: Slot | null;
  spell?: Spell | null;
  actionId?: string | null;
  projectileId?: string | null;
  effectId?: string | null;
  amount?: number | null;
  reason?: string | null;
};
export type Snapshot = {
  roomId: string;
  roomGeneration: number;
  roundId: number;
  stateVersion: number;
  serverNowMs: number;
  phase: "lobby" | "countdown" | "playing" | "result";
  countdownEndsAtMs: number | null;
  roundEndsAtMs: number | null;
  result: null | {
    outcome: "win" | "draw" | "aborted";
    winner: Slot | null;
    reason: string;
    endedAtMs: number;
  };
  players: Record<Slot, Player | null>;
  projectiles: Projectile[];
  recentEvents: GameEvent[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const slot = (v: unknown): v is Slot => v === "P1" || v === "P2";
const spell = (v: unknown): v is Spell =>
  SPELLS.some((name) => v === name);
const deadline = (v: unknown) => v === null || finite(v);
export function parseRules(value: unknown): Rules {
  if (
    !object(value) ||
    value.version !== 1 ||
    !finite(value.roundMs) ||
    !finite(value.maxHp) ||
    !Array.isArray(value.spells) ||
    value.spells.length !== SPELLS.length ||
    new Set(value.spells.map((r) => object(r) ? r.spell : null)).size !== SPELLS.length ||
    !value.spells.every(
      (r) =>
        object(r) &&
        spell(r.spell) &&
        typeof r.enabled === "boolean" &&
        ["damage", "heal", "cooldownMs", "flightMs", "shieldMs", "offenseLockMs"].every(
          (k) => finite(r[k]) && (r[k] as number) >= 0,
        ),
    )
  )
    throw new Error("Unsupported game rules");
  return value as Rules;
}
/** ICE servers the referee hands both players; absent on an older referee means host candidates only. */
export function parseIceServers(value: unknown): RTCIceServer[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Invalid ICE servers");
  return value.map((server) => {
    if (!object(server)) throw new Error("Invalid ICE servers");
    const urls = Array.isArray(server.urls)
      ? server.urls
      : typeof server.urls === "string"
        ? [server.urls]
        : [];
    if (
      !urls.length ||
      urls.length > 8 ||
      !urls.every(
        (url) =>
          typeof url === "string" &&
          url.length <= 256 &&
          /^(stun|stuns|turn|turns):/.test(url),
      )
    )
      throw new Error("Invalid ICE servers");
    const parsed: RTCIceServer = { urls: urls as string[] };
    if (typeof server.username === "string") parsed.username = server.username;
    if (typeof server.credential === "string")
      parsed.credential = server.credential;
    return parsed;
  });
}
export function parseSnapshot(value: unknown): Snapshot {
  if (
    !object(value) ||
    typeof value.roomId !== "string" ||
    !["roomGeneration", "roundId", "stateVersion", "serverNowMs"].every((k) =>
      finite(value[k]),
    ) ||
    !["lobby", "countdown", "playing", "result"].includes(
      String(value.phase),
    ) ||
    !deadline(value.countdownEndsAtMs) ||
    !deadline(value.roundEndsAtMs) ||
    !object(value.players)
  )
    throw new Error("Invalid game state");
  for (const key of ["P1", "P2"]) {
    const p = value.players[key];
    if (p === null) continue;
    if (
      !object(p) ||
      p.slot !== key ||
      typeof p.name !== "string" ||
      !["phone", "ble", "replay"].includes(String(p.source)) ||
      !["connected", "ready", "inputHealthy"].every(
        (k) => typeof p[k] === "boolean",
      ) ||
      !["inputGeneration", "bootId"].every((k) => deadline(p[k])) ||
      !(p.deviceId === null || typeof p.deviceId === "string") ||
      ![
        "hp",
        "maxHp",
        "shieldUntilMs",
        "offenseLockedUntilMs",
      ].every((k) => finite(p[k])) ||
      !object(p.cooldownUntilMs) ||
      !SPELLS.every((name) => object(p.cooldownUntilMs) && finite(p.cooldownUntilMs[name]))
    )
      throw new Error("Invalid player state");
  }
  if (
    !Array.isArray(value.projectiles) ||
    value.projectiles.length > 16 ||
    !value.projectiles.every(
      (p) =>
        object(p) &&
        typeof p.id === "string" &&
        typeof p.actionId === "string" &&
        ["stupefy", "expelliarmus", "incendio"].includes(String(p.spell)) &&
        slot(p.caster) &&
        slot(p.target) &&
        ["launchAtMs", "impactAtMs", "damage", "offenseLockMs"].every((k) =>
          finite(p[k]),
        ),
    )
  )
    throw new Error("Invalid projectile state");
  if (
    !Array.isArray(value.recentEvents) ||
    value.recentEvents.length > 256 ||
    !value.recentEvents.every(
      (e) =>
        object(e) &&
        typeof e.id === "string" &&
        typeof e.type === "string" &&
        finite(e.atMs) &&
        finite(e.roundId) &&
        finite(e.stateVersion) &&
        (e.actor == null || slot(e.actor)) &&
        (e.target == null || slot(e.target)) &&
        (e.spell == null || spell(e.spell)),
    )
  )
    throw new Error("Invalid game event");
  if (
    value.result !== null &&
    (!object(value.result) ||
      !["win", "draw", "aborted"].includes(String(value.result.outcome)) ||
      !(value.result.winner === null || slot(value.result.winner)) ||
      typeof value.result.reason !== "string" ||
      !finite(value.result.endedAtMs))
  )
    throw new Error("Invalid result");
  return value as Snapshot;
}
