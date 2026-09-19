import { defineConfig } from "@playwright/test";

// Explicit live local-HTTPS verification. Never starts/exposes a server or ignores
// certificate errors. Run only against an empty QA room, not a human match.
const baseURL = process.env.WAND_PHONE_TEST_URL;
if (
  !baseURL ||
  !/^https:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):5173\/?$/.test(
    baseURL,
  )
)
  throw new Error(
    "Set WAND_PHONE_TEST_URL to the approved private HTTPS frontend on port 5173",
  );

export default defineConfig({
  testDir: "./e2e",
  testMatch: "phone*.spec.ts",
  workers: 1,
  use: { baseURL, headless: true, viewport: { width: 1440, height: 1000 } },
});
