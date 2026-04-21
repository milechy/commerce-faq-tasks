export interface Env {
  ENVIRONMENT: string;
  INTERNAL_API_URL: string;
  INTERNAL_API_HMAC_SECRET: string;
  EMAIL: SendEmail;
}

// Cron handler — runs on schedule defined in wrangler.jsonc
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[r2c-analytics-worker] cron triggered: ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
    console.log(`[r2c-analytics-worker] environment: ${env.ENVIRONMENT}`);
    console.log(`[r2c-analytics-worker] internal api: ${env.INTERNAL_API_URL}`);

    // Day 4: implement GA4 sync, CV deduplication, weekly report
    // For now, just confirm the worker is alive
    ctx.waitUntil(pingInternalApi(env));
  },

  // HTTP handler — for manual triggers and health checks
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        environment: env.ENVIRONMENT,
        timestamp: new Date().toISOString(),
      });
    }

    return new Response('r2c-analytics-worker v0.1.0', { status: 200 });
  },
};

async function pingInternalApi(env: Env): Promise<void> {
  const body = { task: 'heartbeat', timestamp: new Date().toISOString() };
  const hmacHeader = await buildHmacHeaders(body, env.INTERNAL_API_HMAC_SECRET);

  try {
    const res = await fetch(`${env.INTERNAL_API_URL}/health`, {
      method: 'GET',
      headers: {
        'X-Internal-Request': '1',
        ...hmacHeader,
      },
    });
    console.log(`[r2c-analytics-worker] VPS health: ${res.status}`);
  } catch (err) {
    console.error('[r2c-analytics-worker] VPS unreachable:', err);
  }
}

async function buildHmacHeaders(
  body: unknown,
  secret: string,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${JSON.stringify(body)}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const signature = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    'X-HMAC-Timestamp': timestamp,
    'X-HMAC-Signature': signature,
  };
}
