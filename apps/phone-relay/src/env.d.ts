import type { Env as WorkerEnv } from "./index";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends WorkerEnv {}
}
