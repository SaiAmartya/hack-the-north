/**
 * The seven duel spells, shared by the referee contract, speech vocabulary, motion recognizer and
 * HUD. Identifiers are the wire values the Python referee uses; titles are what players read.
 * Effects are game adaptations, not claims of exact fictional canon.
 */
export const SPELL_NAMES = [
  "stupefy",
  "protego",
  "expelliarmus",
  "incendio",
  "sectumsempra",
  "petrificus-totalus",
  "expecto-patronum",
] as const;
export type SpellName = (typeof SPELL_NAMES)[number];

/** Every player must calibrate these two; the rest are optional extras. */
export const CORE_SPELL_NAMES: readonly SpellName[] = ["stupefy", "protego"];
export const OPTIONAL_SPELL_NAMES: readonly SpellName[] = SPELL_NAMES.filter(
  (spell) => !CORE_SPELL_NAMES.includes(spell),
);
export const OFFENSIVE_SPELL_NAMES: readonly SpellName[] = [
  "stupefy",
  "expelliarmus",
  "incendio",
  "sectumsempra",
  "petrificus-totalus",
];

/**
 * How the recognizer models the movement: a stroke whose whole trace is matched by dynamic time
 * warping against the calibrated examples, a raise into a held pose, or a circle, which is matched
 * the same way as a stroke but coached by trace distance rather than by direction (a circle has no
 * single direction).
 */
export type GestureKind = "impulse" | "guard" | "arc";

export type SpellInfo = {
  name: SpellName;
  title: string;
  /** Exact spoken form after case/punctuation/whitespace normalization. */
  incantation: string;
  gesture: GestureKind;
  /** One-line description of the movement for docks and coaching. */
  move: string;
  /** Short dock hint. */
  hint: string;
  /** Calibration heading. */
  calibration: string;
  /** Shown after an accepted calibration example. */
  again: string;
  /** Coaching when the movement was too weak. */
  harder: string;
  /** Coaching when the movement differed from the previous examples. */
  sameWay: string;
  /** What the spell does, for the setup screen. */
  effect: string;
};

export const SPELLS: Readonly<Record<SpellName, SpellInfo>> = {
  stupefy: {
    name: "stupefy",
    title: "Stupefy",
    incantation: "stupefy",
    gesture: "impulse",
    move: "Jab forward",
    hint: "Jab + speak",
    calibration: "Jab forward, three times.",
    again: "Again.",
    harder: "Jab a little harder.",
    sameWay: "Jab the same way each time.",
    effect: "Stunning bolt. 20 damage.",
  },
  protego: {
    name: "protego",
    title: "Protego",
    incantation: "protego",
    gesture: "guard",
    move: "Raise and hold",
    hint: "Raise + speak",
    calibration: "Raise your wand into a guard and hold it. Lower, then raise again. Three times.",
    again: "Lower, then raise again.",
    harder: "Raise a little quicker, then hold it still.",
    sameWay: "Raise the same way each time.",
    effect: "Shield. Catches one spell, then breaks.",
  },
  expelliarmus: {
    name: "expelliarmus",
    title: "Expelliarmus",
    incantation: "expelliarmus",
    gesture: "impulse",
    move: "Pull back sharply",
    hint: "Pull back + speak",
    calibration: "Pull the wand back to your shoulder, three times.",
    again: "Again.",
    harder: "Pull back a little harder.",
    sameWay: "Pull back the same way each time.",
    effect: "Disarms: no attacks for a second. 10 damage.",
  },
  incendio: {
    name: "incendio",
    title: "Incendio",
    incantation: "incendio",
    gesture: "impulse",
    move: "Flick up and return",
    hint: "Flick up + speak",
    calibration: "Flick up and back down, three times.",
    again: "Again.",
    harder: "Flick a little harder.",
    sameWay: "Flick the same way each time.",
    effect: "Fire. 8 damage, then burns for 12 more.",
  },
  sectumsempra: {
    name: "sectumsempra",
    title: "Sectumsempra",
    incantation: "sectumsempra",
    gesture: "impulse",
    move: "Slash sideways",
    hint: "Slash + speak",
    calibration: "Slash sideways, three times.",
    again: "Again.",
    harder: "Slash a little harder.",
    sameWay: "Slash the same way each time.",
    effect: "Heavy slash. 35 damage, slow to arrive.",
  },
  "petrificus-totalus": {
    name: "petrificus-totalus",
    title: "Petrificus Totalus",
    incantation: "petrificus totalus",
    gesture: "impulse",
    move: "Chop down and return",
    hint: "Chop down + speak",
    calibration: "Chop straight down and back up, three times.",
    again: "Again.",
    harder: "Chop a little harder.",
    sameWay: "Chop the same way each time.",
    effect: "Body-bind. The target cannot cast for 1.5 seconds.",
  },
  "expecto-patronum": {
    name: "expecto-patronum",
    title: "Expecto Patronum",
    incantation: "expecto patronum",
    gesture: "arc",
    move: "Draw a full circle",
    hint: "Circle + speak",
    calibration: "Draw one full circle, three times.",
    again: "Again, the same way round.",
    harder: "Circle a little quicker.",
    sameWay: "Circle the same way round each time.",
    effect: "Patronus. Repels every spell for 3 seconds.",
  },
};

export function isSpellName(value: unknown): value is SpellName {
  return typeof value === "string" && (SPELL_NAMES as readonly string[]).includes(value);
}

/** Spoken incantation (normalized) to spell identifier. */
export const INCANTATIONS: ReadonlyMap<string, SpellName> = new Map(
  SPELL_NAMES.map((spell) => [SPELLS[spell].incantation, spell]),
);

export const spellTitle = (spell: SpellName): string => SPELLS[spell].title;
