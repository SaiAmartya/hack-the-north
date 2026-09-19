import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The host binds to 127.0.0.1 only; the dev server proxies the websocket so the
// browser never needs to know the host port.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
      "/health": { target: "http://127.0.0.1:8000" },
      "/match": { target: "http://127.0.0.1:8000" },
    },
  },
});
