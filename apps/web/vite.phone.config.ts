import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: {
    "import.meta.env.VITE_HOSTED_PHONE_BUILD": JSON.stringify("1"),
  },
  build: {
    outDir: "../phone-relay/public",
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "phone.html") },
  },
});
