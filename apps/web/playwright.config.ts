import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:15173",
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: [
    {
      command: "npm run dev",
      env: { VITE_WAND_QA: "1", WAND_QA_PORTS: "1", WAND_FRONTEND_HOST: "127.0.0.1" },
      url: "http://127.0.0.1:15173",
      reuseExistingServer: false,
    },
    {
      command:
        process.platform === "win32"
          ? "cd ../host && .venv\\Scripts\\python.exe -m uvicorn phantom_host.duel_app:app --host 127.0.0.1 --port 18000"
          : "cd ../host && .venv/bin/python -m uvicorn phantom_host.duel_app:app --host 127.0.0.1 --port 18000",
      env: {
        WAND_ALLOW_REPLAY: "true",
        WAND_DEV_RELAY: "true",
        WAND_ALLOWED_ORIGINS: "http://127.0.0.1:15173",
        // Browser tests stay offline: no STUN lookups during in-page negotiation.
        WAND_ICE_SERVERS: "[]",
      },
      url: "http://127.0.0.1:18000/api/game/health",
      reuseExistingServer: false,
    },
  ],
});
