import type { Env } from '../types';

const FROM_ADDRESS = 'noreply@r2c.biz';
const FROM_NAME = 'R2C System';

export interface EmailOptions {
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(env: Env, opts: EmailOptions): Promise<void> {
  const raw = buildRawEmail(opts.to, opts.subject, opts.body);
  const message = new EmailMessage(FROM_ADDRESS, opts.to, raw);
  await env.EMAIL.send(message);
}

function buildRawEmail(to: string, subject: string, body: string): string {
  const date = new Date().toUTCString();
  return [
    `Date: ${date}`,
    `From: ${FROM_NAME} <${FROM_ADDRESS}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    '',
    body,
  ].join('\r\n');
}
