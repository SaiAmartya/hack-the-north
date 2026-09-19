import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PAIR_CREATE_SECRET: "test-only-pair-create-secret",
          ALLOWED_OWNER_ORIGINS: "https://laptop.example",
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
  },
});
