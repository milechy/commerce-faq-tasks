import { callGa4HealthCheckAll } from '../lib/vpsApiClient';
import { sendEmail } from '../lib/emailSender';
import type { Env, Ga4TenantHealthResult } from '../types';

const ERROR_STATUSES = new Set(['error', 'timeout', 'permission_revoked']);

// In-memory dedupe: tenantId → last notification timestamp (ms)
// Resets on Worker process restart; notifications throttled to once per hour per tenant
const lastNotifiedAt = new Map<string, number>();
const NOTIFY_INTERVAL_MS = 60 * 60 * 1000;

export async function runGa4HealthCheckCron(env: Env): Promise<void> {
  console.log('[ga4HealthCheckHandler] starting cron run');

  let results: Ga4TenantHealthResult[];
  try {
    results = await callGa4HealthCheckAll(env);
  } catch (err) {
    console.error('[ga4HealthCheckHandler] VPS call failed:', err);
    await notifyAdminError(env, `GA4ヘルスチェックCron実行エラー\n\n${String(err)}`);
    return;
  }

  console.log(`[ga4HealthCheckHandler] checked ${results.length} tenants`);

  const now = Date.now();
  for (const result of results) {
    if (!ERROR_STATUSES.has(result.status)) continue;

    const lastNotified = lastNotifiedAt.get(result.tenant_id) ?? 0;
    if (now - lastNotified < NOTIFY_INTERVAL_MS) {
      console.log(`[ga4HealthCheckHandler] skip duplicate notification for ${result.tenant_id}`);
      continue;
    }

    lastNotifiedAt.set(result.tenant_id, now);
    await notifyTenantError(env, result);
  }
}

async function notifyTenantError(env: Env, result: Ga4TenantHealthResult): Promise<void> {
  const to = env.ALERT_EMAIL_TO;
  const subject = `[R2C] GA4連携エラー検知 (tenant: ${result.tenant_id})`;
  const body = [
    'GA4連携エラーが検知されました。',
    '',
    `テナントID: ${result.tenant_id}`,
    `エラーステータス: ${result.status}`,
    `エラー内容: ${result.error_message ?? '(詳細なし)'}`,
    '',
    '対処方法:',
    '1. Admin UI → テナント詳細 → 📊 GA4連携 タブを開く',
    '2. 「接続テスト」を実行してエラー詳細を確認する',
    '3. 必要に応じてサービスアカウントのGA4プロパティへのアクセス権を再設定する',
    '',
    `確認URL: https://admin.r2c.biz/admin/tenants/${result.tenant_id}`,
    '',
    '---',
    'このメールはR2CシステムのCloudflare Workersから自動送信されています。',
  ].join('\n');

  try {
    await sendEmail(env, { to, subject, body });
    console.log(`[ga4HealthCheckHandler] error notification sent for ${result.tenant_id}`);
  } catch (err) {
    console.error(`[ga4HealthCheckHandler] email send failed for ${result.tenant_id}:`, err);
  }
}

async function notifyAdminError(env: Env, message: string): Promise<void> {
  try {
    await sendEmail(env, {
      to: env.ALERT_EMAIL_TO,
      subject: '[R2C] GA4 Cronワーカーエラー',
      body: message,
    });
  } catch (err) {
    console.error('[ga4HealthCheckHandler] admin error notification failed:', err);
  }
}
