// src/lib/notifications.ts
// Phase52h: In-App通知ヘルパー（fire-and-forget）

import { getPool } from './db';

export async function createNotification(params: {
  recipientRole: 'super_admin' | 'client_admin';
  recipientTenantId?: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO notifications (recipient_role, recipient_tenant_id, type, title, message, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.recipientRole,
        params.recipientTenantId ?? null,
        params.type,
        params.title,
        params.message,
        params.link ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ],
    );
  } catch (e) {
    console.error('[Notification] Failed to create:', e);
  }
}

/**
 * 同じ type + metadata[key]=value の通知が既に存在するか確認する。
 * 重複通知防止のため analytics トリガーで使用する。
 */
export async function notificationExists(
  type: string,
  metadataKey: string,
  metadataValue: string,
): Promise<boolean> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM notifications
       WHERE type = $1 AND jsonb_extract_path_text(metadata, $2) = $3
       LIMIT 1`,
      [type, metadataKey, metadataValue],
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
