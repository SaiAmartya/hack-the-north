import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORY_LEVELS,
  STORY_LEVEL_COUNT,
  isUnlocked,
  loadProgress,
  recordClear,
  saveProgress,
  storyLevel,
} from "./campaign";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

describe("story ladder", () => {
  it("has at least twenty numbered levels with unique names and a sprite each", () => {
    expect(STORY_LEVEL_COUNT).toBeGreaterThanOrEqual(20);
    expect(STORY_LEVELS.map((l) => l.level)).toEqual(STORY_LEVELS.map((_, i) => i + 1));
    expect(new Set(STORY_LEVELS.map((l) => l.name)).size).toBe(STORY_LEVEL_COUNT);
    for (const rung of STORY_LEVELS) expect(rung.sprite).toMatch(/^\/art\/.+\.png$/);
    expect(storyLevel(0)).toBeUndefined();
    expect(storyLevel(STORY_LEVEL_COUNT + 1)).toBeUndefined();
    expect(storyLevel(1)?.name).toBe("Hedge Witch");
  });

  it("starts with only level one unlocked and opens the next rung after each win", () => {
    expect(loadProgress()).toEqual({ cleared: 0 });
    expect(isUnlocked(1)).toBe(true);
    expect(isUnlocked(2)).toBe(false);
    expect(recordClear(1)).toEqual({ cleared: 1 });
    expect(isUnlocked(2)).toBe(true);
    expect(isUnlocked(3)).toBe(false);
    expect(recordClear(1)).toEqual({ cleared: 1 });
    expect(recordClear(5)).toEqual({ cleared: 5 });
    expect(recordClear(2)).toEqual({ cleared: 5 });
    expect(loadProgress()).toEqual({ cleared: 5 });
  });

  it("clamps corrupt or out-of-range saved progress", () => {
    localStorage.setItem("wandduel.story.cleared", "banana");
    expect(loadProgress()).toEqual({ cleared: 0 });
    localStorage.setItem("wandduel.story.cleared", "999");
    expect(loadProgress()).toEqual({ cleared: STORY_LEVEL_COUNT });
    saveProgress({ cleared: 3 });
    expect(loadProgress()).toEqual({ cleared: 3 });
    expect(isUnlocked(STORY_LEVEL_COUNT + 1, { cleared: STORY_LEVEL_COUNT })).toBe(false);
  });

  it("survives a missing or throwing storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadProgress()).toEqual({ cleared: 0 });
    expect(recordClear(1)).toEqual({ cleared: 1 });
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
    expect(loadProgress()).toEqual({ cleared: 0 });
    expect(() => saveProgress({ cleared: 2 })).not.toThrow();
  });
});
