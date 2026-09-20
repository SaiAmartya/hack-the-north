import { expect, test } from "@playwright/test";
import { scriptedLaptop, connectBadge, snapshot, cast } from "./scripted-laptop";

test("story mode unlocks one rival at a time and chains a win into the next level", async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const laptop = await scriptedLaptop(page);
  await expect(page.getByRole("button", { name: /Story mode/ })).toHaveCount(0);
  await connectBadge(page);

  // Level select: only the first rung is open on a fresh save.
  await expect(page.getByRole("button", { name: /Story mode/ })).toContainText("0/24");
  await page.getByRole("button", { name: /Story mode/ }).click();
  await expect(page.getByRole("heading", { name: "Story mode", exact: true })).toBeVisible();
  await expect(page.getByText("0 of 24 rivals defeated.", { exact: true })).toBeVisible();
  const levels = page.locator(".story-level button");
  await expect(levels).toHaveCount(24);
  await expect(levels.nth(0)).toBeEnabled();
  await expect(levels.nth(1)).toBeDisabled();
  await expect(levels.nth(23)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Level 1: Hedge Witch", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Level 2: Apprentice Mage (locked)", exact: true })).toBeVisible();
  await expect(page.locator(".story-chapter")).toHaveCount(4);
  await page.screenshot({ path: "/tmp/wandduel-story-map.png", fullPage: true });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your wand.*is ready/ })).toBeVisible();
  await page.getByRole("button", { name: /Story mode/ }).click();

  // Level 1 opens a private story room against the named rival.
  const creating = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/game/session",
  );
  await levels.nth(0).click();
  expect((await creating).postDataJSON()).toMatchObject({ mode: "story", level: 1, source: "ble" });
  await expect(page.getByRole("heading", { name: "Level 1 · Hedge Witch", exact: true })).toBeVisible();
  await expect(page.getByLabel("Duel code")).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).players.P2?.name).toBe("Hedge Witch");
  expect((await snapshot(page)).mode).toBe("story");
  expect((await snapshot(page)).story).toEqual({ level: 1, name: "Hedge Witch", total: 24 });
  await expect(page.getByRole("img", { name: "Hedge Witch, your rival" })).toHaveAttribute("src", "/art/story-witch.png");
  await expect(page.getByLabel("Rival wizard").getByText("HEDGE WITCH")).toHaveCount(0);
  laptop.enableSpeech();
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.screenshot({ path: "/tmp/wandduel-story-lobby.png", fullPage: true });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  await expect(page.getByLabel("Rival wizard").getByText("HEDGE WITCH")).toBeVisible();

  // Keep firing Stupefy; the first rung cannot block a bolt, so a steady caster wins by knockout.
  const started = Date.now();
  while (Date.now() - started < 80_000) {
    const state = await snapshot(page);
    if (state.phase === "result") break;
    if (state.players.P1 && state.players.P1.stunnedUntilMs <= state.serverNowMs) {
      // The knockout can land between this snapshot and the cast; a rejected cast then just ends the loop.
      try { await cast(page, "stupefy"); } catch { break; }
    }
    await page.waitForTimeout(350);
  }
  await expect(page.getByRole("heading", { name: "Victory!", exact: true })).toBeVisible({ timeout: 10_000 });
  expect((await snapshot(page)).result).toMatchObject({ outcome: "win", winner: "P1", reason: "knockout" });
  expect(await page.evaluate(() => localStorage.getItem("wandduel.story.cleared"))).toBe("1");
  await expect(page.getByText("Hedge Witch is beaten. Apprentice Mage waits ahead.", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/wandduel-story-victory.png", fullPage: true });

  // Winning offers the next rung directly; it is a fresh room against the next rival.
  const advancing = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/game/session",
  );
  await page.getByRole("button", { name: "Next: Apprentice Mage", exact: true }).click();
  expect((await advancing).postDataJSON()).toMatchObject({ mode: "story", level: 2 });
  await expect(page.getByRole("heading", { name: "Level 2 · Apprentice Mage", exact: true })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).story?.level).toBe(2);
  await expect(page.getByRole("img", { name: "Apprentice Mage, your rival" })).toHaveAttribute("src", "/art/story-mage.png");
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");

  // The second rival opens fire on its own within its first-action window.
  await expect.poll(async () => (await snapshot(page)).recentEvents.some(event =>
    event.type === "castAccepted" && event.actor === "P2",
  ), { intervals: [50], timeout: 20_000 }).toBe(true);

  // Leaving a story fight returns to the map: one cleared rung, one open, the rest locked.
  await page.getByRole("button", { name: "Leave duel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Story mode", exact: true })).toBeVisible();
  await expect(page.getByText("1 of 24 rivals defeated.", { exact: true })).toBeVisible();
  await expect(levels.nth(0)).toBeEnabled();
  await expect(levels.nth(1)).toBeEnabled();
  await expect(levels.nth(2)).toBeDisabled();
  await expect(page.locator(".story-level.is-cleared")).toHaveCount(1);
  await expect(page.locator(".story-level.is-next")).toHaveCount(1);
  expect(errors).toEqual([]);
});
