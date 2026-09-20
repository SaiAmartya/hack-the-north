import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../../playwright.config";

/**
 * Battle showcase: drives one dev-mode solo duel with the scripted badge and writes a
 * screenshot per spell effect. Not part of the QA suite (the main config ignores this
 * folder). Run from apps/web:
 *   npx playwright test -c e2e/showcase/playwright.config.ts
 * Screenshots land in SHOWCASE_DIR (default: e2e/showcase/shots).
 */
const web = fileURLToPath(new URL("../../", import.meta.url));
const host = fileURLToPath(new URL("../../../host/", import.meta.url));
const servers = (base.webServer ? (Array.isArray(base.webServer) ? base.webServer : [base.webServer]) : []).map(
  (server, index) => ({
    ...server,
    cwd: index === 0 ? web : host,
    command: index === 0
      ? server.command
      : process.platform === "win32"
        ? ".venv\\Scripts\\python.exe -m uvicorn phantom_host.duel_app:app --host 127.0.0.1 --port 18000"
        : ".venv/bin/python -m uvicorn phantom_host.duel_app:app --host 127.0.0.1 --port 18000",
    // The showcase wants the full game: crits, stuns and relics stay on.
    env: { ...(server.env ?? {}), ...(index === 0 ? {} : { WAND_VARIANCE: "true" }) },
    reuseExistingServer: true,
  }),
);

export default defineConfig({
  ...base,
  testDir: ".",
  testIgnore: [],
  timeout: 300_000,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results",
  webServer: servers,
});
