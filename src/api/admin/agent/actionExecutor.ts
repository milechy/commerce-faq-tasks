// src/api/admin/agent/actionExecutor.ts
// Phase B-Admin: 10ツールのアクション実行（tenantId は引数固定 — body禁止）

import { Pool, PoolClient } from 'pg';
import { logger } from '../../../lib/logger';
import {
  insertEmbeddingAsync,
  upsertToEsAsync,
} from '../knowledge/faqCrudRoutes';

// ---------------------------------------------------------------------------
// Avatar activate（avatar/routes.ts は無改変、ここで再実装）
// ---------------------------------------------------------------------------

export async function activateAvatarConfig(
  client: PoolClient,
  id: string,
  tenantId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.query('BEGIN');

    // 全て deactivate
    await client.query(
      'UPDATE avatar_configs SET is_active = false WHERE tenant_id = $1',
      [tenantId]
    );

    // 対象を activate
    const result = await client.query(
      'UPDATE avatar_configs SET is_active = true WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '設定が見つかりません' };
    }

    // tenants.features.avatar を true に同期
    await client.query(
      "UPDATE tenants SET features = jsonb_set(COALESCE(features, '{}'), '{avatar}', 'true') WHERE id = $1",
      [tenantId]
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// メインエントリ
// ---------------------------------------------------------------------------

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Pool
): Promise<string> {
  // 結果は500字以内日本語
  const truncate = (s: string) => s.slice(0, 500);

  switch (toolName) {
    // -----------------------------------------------------------------------
    case 'get_tenant_settings': {
      try {
        const result = await db.query(
          'SELECT ga4_measurement_id, posthog_host, widget_theme FROM tenants WHERE id = $1',
          [tenantId]
        );
        if (result.rows.length === 0) {
          return truncate('テナント設定が見つかりません');
        }
        const row = result.rows[0] as {
          ga4_measurement_id: string | null;
          posthog_host: string | null;
          widget_theme: Record<string, unknown> | null;
        };
        return truncate(
          `現在の設定:\n` +
          `• GA4 Measurement ID: ${row.ga4_measurement_id ?? '未設定'}\n` +
          `• PostHog ホスト: ${row.posthog_host ?? '未設定'}\n` +
          `• ウィジェットテーマ: ${JSON.stringify(row.widget_theme ?? {})}`
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_tenant_settings failed', err);
        return truncate('設定の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'set_ga4_id': {
      const measurementId = String(args['measurement_id'] ?? '');
      if (!/^G-[A-Z0-9]+$/.test(measurementId)) {
        return truncate(`GA4 Measurement ID の形式が不正です。G-XXXX形式で指定してください（例: G-ABC123）`);
      }
      try {
        await db.query(
          'UPDATE tenants SET ga4_measurement_id = $1 WHERE id = $2',
          [measurementId, tenantId]
        );
        return truncate(`GA4 Measurement ID を ${measurementId} に設定しました`);
      } catch (err) {
        logger.warn('[actionExecutor] set_ga4_id failed', err);
        return truncate('GA4 ID の設定に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'set_posthog': {
      const host = String(args['host'] ?? '');
      if (!host.startsWith('http')) {
        return truncate('PostHog ホスト URL は http:// または https:// で始まる必要があります');
      }
      try {
        await db.query(
          'UPDATE tenants SET posthog_host = $1 WHERE id = $2',
          [host, tenantId]
        );
        return truncate(`PostHog ホストを ${host} に設定しました`);
      } catch (err) {
        logger.warn('[actionExecutor] set_posthog failed', err);
        return truncate('PostHog ホストの設定に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_faq_list': {
      try {
        const limit = Math.min(Math.max(Number(args['limit'] ?? 10), 1), 20);
        const search = typeof args['search'] === 'string' ? args['search'] : undefined;

        const params: unknown[] = [tenantId];
        let whereClause = 'WHERE tenant_id = $1';

        if (search) {
          params.push(`%${search}%`);
          whereClause += ` AND (question ILIKE $${params.length} OR answer ILIKE $${params.length})`;
        }

        params.push(limit);
        const result = await db.query(
          `SELECT id, question, answer FROM faq_docs ${whereClause} ORDER BY created_at DESC LIMIT $${params.length}`,
          params
        );

        if (result.rows.length === 0) {
          return truncate('FAQ が登録されていません');
        }

        // anti-slop: answer は .slice(0,200) 必須 / console.log で内容出力禁止
        const lines = (result.rows as { id: number; question: string; answer: string }[])
          .map((r) => `[${r.id}] ${r.question} — ${r.answer.slice(0, 200)}`);
        return truncate(`FAQ 一覧（${result.rows.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_faq_list failed', err);
        return truncate('FAQ 一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'add_faq': {
      const question = String(args['question'] ?? '').slice(0, 500);
      const answer = String(args['answer'] ?? '').slice(0, 2000);
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (!question || !answer) {
        return truncate('question と answer は必須です');
      }

      try {
        const result = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, question, answer, is_published`,
          [tenantId, question, answer, category]
        );
        const row = result.rows[0] as { id: number; question: string; answer: string; is_published: boolean };

        // embedding / ES 同期（fire-and-forget）
        insertEmbeddingAsync(db, tenantId, `${row.question}\n${row.answer}`, row.id, {
          source: 'admin_agent',
          faq_id: row.id,
        });
        upsertToEsAsync(tenantId, row.id, row.question, row.answer, row.is_published);

        return truncate(`FAQ を追加しました（ID: ${row.id}）: ${row.question}`);
      } catch (err) {
        logger.warn('[actionExecutor] add_faq failed', err);
        return truncate('FAQ の追加に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'update_faq': {
      const id = Number(args['id']);
      const question = String(args['question'] ?? '').slice(0, 500);
      const answer = String(args['answer'] ?? '').slice(0, 2000);

      if (!Number.isFinite(id) || !question || !answer) {
        return truncate('id・question・answer は必須です');
      }

      try {
        // テナント確認
        const check = await db.query(
          'SELECT id, tenant_id FROM faq_docs WHERE id = $1',
          [id]
        );
        if (check.rows.length === 0) {
          return truncate(`FAQ（ID: ${id}）が見つかりません`);
        }
        const existing = check.rows[0] as { tenant_id: string };
        if (existing.tenant_id !== tenantId) {
          return truncate('この FAQ へのアクセス権限がありません');
        }

        const updateResult = await db.query(
          `UPDATE faq_docs SET question = $1, answer = $2, updated_at = NOW()
           WHERE id = $3 AND tenant_id = $4
           RETURNING id, question, answer, is_published`,
          [question, answer, id, tenantId]
        );
        const updated = updateResult.rows[0] as {
          id: number; question: string; answer: string; is_published: boolean;
        };

        // 古い embedding 削除 → 再挿入（best-effort）
        db.query(
          `DELETE FROM faq_embeddings WHERE tenant_id = $1 AND (metadata->>'faq_id')::bigint = $2`,
          [tenantId, id]
        ).catch(() => {});
        insertEmbeddingAsync(db, tenantId, `${updated.question}\n${updated.answer}`, updated.id, {
          source: 'admin_agent',
          faq_id: updated.id,
        });
        upsertToEsAsync(tenantId, updated.id, updated.question, updated.answer, updated.is_published);

        return truncate(`FAQ（ID: ${id}）を更新しました: ${updated.question}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_faq failed', err);
        return truncate('FAQ の更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'delete_faq': {
      const id = Number(args['id']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate(`FAQ（ID: ${id}）の削除には確認が必要です。confirmed=true を指定して再度実行してください`);
      }

      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      try {
        const check = await db.query(
          'SELECT id, tenant_id, question FROM faq_docs WHERE id = $1',
          [id]
        );
        if (check.rows.length === 0) {
          return truncate(`FAQ（ID: ${id}）が見つかりません`);
        }
        const existing = check.rows[0] as { tenant_id: string; question: string };
        if (existing.tenant_id !== tenantId) {
          return truncate('この FAQ へのアクセス権限がありません');
        }

        await db.query(
          `DELETE FROM faq_embeddings WHERE tenant_id = $1 AND (metadata->>'faq_id')::bigint = $2`,
          [tenantId, id]
        );
        await db.query('DELETE FROM faq_docs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);

        return truncate(`FAQ（ID: ${id}）を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_faq failed', err);
        return truncate('FAQ の削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'activate_avatar': {
      const id = String(args['id'] ?? '');
      if (!id) {
        return truncate('id は必須です');
      }

      const client = await db.connect();
      try {
        const res = await activateAvatarConfig(client, id, tenantId);
        if (!res.ok) {
          return truncate(`アバターの有効化に失敗しました: ${res.error ?? '不明なエラー'}`);
        }
        return truncate(`アバター（ID: ${id}）を有効化しました`);
      } catch (err) {
        logger.warn('[actionExecutor] activate_avatar failed', err);
        return truncate('アバターの有効化に失敗しました');
      } finally {
        client.release();
      }
    }

    // -----------------------------------------------------------------------
    case 'get_embed_code': {
      try {
        // 平文 API キーは保存されていないため key_prefix のみ返す
        const result = await db.query(
          'SELECT key_prefix FROM tenant_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
          [tenantId]
        );
        const keyPrefix: string = result.rows.length > 0
          ? String((result.rows[0] as { key_prefix: string }).key_prefix)
          : '（キー未発行）';

        return truncate(
          `ウィジェット埋め込みコードのひな形:\n\n` +
          `<script src="https://api.r2c.biz/widget.js" data-api-key="YOUR_API_KEY"></script>\n\n` +
          `現在のAPIキー先頭: ${keyPrefix}...\n` +
          `※ 実際のAPIキーは発行時のみ表示されます。再確認が必要な場合は新しいキーを発行してください`
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_embed_code failed', err);
        return truncate('埋め込みコードの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'set_widget_theme': {
      const theme = args['theme'];
      if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) {
        return truncate('theme はオブジェクト形式で指定してください（例: {"primaryColor": "#3B82F6"}）');
      }

      try {
        await db.query(
          `UPDATE tenants SET widget_theme = COALESCE(widget_theme, '{}') || $1::jsonb WHERE id = $2`,
          [JSON.stringify(theme), tenantId]
        );
        return truncate(`ウィジェットテーマを更新しました: ${JSON.stringify(theme)}`);
      } catch (err) {
        logger.warn('[actionExecutor] set_widget_theme failed', err);
        return truncate('ウィジェットテーマの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    default:
      return truncate(`不明なツール: ${toolName}`);
  }
}
