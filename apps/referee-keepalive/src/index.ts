/**
 * Referee keep-alive.
 *
 * Render sleeps a free web service after 15 minutes without an inbound request and takes about
 * a minute to wake, which is too long for a player who just clicked Start a duel. Every ten
 * minutes this Worker fetches the referee's health route, so the service never reaches the idle
 * threshold. The request is a plain GET with no credentials; the referee's health route is public.
 *
 * Each run is recorded in KV and served at GET / on the Worker's URL, so anyone can confirm the
 * schedule is firing without opening the Cloudflare dashboard.
 */

export interface Env {
  REFEREE_HEALTH_URL: string;
  KEEPALIVE: KVNamespace;
}

const REQUEST_TIMEOUT_MS = 120_000;
const LAST_RUN_KEY = "last-run";

type LastRun = {
  at: string;
  cron: string;
  status: number | null;
  durationMs: number;
  detail: string;
};

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(run(env, controller.cron));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/")
      return new Response("Not found\n", { status: 404 });
    const last = await env.KEEPALIVE.get(LAST_RUN_KEY);
    return new Response(
      JSON.stringify(
        {
          service: "wandduel referee keep-alive",
          schedule: "*/10 * * * *",
          target: env.REFEREE_HEALTH_URL,
          lastRun: last ? (JSON.parse(last) as LastRun) : null,
        },
        null,
        2,
      ) + "\n",
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      },
    );
  },
};

async function run(env: Env, cron: string): Promise<void> {
  const started = Date.now();
  let status: number | null = null;
  let detail = "";
  try {
    const response = await fetch(env.REFEREE_HEALTH_URL, {
      method: "GET",
      headers: { "User-Agent": "wandduel-referee-keepalive" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    detail = (await response.text()).slice(0, 200);
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  const record: LastRun = {
    at: new Date(started).toISOString(),
    cron,
    status,
    durationMs: Date.now() - started,
    detail,
  };
  console.log(`keepalive ${status ?? "failed"} after ${record.durationMs} ms: ${detail}`);
  await env.KEEPALIVE.put(LAST_RUN_KEY, JSON.stringify(record));
}
