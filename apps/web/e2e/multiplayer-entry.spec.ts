import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { scriptedLaptop, connectBadge, snapshot, cast, castWithMicrophone } from "./scripted-laptop";

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
        healthTransitions: badge.healthTransitions,
        acknowledgements: Reflect.get(window, "__scriptedNetwork")?.acknowledgements,
        game: (() => {
          const controller = Reflect.get(window, "__duelController");
          const state = controller?.game.snapshot;
          return { phase: state?.phase, players: state?.players, recentEvents: state?.recentEvents,
            issue: controller?.issue, gameIssue: controller?.game.issue,
            speech: controller?.speech.getSnapshot().phase };
        })(),
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
  await expect(page.getByRole("button", { name: "Waiting for rival…", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/multiplayer-lobby-narrow.png", fullPage: true });
});

/** Wait until the caster's own cooldown for a spell has ended on the referee clock. */
async function readyFor(player: Page, spell: string) {
  await expect.poll(() => player.evaluate(name => {
    const controller = Reflect.get(window, "__duelController");
    const own = controller.game.snapshot.players[controller.game.slot];
    return own.cooldownUntilMs[name] <= controller.game.now();
  }, spell), { timeout: 15_000 }).toBe(true);
}

async function sharedHealth(first: Page, second: Page, hp: number) {
  await expect(first.getByRole("meter", { name: "Opponent health" })).toHaveAttribute("value", String(hp));
  await expect(second.getByRole("meter", { name: "Your health", exact: true })).toHaveAttribute("value", String(hp));
  expect((await snapshot(first)).players.P2?.hp).toBe(hp);
  expect((await snapshot(second)).players.P2?.hp).toBe(hp);
}

test("two normal players align microphone and wand in every order despite delayed cast delivery", async ({ page, browser }, testInfo) => {
  test.setTimeout(70_000);
  const first = await scriptedLaptop(page);
  first.enableSpeech();
  await connectBadge(page);
  await page.getByRole("button", { name: "Start a duel", exact: true }).click();
  await expect(page.getByLabel("Duel code")).toHaveText(/^[A-Z0-9]{6}$/);
  const code = (await page.getByLabel("Duel code").textContent())!;
  await expect(page.getByRole("button", { name: "Waiting for rival…", exact: true })).toBeDisabled();
  const opponentContext = await browser.newContext({ baseURL: new URL(page.url()).origin,
    viewport: { width: 1440, height: 1000 } });
  const opponent = await opponentContext.newPage();
  const second = await scriptedLaptop(opponent);
  second.enableSpeech();
  await connectBadge(opponent);
  await opponent.getByLabel("Already have a duel code?").fill(code);
  // Make joining visibly asynchronous even against the local referee. Ready
  // must wait for membership instead of being cleared by that room reset.
  await opponent.route("**/api/game/session", async route => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue();
  });
  await opponent.getByRole("button", { name: "Join with code", exact: true }).click();
  for (const player of [page, opponent]) {
    await expect(player.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
    await player.getByRole("button", { name: "Ready", exact: true }).click();
  }
  for (const player of [page, opponent]) {
    await expect.poll(async () => (await snapshot(player)).phase).toBe("playing");
    await player.evaluate(() => {
      Reflect.get(window, "__scriptedBadge").batchMs = 100;
      // Delay only outbound cast transport; the real referee still decides and
      // broadcasts every result. Local input pairing must happen before this delay.
      Reflect.get(window, "__scriptedNetwork").castDelayMs = 175;
    });
  }
  const evidence = [];
  let hp = 100;
  for (const order of ["overlap", "speech-first", "movement-first"] as const) {
    for (const player of [page, opponent]) await expect.poll(async () => {
      const state = await snapshot(player);
      return Math.max(state.players.P1!.cooldownUntilMs.stupefy, state.players.P2!.cooldownUntilMs.stupefy) - state.serverNowMs;
    }).toBeLessThanOrEqual(0);
    const casts = await Promise.all([page, opponent].map(player => castWithMicrophone(player, "stupefy", order)));
    for (const proof of casts) {
      expect(proof.sends[0].sentAtMs! - proof.sends[0].queuedAtMs).toBeGreaterThanOrEqual(150);
      expect(proof.acknowledgements[0].atMs).toBeGreaterThanOrEqual(proof.sends[0].sentAtMs!);
    }
    evidence.push({ order, casts });
    hp -= 20;
    for (const player of [page, opponent]) await expect.poll(async () => {
      const state = await snapshot(player);
      return [state.players.P1?.hp, state.players.P2?.hp];
    }).toEqual([hp, hp]);
  }
  const evidencePath = testInfo.outputPath("multiplayer-microphone-motion-timing.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  await testInfo.attach("multiplayer-microphone-motion-timing", { path: evidencePath, contentType: "application/json" });
  const expectedSpells = Array(3).fill("stupefy");
  for (const player of [page, opponent]) {
    const state = await snapshot(player);
    for (const actor of ["P1", "P2"])
      expect(state.recentEvents.filter(event => event.actor === actor && event.type === "castAccepted").map(event => event.spell)).toEqual(expectedSpells);
    expect(await player.evaluate(() => {
      const c = Reflect.get(window, "__duelController");
      return { dev: c.devMode, simple: c.simpleMotion };
    })).toEqual({ dev: false, simple: false });
  }
});

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
  await expect(page.getByRole("button", { name: "Waiting for rival…", exact: true })).toBeDisabled();
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
  expect(rules.map((rule: { cooldownMs: number }) => rule.cooldownMs)).toEqual([2500, 4000, 6000, 9000, 12000]);
  await expect(page.getByRole("progressbar")).toHaveCount(5);
  expect(await page.locator(".spell-slot").evaluateAll(cards =>
    cards.every(card => card.scrollWidth <= card.clientWidth + 1),
  )).toBe(true);
  await page.screenshot({ path: "/tmp/wandduel-battle.png", fullPage: true });
  await page.getByRole("region", { name: "Spell book" }).screenshot({ path: "/tmp/wandduel-hud.png" });

  // A Stupefy bolt lands 0.8 s after launch, faster than a raw guard replay can react, so the
  // defender starts raising while the attacker's jab is still being performed: the 1.5 s shield
  // is up before the bolt arrives and is old enough at impact to be an ordinary block.
  const attackPromise = cast(page, "stupefy");
  await page.waitForTimeout(300);
  const guardPromise = cast(opponent, "protego");
  expect((await attackPromise).accepted).toBe(true);
  await expect(page.getByLabel(/^Stupefy: recharging/)).toBeVisible();
  expect((await guardPromise).accepted).toBe(true);
  await expect(opponent.getByLabel(/^Protego: recharging/)).toBeVisible();
  for (const player of [page, opponent])
    await expect.poll(async () => (await snapshot(player)).recentEvents.some(event => event.type === "impactBlocked")).toBe(true);
  await sharedHealth(page, opponent, 100);

  expect((await cast(page, "incendio")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  // The other attack can cast while Incendio is still cooling down: no shared cooldown.
  await readyFor(page, "stupefy");
  expect((await cast(page, "stupefy")).accepted).toBe(true);
  await expect(page.getByLabel(/^Incendio: recharging/)).toBeVisible();
  // 22 + 14 on impact, then the fireball's burn ticks 3 per second for four seconds.
  await expect.poll(async () => (await snapshot(page)).players.P2?.hp, { timeout: 12_000 }).toBe(52);
  await sharedHealth(page, opponent, 52);
  expect((await snapshot(page)).recentEvents.filter(event => event.type === "burned")).toHaveLength(4);
  expect(await cast(page, "incendio")).toMatchObject({ accepted: false, reason: "cooldown" });
  await sharedHealth(page, opponent, 52);

  expect((await cast(opponent, "episkey")).accepted).toBe(true);
  await sharedHealth(page, opponent, 74);
  await expect(opponent.getByLabel(/^Episkey: recharging/)).toBeVisible();
  expect(await cast(opponent, "episkey")).toMatchObject({ accepted: false, reason: "cooldown" });
  await sharedHealth(page, opponent, 74);

  expect((await cast(page, "expelliarmus")).accepted).toBe(true);
  await expect(page.getByLabel(/^Expelliarmus: recharging/)).toBeVisible();
  await sharedHealth(page, opponent, 66);
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
  for (const hp of [52, 38, 24, 10, 0]) {
    await readyFor(page, "stupefy");
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
