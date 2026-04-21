import { buildHmacHeaders } from '../lib/hmacSigner';
import { sendEmail } from '../lib/emailSender';
import type { Env } from '../types';

interface NotifyPayload {
  to: string;
  subject: string;
  body: string;
}

// POST /send-notification — called by VPS via HMAC-authenticated request
export async function handleSendNotification(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const hmacError = await verifyHmac(request.clone(), env.INTERNAL_API_HMAC_SECRET);
  if (hmacError) {
    return Response.json({ error: hmacError }, { status: 401 });
  }

  let payload: NotifyPayload;
  try {
    payload = (await request.json()) as NotifyPayload;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!payload.to || !payload.subject || !payload.body) {
    return Response.json({ error: 'missing_fields' }, { status: 400 });
  }

  try {
    await sendEmail(env, payload);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[errorNotifyHandler] send failed:', err);
    return Response.json({ error: 'send_failed', detail: String(err) }, { status: 500 });
  }
}

async function verifyHmac(request: Request, secret: string): Promise<string | null> {
  const timestamp = request.headers.get('x-hmac-timestamp');
  const signature = request.headers.get('x-hmac-signature');

  if (!timestamp || !signature) return 'missing_hmac_headers';

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return 'stale_timestamp';

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return 'invalid_body';
  }

  const message = `${timestamp}:${JSON.stringify(body)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (signature !== expected) return 'invalid_signature';
  return null;
}

// Build signed headers for outbound requests (re-exported for testing convenience)
export { buildHmacHeaders };
