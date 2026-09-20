import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { scriptedLaptop, connectBadge, snapshot, cast } from "./scripted-laptop";

test.afterEach(async ({ context, browser }, testInfo) => {
  const laptops = browser.contexts();
  try {
    const timing = await Promise.all(laptops.flatMap(laptop => laptop.pages()).map(player => player.evaluate(() => {
      const badge = Reflect.get(window, "__scriptedBadge");
      if (!badge) return null;
      const gl = document.querySelector<HTMLCanvasElement>(".spell-canvas")?.getContext("webgl2");
      const debug = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        renderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable",
        nativeVisibility: Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState")?.get?.call(document),
        focused: document.hasFocus(), deliveries: badge.deliveries, longTasks: badge.longTasks,
      };
    })));
    const path = testInfo.outputPath("scripted-input-timing.json");
    await writeFile(path, JSON.stringify(timing, null, 2));
    await testInfo.attach("scripted-input-timing", { path, contentType: "application/json" });
  } finally {
    await Promise.all(laptops.filter(laptop => laptop !== context).map(laptop => laptop.close()));
  }
});

test("wand pairing precedes room creation and opens the lobby without calibration", async ({ page }) => {
  await scriptedLaptop(page);
  await expect(page.getByRole("button", { name: "Start a duel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await connectBadge(page);
  await page.getByLabel("Already have a duel code?").fill("abc");
  await page.getByRole("button", { name: "Join with code", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter the six-character duel code.");
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = await page.getByLabel("Duel code").textContent();
  await expect(page.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
  await expect(page.getByText("Speak + jab to attack. Speak + raise to shield or heal.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /practice|calibrat|join battle/i })).toHaveCount(0);
  await expect(page.locator("main")).toHaveClass(/in-duel/);
  await expect(page.getByLabel("Duel code")).toHaveText(code!);
  await expect(page.getByText("Share this code with your rival.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable microphone", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: /camera/i })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/multiplayer-lobby-narrow.png", fullPage: true });
});

async function sharedHealth(first: Page, second: Page, hp: number) {
  await expect(first.getByRole("meter", { name: "Opponent health" })).toHaveAttribute("value", String(hp));
  await expect(second.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", String(hp));
  expect((await snapshot(first)).players.P2?.hp).toBe(hp);
  expect((await snapshot(second)).players.P2?.hp).toBe(hp);
}

test("two ordinary player views sync five spells, cooldowns, victory, rematch and recovery", async ({ page, browser }) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const first = await scriptedLaptop(page);
  await connectBadge(page);
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = (await page.getByLabel("Duel code").textContent())!;
  await expect(page.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeDisabled();
  // Each laptop has its own browser storage and renderer context.
  const opponentContext = await browser.newContext({
    baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 },
  });
  const opponent = await opponentContext.newPage();
  opponent.on("pageerror", error => errors.push(error.message));
  const second = await scriptedLaptop(opponent);
  await connectBadge(opponent);
  await opponent.getByLabel("Already have a duel code?").fill(code.toLowerCase());
  await opponent.getByRole("button", { name: "Join with code", exact: true }).click();
  await expect(opponent.getByRole("heading", { name: "Battle lobby" })).toBeVisible();
  for (const player of [page, opponent])
    await expect(player.getByText("Your rival has joined.")).toBeVisible();
  first.enableSpeech();
  second.enableSpeech();
  for (const player of [page, opponent]) {
    await player.getByRole("button", { name: "Enable microphone", exact: true }).click();
    await expect(player.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  }
  await page.screenshot({ path: "test-results/multiplayer-lobby-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await opponent.getByRole("button", { name: "Ready", exact: true }).click();
  for (const player of [page, opponent]) {
    await expect(player.getByRole("meter", { name: "Opponent health" })).toBeVisible();
    await expect(player.getByRole("button", { name: /camera/i })).toHaveCount(0);
    await expect(player.locator("video")).toHaveCount(0);
  }
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  await expect.poll(async () => (await snapshot(opponent)).phase).toBe("playing");
  const firstRound = (await snapshot(page)).roundId;
  const rules = await page.evaluate(() => Reflect.get(window, "__duelController").game.rules.spells);
  expect(rules.map((rule: { cooldownMs: number }) => rule.cooldownMs)).toEqual([2000, 3000, 6000, 8000, 12000]);
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  expect(await page.locator(".spell-slot").evaluateAll(cards =>
    cards.every(card => card.scrollWidth <= card.clientWidth + 1),
  )).toBe(true);
  await page.screenshot({ path: "/tmp/wandduel-battle.png", fullPage: true });
  await page.getByRole("region", { name: "Spell book" }).screenshot({ path: "/tmp/wandduel-hud.png" });

  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Stupefy: recharging/)).toBeVisible();
  expect((await cast(opponent, "protego")).accepted).toBe(true);
  await expect(opponent.getByLabel(/^Protego: recharging/)).toBeVisible();
  for (const player of [page, opponent])
    await expect.poll(async () => (await snapshot(player)).recentEvents.some(event => event.type === "impactBlocked")).toBe(true);
  await sharedHealth(page, opponent, 100);

  expect((await cast(page, "incendio")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  // The other attack can cast while Incendio is still cooling down: no shared cooldown.
  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  await sharedHealth(page, opponent, 50);
  expect(await cast(page, "incendio")).toMatchObject({ accepted: false, reason: "cooldown" });
  await sharedHealth(page, opponent, 50);

  expect((await cast(opponent, "episkey")).accepted).toBe(true);
  await sharedHealth(page, opponent, 68);
  await expect(opponent.getByLabel(/^Episkey: recharging/)).toBeVisible();
  expect(await cast(opponent, "episkey")).toMatchObject({ accepted: false, reason: "cooldown" });
  await sharedHealth(page, opponent, 68);

  expect((await cast(page, "expelliarmus")).accepted).toBe(true);
  await expect(page.getByLabel(/^Expelliarmus: recharging/)).toBeVisible();
  await sharedHealth(page, opponent, 58);
  await expect(page.getByLabel("Rival wizard").getByText(/DISARMED/)).toBeVisible();
  await expect(opponent.getByLabel("Your wizard", { exact: true }).getByText(/DISARMED/)).toBeVisible();
  await page.screenshot({ path: "/tmp/wandduel-disarm.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  await page.screenshot({ path: "/tmp/wandduel-battle-narrow.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await expect(page.getByRole("meter", { name: "Your health", exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  expect(await page.locator(".spell-slot").evaluateAll(cards =>
    cards.every(card => card.scrollWidth <= card.clientWidth + 1),
  )).toBe(true);
  expect(await page.locator(".wizard").evaluateAll(wizards =>
    wizards.every(wizard => getComputedStyle(wizard).animationName === "none"),
  )).toBe(true);
  await page.screenshot({ path: "/tmp/wandduel-battle-zoom-reduced.png", fullPage: true });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const hp of [38, 18, 0]) {
    expect((await cast(page, "stupefy")).accepted).toBe(true);
    await sharedHealth(page, opponent, hp);
  }
  await expect(page.getByRole("heading", { name: "Victory!" })).toBeVisible();
  await expect(opponent.getByRole("heading", { name: "Defeat!" })).toBeVisible();
  expect((await snapshot(page)).result).toMatchObject({ outcome: "win", winner: "P1" });
  expect((await snapshot(opponent)).result).toEqual((await snapshot(page)).result);
  await page.screenshot({ path: "/tmp/wandduel-victory.png", fullPage: true });
  await opponent.screenshot({ path: "/tmp/wandduel-defeat.png", fullPage: true });
  for (const player of [page, opponent]) await player.getByRole("button", { name: "Rematch", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  expect((await snapshot(page)).roundId).toBeGreaterThan(firstRound);
  await sharedHealth(page, opponent, 100);

  const paired = await page.evaluate(() => ({ ...Reflect.get(window, "__scriptedBadge") }));
  first.disableSpeech();
  await page.evaluate(() => Reflect.get(window, "__setVisibility")(true));
  await expect(page.getByRole("heading", { name: "Duel paused" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").disconnects)).toBe(paired.disconnects);
  await page.evaluate(() => Reflect.get(window, "__setVisibility")(false));
  await expect(page.getByRole("button", { name: "Enable microphone", exact: true })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByLabel("Duel code")).toHaveText(code);
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").chooser)).toBe(1);
  first.enableSpeech();
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Duel paused" })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "__battleSocket").close());
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reconnect battle", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rematch", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Duel code")).toHaveText(code);
  expect(await page.evaluate(() => Reflect.get(window, "__scriptedBadge").chooser)).toBe(1);
  expect(errors).toEqual([]);
});
