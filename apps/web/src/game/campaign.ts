/** Story mode: a ladder of bot rivals. Names mirror the referee's `STORY_NAMES`. */

export type StoryLevel = {
  level: number;
  name: string;
  sprite: string;
  /** CSS hue rotation in degrees so a shared sprite reads as a new rival. */
  hue: number;
  intro: string;
  chapter: string;
};

const SPRITES = ["/art/story-witch.png", "/art/story-mage.png", "/art/wizard-rival-front.png"];
const HUES = [0, 40, 300, 120, 200, 260, 20, 160];
const CHAPTERS = ["The Village", "The Academy", "The Ministry", "The Dark Tower"];
const RIVALS: [string, string][] = [
  ["Hedge Witch", "Sells charms at the market. Mostly harmless."],
  ["Apprentice Mage", "Two years of lessons and twice the confidence."],
  ["Pixie Wrangler", "Fast hands from catching pixies all day."],
  ["Potions Prefect", "Knows exactly when to raise a shield."],
  ["Quidditch Bruiser", "Brings fire to a wand fight."],
  ["Ghoul Keeper", "Patient. Then suddenly not."],
  ["Hex Peddler", "Every spell has a nasty twist."],
  ["Duelling Club Captain", "Will disarm you the moment you blink."],
  ["Grindylow Tamer", "Slippery, relentless, and never still."],
  ["Runes Scholar", "Heals mid-duel. Annoyingly."],
  ["Auror Cadet", "Trained to block first and ask later."],
  ["Curse Breaker", "Has walked out of worse than this."],
  ["Boggart Bane", "Fears nothing you can cast."],
  ["Veela Envoy", "Beautiful, and burning."],
  ["Dragon Handler", "Fire is a friend, not a weapon. Still hurts."],
  ["Shadow Duelist", "You will not see the second spell coming."],
  ["Warlock of the Moor", "Older than the castle. Meaner too."],
  ["Dementor Whisperer", "Cold. Precise. Never misses a block."],
  ["Unspeakable", "Whatever they do downstairs, it works."],
  ["Head Auror", "The finest wand the Ministry has."],
  ["Dark Acolyte", "Fights like someone with nothing to lose."],
  ["Lich Sorcerer", "Keeps healing. Keeps coming."],
  ["Archmage Emeritus", "Retired. Undefeated."],
  ["The Nameless One", "The end of the road."],
];

export const STORY_LEVELS: StoryLevel[] = RIVALS.map(([name, intro], index) => ({
  level: index + 1,
  name,
  sprite: SPRITES[index % SPRITES.length],
  hue: HUES[Math.floor(index / SPRITES.length) % HUES.length],
  intro,
  chapter: CHAPTERS[Math.min(CHAPTERS.length - 1, Math.floor(index / 6))],
}));
export const STORY_LEVEL_COUNT = STORY_LEVELS.length;

export function storyLevel(level: number): StoryLevel | undefined {
  return STORY_LEVELS[level - 1];
}

const STORAGE_KEY = "wandduel.story.cleared";

export type StoryProgress = { cleared: number };

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Highest level beaten so far; level `cleared + 1` is the next one unlocked. */
export function loadProgress(): StoryProgress {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const cleared = raw === null || raw === undefined ? 0 : Number(raw);
    return {
      cleared: Number.isInteger(cleared)
        ? Math.min(STORY_LEVEL_COUNT, Math.max(0, cleared))
        : 0,
    };
  } catch {
    return { cleared: 0 };
  }
}

export function saveProgress(progress: StoryProgress): void {
  try {
    storage()?.setItem(STORAGE_KEY, String(progress.cleared));
  } catch {
    /* private mode or blocked storage: progress simply does not persist */
  }
}

/** Record a win; returns the updated progress. Never lowers what was already cleared. */
export function recordClear(level: number): StoryProgress {
  const current = loadProgress();
  const next = { cleared: Math.max(current.cleared, Math.min(STORY_LEVEL_COUNT, level)) };
  if (next.cleared !== current.cleared) saveProgress(next);
  return next;
}

export function isUnlocked(level: number, progress = loadProgress()): boolean {
  return level >= 1 && level <= STORY_LEVEL_COUNT && level <= progress.cleared + 1;
}
