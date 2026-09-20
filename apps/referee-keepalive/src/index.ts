/**
 * Referee keep-alive.
 *
 * Render sleeps a free web service after 15 minutes without an inbound request and takes about
 * a minute to wake, which is too long for a player who just clicked Start a duel. Every ten
 * minutes this Worker fetches the referee's health route, so the service never reaches the idle
 * threshold. The request is a plain GET with no credentials; the referee's health route is public.
 */

export interface Env {
  REFEREE_HEALTH_URL: string;
}

const REQUEST_TIMEOUT_MS = 120_000;

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(ping(env.REFEREE_HEALTH_URL));
  },
  // The Worker has no public route (workers_dev is off); this only answers wrangler's local dev.
  async fetch(): Promise<Response> {
    return new Response("wandduel referee keep-alive: scheduled only\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};

async function ping(url: string): Promise<void> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "wandduel-referee-keepalive" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.text()).slice(0, 200);
    console.log(
      `keepalive ${response.status} after ${Date.now() - started} ms: ${body}`,
    );
  } catch (error) {
    console.log(
      `keepalive failed after ${Date.now() - started} ms: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
