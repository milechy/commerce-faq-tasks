import { buildHmacHeaders } from './hmacSigner';
import type { Env, Ga4TenantHealthResult } from '../types';

interface HealthCheckAllResponse {
  ok: boolean;
  results: Ga4TenantHealthResult[];
  checked_at: string;
}

export async function callGa4HealthCheckAll(env: Env): Promise<Ga4TenantHealthResult[]> {
  const body = {};
  const hmacHeaders = await buildHmacHeaders(body, env.INTERNAL_API_HMAC_SECRET);

  const res = await fetch(`${env.INTERNAL_API_URL}/internal/ga4/health-check-all`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Request': '1',
      ...hmacHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    throw new Error(`VPS /internal/ga4/health-check-all responded ${res.status}`);
  }

  const data = (await res.json()) as HealthCheckAllResponse;
  return data.results ?? [];
}

export interface SendNotificationPayload {
  to: string;
  subject: string;
  body: string;
}

export async function callSendNotification(
  env: Env,
  payload: SendNotificationPayload,
): Promise<void> {
  const hmacHeaders = await buildHmacHeaders(payload, env.INTERNAL_API_HMAC_SECRET);

  const res = await fetch(`${env.INTERNAL_API_URL}/internal/notification/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Request': '1',
      ...hmacHeaders,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`VPS /internal/notification/send responded ${res.status}`);
  }
}
