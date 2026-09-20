import { expect, test, type Page } from "@playwright/test";

type PermissionProbe = {
  getUserMedia: number;
};

async function openLab(page: Page) {
  await page.addInitScript(() => {
    const probe: PermissionProbe = { getUserMedia: 0 };
    Object.defineProperty(window, "__deviceLabPermissionProbe", {
      configurable: false,
      value: probe,
    });

    if (typeof MediaDevices === "undefined") return;
    const original = MediaDevices.prototype.getUserMedia;
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      configurable: true,
      value(
        this: MediaDevices,
        ...args: Parameters<MediaDevices["getUserMedia"]>
      ) {
        probe.getUserMedia += 1;
        return original.apply(this, args);
      },
    });
  });

  await page.goto("/__qa/device-lab");
  await expect(page).toHaveTitle("Wandduel");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Every great wizard starts here.",
    }),
  ).toBeVisible();
  await expect(page.locator("main#practice-lab")).toBeVisible();
  await expect(page.locator("section#connect")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const widths = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));

  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
}

async function tabTo(page: Page, target: ReturnType<Page["locator"]>) {
  for (let presses = 0; presses < 20; presses += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error("Target was not reachable within 20 Tab presses");
}

test("initial replay lab is permission-free and never presents a cast-ready state", async ({
  page,
}) => {
  await openLab(page);

  await expect(
    page.getByText("No microphone is requested.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("source-label")).toHaveText("REPLAY");
  await expect(page.getByTestId("phase")).toHaveText("disconnected");
  await expect(page.getByTestId("feedback")).toContainText(
    "NEUTRAL / LINK STALE",
  );
  await expect(page.getByText("Not implemented · no Ready")).toBeVisible();

  const permissionProbe = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __deviceLabPermissionProbe: PermissionProbe;
        }
      ).__deviceLabPermissionProbe,
  );
  expect(permissionProbe).toEqual({ getUserMedia: 0 });

  await expect(
    page.getByRole("button", {
      name: /^(ready|cast(?:\s|$)|start (?:duel|match))/i,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Test cue (not a cast)", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh practice state", exact: true }),
  ).toBeDisabled();
  for (const label of ["rest", "jab", "guard", "sweep"]) {
    await expect(
      page.getByRole("button", { name: `${label} trace`, exact: true }),
    ).toBeDisabled();
  }
  for (const label of [
    "Duplicate next sample",
    "Inject 600 ms outage",
    "Inject backward / stale capture",
    "Drop next command ACK",
  ]) {
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toBeDisabled();
  }
});

test("same-page navigation and primary controls are keyboard reachable", async ({
  page,
}) => {
  await openLab(page);

  const destinations = await page.locator(".lab a[href]").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(destinations.length).toBeGreaterThan(0);
  expect(destinations.every((href) => href?.startsWith("#"))).toBe(true);

  const connectLink = page.getByRole("link", {
    name: "Let's meet your wand",
    exact: false,
  });
  await expect(connectLink).toBeVisible();
  await expect(connectLink).toHaveAttribute("href", "#connect");
  await tabTo(page, connectLink);
  await expect(connectLink).toBeFocused();
  const focusStyle = await connectLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusStyle.style).not.toBe("none");
  expect(focusStyle.width).not.toBe("0px");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#connect$/);
  await expect(page.locator("section#connect")).toBeInViewport();

  const connectButton = page.getByRole("button", {
    name: "Connect wand",
    exact: true,
  });
  await tabTo(page, connectButton);
  await expect(connectButton).toBeFocused();
});

test("desktop lab renders without runtime errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: "test-results/device-lab-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow", width: 320, height: 700 },
] as const) {
  test(`${viewport.name} layout has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openLab(page);
    await expectNoHorizontalOverflow(page);

    if (viewport.width === 390) {
      await page.screenshot({
        path: "test-results/device-lab-mobile.png",
        fullPage: true,
      });
    }
  });
}

test("reduced-motion preference suppresses long-running presentation motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLab(page);
  expect(
    await page.evaluate(() =>
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);

  const motion = await page.locator("body").evaluate((body) => {
    const seconds = (value: string) =>
      value.split(",").map((part) => {
        const duration = Number.parseFloat(part);
        return part.trim().endsWith("ms") ? duration / 1000 : duration;
      });
    let longestSeconds = 0;
    for (const element of body.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      longestSeconds = Math.max(
        longestSeconds,
        ...seconds(style.animationDuration),
        ...seconds(style.transitionDuration),
      );
    }
    return {
      longestSeconds,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });

  expect(motion.longestSeconds).toBeLessThanOrEqual(0.01);
  expect(motion.scrollBehavior).not.toBe("smooth");
});

test("replay connects, decoded feedback expires, outage faults and reconnects", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page);
  await page.getByRole("button", { name: "Connect wand", exact: true }).click();
  await expect(page.getByTestId("phase")).toHaveText("streaming");
  await expect(page.getByTestId("accepted")).not.toHaveText("0");
  await page.getByRole("button", { name: "jab trace" }).click();
  await page.getByRole("button", { name: "Refresh practice state" }).click();
  await expect(page.getByTestId("feedback")).toContainText("PRACTICE");
  const oldEpoch = await page.getByTestId("presentation-epoch").textContent();
  await page.getByRole("button", { name: "Test cue (not a cast)" }).click();
  await expect(page.getByTestId("cue-count")).toHaveText("1");
  await page.getByRole("button", { name: "Stop refresh" }).click();
  await expect(page.getByTestId("feedback")).toContainText(
    "NEUTRAL / LINK STALE",
  );
  await page.getByRole("button", { name: "Inject 600 ms outage" }).click();
  await expect(page.getByTestId("phase")).toHaveText("fault");
  await expect(page.getByRole("alert")).toContainText("500 ms");
  await page.getByRole("button", { name: "Connect wand", exact: true }).click();
  await expect(page.getByTestId("phase")).toHaveText("streaming");
  await page.getByRole("button", { name: "Refresh practice state" }).click();
  await expect(page.getByTestId("presentation-epoch")).not.toHaveText(
    oldEpoch!,
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByTestId("phase")).toHaveText("disconnected");
  expect(errors).toEqual([]);
});
