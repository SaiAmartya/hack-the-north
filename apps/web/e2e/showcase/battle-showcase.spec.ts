import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectBadge, scriptedLaptop, snapshot } from "../scripted-laptop";

const OUT = process.env.SHOWCASE_DIR ?? fileURLToPath(new URL("./shots/", import.meta.url));

async function clickCast(page: Page, spell: string) {
  const button = page.getByRole("button", { name: new RegExp(`^Cast ${spell}:`, "i") });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
}

test("solo duel effect showcase", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const arena = page.locator(".arena");
  let index = 0;
  const shot = async (name: string, full = false) => {
    index += 1;
    const path = `${OUT}${String(index).padStart(2, "0")}-${name}.png`;
    if (full) await page.screenshot({ path, fullPage: true });
    else await arena.screenshot({ path });
    return path;
  };
  const eventSince = async (types: string[], atMs: number) =>
    (await snapshot(page)).recentEvents.find((event) => types.includes(event.type) && event.atMs >= atMs);

  await scriptedLaptop(page);
  await page.getByRole("switch", { name: "Dev mode", exact: true }).click();
  await connectBadge(page);
  await page.getByRole("button", { name: "Duel a bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeEnabled({ timeout: 10_000 });
  await shot("lobby", true);
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).phase).toBe("playing");
  await page.waitForTimeout(400);

  // Incendio: slow fireball, embers, burning status, screen shake.
  const fireAt = (await snapshot(page)).serverNowMs;
  await clickCast(page, "Incendio");
  await page.waitForTimeout(650);
  await shot("incendio-flight");
  await page.waitForTimeout(650);
  await shot("incendio-flight-late");
  await expect.poll(() => eventSince(["damage", "impactBlocked", "impactReflected"], fireAt), { intervals: [30], timeout: 6_000 }).toBeTruthy();
  await page.waitForTimeout(90);
  await shot("incendio-impact");
  await page.waitForTimeout(500);
  await shot("after-fire", true);

  // Stupefy: quick crackling bolt.
  const boltAt = (await snapshot(page)).serverNowMs;
  await clickCast(page, "Stupefy");
  await page.waitForTimeout(330);
  await shot("stupefy-flight");
  await expect.poll(() => eventSince(["damage", "impactBlocked", "impactReflected"], boltAt), { intervals: [30], timeout: 6_000 }).toBeTruthy();
  await page.waitForTimeout(80);
  await shot("stupefy-impact");

  // Expelliarmus: golden hook, then the rival's wand is yanked away.
  const hookAt = (await snapshot(page)).serverNowMs;
  await clickCast(page, "Expelliarmus");
  await page.waitForTimeout(550);
  await shot("expelliarmus-flight");
  await expect.poll(() => eventSince(["offenseLocked", "impactBlocked", "impactReflected"], hookAt), { intervals: [30], timeout: 6_000 }).toBeTruthy();
  await page.waitForTimeout(260);
  await shot("expelliarmus-disarm");
  await page.waitForTimeout(500);
  await shot("disarmed-status", true);

  // Relic: the first one appears 8-14 s into the round. Catch it the moment it shows
  // (the rival races for it too), then claim it with any spell.
  const playing = async () => (await snapshot(page)).phase === "playing";
  const relic = page.getByTestId("arena-relic");
  const relicAppeared = await relic.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
  if (relicAppeared) {
    await shot("relic-appeared");
    await page.waitForTimeout(450);
    await shot("relic-floating", true);
    const claimAt = (await snapshot(page)).serverNowMs;
    // Keep trying any ready spell until someone claims it (a disarm or stun can lock every card briefly).
    const deadline = Date.now() + 11_000;
    while (Date.now() < deadline && !(await eventSince(["powerupClaimed", "powerupExpired"], claimAt))) {
      for (const spell of ["Stupefy", "Protego", "Expelliarmus", "Episkey", "Incendio"]) {
        const button = page.getByRole("button", { name: new RegExp(`^Cast ${spell}:`, "i") });
        if (await button.isEnabled()) {
          await button.click();
          break;
        }
      }
      await page.waitForTimeout(200);
    }
    if (await eventSince(["powerupClaimed"], claimAt)) {
      await page.waitForTimeout(250);
      await shot("relic-claimed", true);
    }
  }

  // Episkey once hurt, so the showcase wizard survives long enough for the guard scene.
  if (await playing()) {
    await expect.poll(async () => (await snapshot(page)).players.P1!.hp, { timeout: 30_000 }).toBeLessThan(100);
    const healAt = (await snapshot(page)).serverNowMs;
    const heal = page.getByRole("button", { name: /^Cast Episkey:/ });
    if (await heal.isEnabled()) {
      await heal.click();
      await expect.poll(() => eventSince(["healed"], healAt), { intervals: [30], timeout: 6_000 }).toBeTruthy();
      await page.waitForTimeout(300);
      await shot("episkey-heal", true);
    }
  }

  // Protego timed late against an incoming spell: reflection when the window is hit.
  const guardWindow = async () => {
    const state = await snapshot(page);
    const incoming = state.projectiles.find((p) => p.target === "P1");
    if (!incoming) return null;
    return incoming.impactAtMs - state.serverNowMs;
  };
  await expect.poll(guardWindow, { intervals: [25], timeout: 25_000 }).toBeTruthy();
  let remaining = await guardWindow();
  while (remaining !== null && remaining > 330) {
    await page.waitForTimeout(Math.min(60, remaining - 320));
    remaining = await guardWindow();
  }
  const guardAt = (await snapshot(page)).serverNowMs;
  const protego = page.getByRole("button", { name: /^Cast Protego:/ });
  if (await protego.isEnabled()) await protego.click();
  await page.waitForTimeout(120);
  await shot("protego-raised");
  await expect.poll(() => eventSince(["impactBlocked", "impactReflected", "damage", "shieldBroken"], guardAt), { intervals: [30], timeout: 6_000 }).toBeTruthy();
  await page.waitForTimeout(140);
  await shot("protego-outcome");
  await page.waitForTimeout(500);
  await shot("after-guard", true);

  // Let the round run to its end and capture the result.
  await expect(page.getByRole("heading", { name: /^(Victory|Defeat|An even match)!$/ })).toBeVisible({ timeout: 100_000 });
  await page.waitForTimeout(300);
  await shot("result", true);
  console.log(JSON.stringify({
    result: (await snapshot(page)).result,
    events: (await snapshot(page)).recentEvents.map((e) => [e.type, e.actor, e.target, e.amount, e.critical, e.powerup].filter((v) => v !== undefined && v !== null && v !== false)),
    errors,
  }));
  expect(errors).toEqual([]);
});
