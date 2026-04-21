import { runGa4HealthCheckCron } from './handlers/ga4HealthCheckHandler';
import { handleSendNotification } from './handlers/errorNotifyHandler';
import type { Env } from './types';

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runGa4HealthCheckCron(env));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        environment: env.ENVIRONMENT,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/send-notification') {
      return handleSendNotification(request, env);
    }

    return new Response('r2c-analytics-worker v0.2.0', { status: 200 });
  },
};
