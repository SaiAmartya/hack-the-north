import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { speechMiddleware } from "./dev/speech-proxy";
import { phoneMiddleware } from "./dev/phone-proxy";
import { canonicalOriginMiddleware } from "./dev/origin-redirect";

const host = process.env.WAND_FRONTEND_HOST ?? "127.0.0.1";
const qaPorts = process.env.WAND_QA_PORTS === "1";
const port = qaPorts ? 15173 : 5173;
const cert = process.env.WAND_TLS_CERT,
  key = process.env.WAND_TLS_KEY;
if (host !== "127.0.0.1" && (!cert || !key))
  throw new Error("LAN profiles require approved TLS certificate paths");
if (host === "0.0.0.0" || host === "::")
  throw new Error("Select one private interface, not a wildcard");
if (qaPorts && (host !== "127.0.0.1" || cert || key))
  throw new Error("Scripted QA uses isolated loopback ports only");
const origin = `${cert && key ? "https" : "http"}://${host}:${port}`;
const referee = qaPorts ? "http://127.0.0.1:18000" : (process.env.WAND_REFEREE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
/** A public https referee is addressed by host, so the proxy must present that host, not ours. */
function hostedReferee(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && url.origin === value;
  } catch {
    return false;
  }
}
const privateReferee = /^http:\/\/(127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):8000$/.test(referee);
if (!qaPorts && !privateReferee && !hostedReferee(referee))
  throw new Error(
    "Referee must be loopback, an explicitly selected private LAN address, or one https:// origin",
  );
const refereeProxy = { target: referee, changeOrigin: hostedReferee(referee) };

function localServices(server: ViteDevServer | PreviewServer) {
  // One loopback spelling: the hosted phone service trusts only this exact origin.
  server.middlewares.use(canonicalOriginMiddleware(origin));
  server.middlewares.use(
    phoneMiddleware(origin, host, process.env.WAND_PHONE_SERVICE, process.env.WAND_PHONE_CREATE_SECRET),
  );
  server.middlewares.use(
    speechMiddleware(origin, host, process.env.WAND_SPEECH_SECRET),
  );
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-game-services",
      configureServer: localServices,
      configurePreviewServer: localServices,
    },
  ],
  server: {
    host,
    port,
    strictPort: true,
    allowedHosts: [host],
    cors: { origin },
    ...(cert && key
      ? { https: { cert: readFileSync(cert), key: readFileSync(key) } }
      : {}),
    proxy: {
      "/api/game": refereeProxy,
      "/ws/game": { ...refereeProxy, ws: true },
      "/ws/dev-wand": { ...refereeProxy, ws: true },
    },
  },
  preview: { host, port, strictPort: true, allowedHosts: [host], cors: { origin } },
  build: { outDir: process.env.WAND_GAME_BUILD_DIR ?? "dist" },
});
