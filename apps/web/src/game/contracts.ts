export type Slot = "P1" | "P2";
export const SPELLS = ["stupefy", "protego", "expelliarmus", "incendio", "episkey"] as const;
export type Spell = (typeof SPELLS)[number];
export const POWERUPS = ["phoenix", "bezoar", "felix", "mirror", "haste"] as const;
export type PowerupKind = (typeof POWERUPS)[number];
export type Source = "phone" | "ble" | "replay";
export type GameMode = "duel" | "solo" | "tutorial" | "story";
export type Story = { level: number; name: string; total: number };
export type Tutorial = {
  step: number;
  spell: Spell | null;
  stage: "instruction" | "practice" | "complete" | "free";
  paused: boolean;
};
export type SpellRule = {
  spell: Spell;
  enabled: boolean;
  damage: number;
  heal: number;
  cooldownMs: number;
  flightMs: number;
  shieldMs: number;
  offenseLockMs: number;
  stunMs: number;
  stunChancePercent: number;
  burnDamage: number;
  burnMs: number;
  breaksShield: boolean;
};
export type Rules = {
  version: number;
  roundMs: number;
  maxHp: number;
  critChancePercent: number;
  critMultiplierPercent: number;
  perfectBlockMs: number;
  powerupLifetimeMs: number;
  spells: SpellRule[];
};
export type Player = {
  slot: Slot;
  name: string;
  source: Source | "bot";
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
  stunnedUntilMs: number;
  burnUntilMs: number;
  hasteUntilMs: number;
  mirrorUntilMs: number;
  lucky: boolean;
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
  reflected: boolean;
};
export type Powerup = {
  id: string;
  kind: PowerupKind;
  spawnedAtMs: number;
  expiresAtMs: number;
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
  critical?: boolean;
  powerup?: PowerupKind | null;
};
export type Snapshot = {
  roomId: string;
  mode: GameMode;
  tutorial?: Tutorial | null;
  story?: Story | null;
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
  powerup: Powerup | null;
  recentEvents: GameEvent[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const slot = (v: unknown): v is Slot => v === "P1" || v === "P2";
const spell = (v: unknown): v is Spell =>
  SPELLS.some((name) => v === name);
const powerupKind = (v: unknown): v is PowerupKind =>
  POWERUPS.some((name) => v === name);
const deadline = (v: unknown) => v === null || finite(v);
const SPELL_NUMBERS = [
  "damage", "heal", "cooldownMs", "flightMs", "shieldMs", "offenseLockMs",
  "stunMs", "stunChancePercent", "burnDamage", "burnMs",
] as const;
export function parseRules(value: unknown): Rules {
  if (
    !object(value) ||
    value.version !== 1 ||
    !finite(value.roundMs) ||
    !finite(value.maxHp) ||
    !["critChancePercent", "critMultiplierPercent", "perfectBlockMs", "powerupLifetimeMs"].every(
      (k) => finite(value[k]) && (value[k] as number) >= 0,
    ) ||
    !Array.isArray(value.spells) ||
    value.spells.length !== SPELLS.length ||
    new Set(value.spells.map((r) => object(r) ? r.spell : null)).size !== SPELLS.length ||
    !value.spells.every(
      (r) =>
        object(r) &&
        spell(r.spell) &&
        typeof r.enabled === "boolean" &&
        typeof r.breaksShield === "boolean" &&
        SPELL_NUMBERS.every((k) => finite(r[k]) && (r[k] as number) >= 0),
    )
  )
    throw new Error("Unsupported game rules");
  return value as Rules;
}
export function parseSnapshot(value: unknown): Snapshot {
  if (
    !object(value) ||
    typeof value.roomId !== "string" ||
    !["duel", "solo", "tutorial", "story"].includes(String(value.mode)) ||
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
      !["phone", "ble", "replay", "bot"].includes(String(p.source)) ||
      (p.source === "bot" && (value.mode === "duel" || key !== "P2")) ||
      !["connected", "ready", "inputHealthy", "lucky"].every(
        (k) => typeof p[k] === "boolean",
      ) ||
      !["inputGeneration", "bootId"].every((k) => deadline(p[k])) ||
      !(p.deviceId === null || typeof p.deviceId === "string") ||
      ![
        "hp",
        "maxHp",
        "shieldUntilMs",
        "offenseLockedUntilMs",
        "stunnedUntilMs",
        "burnUntilMs",
        "hasteUntilMs",
        "mirrorUntilMs",
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
        typeof p.reflected === "boolean" &&
        ["launchAtMs", "impactAtMs", "damage", "offenseLockMs"].every((k) =>
          finite(p[k]),
        ),
    )
  )
    throw new Error("Invalid projectile state");
  const powerup = value.powerup;
  if (
    !(powerup === null || (
      object(powerup) &&
      typeof powerup.id === "string" &&
      powerupKind(powerup.kind) &&
      finite(powerup.spawnedAtMs) &&
      finite(powerup.expiresAtMs)
    ))
  )
    throw new Error("Invalid powerup state");
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
        (e.spell == null || spell(e.spell)) &&
        (e.critical === undefined || typeof e.critical === "boolean") &&
        (e.powerup == null || powerupKind(e.powerup)),
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
  const lesson = value.tutorial;
  if (value.mode === "tutorial") {
    if (!object(lesson) || !Number.isInteger(lesson.step) ||
      (lesson.step as number) < 0 || (lesson.step as number) > 5 ||
      !(lesson.spell === null || spell(lesson.spell)) ||
      !["instruction", "practice", "complete", "free"].includes(String(lesson.stage)) ||
      typeof lesson.paused !== "boolean")
      throw new Error("Invalid tutorial state");
  } else if (lesson != null) throw new Error("Unexpected tutorial state");
  const story = value.story;
  if (value.mode === "story") {
    if (
      !object(story) ||
      !Number.isInteger(story.level) ||
      !Number.isInteger(story.total) ||
      (story.level as number) < 1 ||
      (story.level as number) > (story.total as number) ||
      typeof story.name !== "string" ||
      !story.name
    )
      throw new Error("Invalid story state");
  } else if (story != null) throw new Error("Unexpected story state");
  return value as Snapshot;
}
