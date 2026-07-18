// src/api/admin/agent/actionExecutor.ts
// Phase B-Admin: 10ツールのアクション実行（tenantId は引数固定 — body禁止）

import { Pool, PoolClient } from 'pg';
import { logger } from '../../../lib/logger';
import {
  insertEmbeddingAsync,
  upsertToEsAsync,
} from '../knowledge/faqCrudRoutes';
import { callGroq8bSuggestFromText } from '../tuning/routes';
import { listRules, createRule, updateRule, deleteRule, type ApprovedResponse } from '../tuning/tuningRulesRepository';
import { generateTestResponses } from '../tuning/testResponseRoutes';
import { searchKnowledgeForSuggestion, formatKnowledgeContext } from '../../../lib/knowledgeSearchUtil';
import { getGaps, updateGapStatus } from '../knowledge/knowledgeGapRepository';
import { textToFaqs } from '../knowledge/routes';
import { suggestEngagementRuleFromText } from './engagementSuggest';
import { getSessions, getActiveEscalations } from '../chat-history/chatHistoryRepository';
import { computeKpis } from '../monitoring/routes';

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
  db: Pool,
  isSuperAdmin: boolean = false
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
    case 'suggest_tuning_rule': {
      const freeText = String(args['free_text'] ?? '').trim();
      if (!freeText) {
        return truncate('free_text は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const [knowledgeCtx, existingRules] = await Promise.all([
          searchKnowledgeForSuggestion(tenantId, freeText).catch(() => ({ results: [] })),
          listRules(tenantId).catch(() => []),
        ]);
        const knowledgeSection = formatKnowledgeContext(knowledgeCtx);
        const existingRulesSection = existingRules
          .filter((r) => r.is_active)
          .map((r) => `- [${r.trigger_pattern}] ${r.expected_behavior}`)
          .join('\n');

        const suggestion = await callGroq8bSuggestFromText(freeText, knowledgeSection, existingRulesSection);

        if (!suggestion.trigger_pattern && !suggestion.instruction) {
          return truncate('提案の生成に失敗しました。もう少し具体的に教えてください');
        }

        return truncate(
          `提案:\n` +
          `トリガー: ${suggestion.trigger_pattern || '（常時適用）'}\n` +
          `対応方針: ${suggestion.instruction}\n` +
          `優先度: ${suggestion.priority}\n` +
          (suggestion.reason ? `理由: ${suggestion.reason}\n` : '') +
          `\nこの内容でよいかユーザーに確認し、同意が得られたら save_tuning_rule を呼び出してください（trigger_pattern/expected_behavior/priority は上記の提案値を使うこと）。`
        );
      } catch (err) {
        logger.warn('[actionExecutor] suggest_tuning_rule failed', err);
        return truncate('ルールの提案に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'save_tuning_rule': {
      const confirmed = Boolean(args['confirmed']);
      const triggerPattern = String(args['trigger_pattern'] ?? '').slice(0, 1000);
      const expectedBehavior = String(args['expected_behavior'] ?? '').slice(0, 4000);
      const priorityRaw = Number(args['priority']);
      const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.min(10, Math.round(priorityRaw))) : 5;

      if (!confirmed) {
        return truncate('ルールの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!triggerPattern || !expectedBehavior) {
        return truncate('trigger_pattern と expected_behavior は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const rule = await createRule({
          tenant_id: tenantId,
          trigger_pattern: triggerPattern,
          expected_behavior: expectedBehavior,
          priority,
          created_by: 'admin_agent',
        });
        return truncate(`指示ルールを保存しました（ID: ${rule.id}）: 「${rule.trigger_pattern}」→ ${rule.expected_behavior}`);
      } catch (err) {
        logger.warn('[actionExecutor] save_tuning_rule failed', err);
        return truncate('ルールの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_tuning_rules': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const rules = await listRules(tenantId);
        if (rules.length === 0) {
          return truncate('有効な指示ルールはありません');
        }
        const lines = rules.slice(0, 15).map((r) =>
          `[${r.id}]${r.is_active ? '' : '(無効)'} 「${r.trigger_pattern.slice(0, 60)}」→ ${r.expected_behavior.slice(0, 100)}`
        );
        return truncate(`指示ルール一覧（${rules.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_tuning_rules failed', err);
        return truncate('指示ルール一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'update_tuning_rule': {
      const id = Number(args['id']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate(`指示ルール（ID: ${id}）の更新には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      const triggerPattern = typeof args['trigger_pattern'] === 'string' ? args['trigger_pattern'].slice(0, 1000) : undefined;
      const expectedBehavior = typeof args['expected_behavior'] === 'string' ? args['expected_behavior'].slice(0, 4000) : undefined;
      const isActive = typeof args['is_active'] === 'boolean' ? args['is_active'] : undefined;

      if (triggerPattern === undefined && expectedBehavior === undefined && isActive === undefined) {
        return truncate('変更する内容がありません（trigger_pattern・expected_behavior・is_active のいずれかを指定してください）');
      }

      try {
        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const updated = await updateRule(
          id,
          { trigger_pattern: triggerPattern, expected_behavior: expectedBehavior, is_active: isActive },
          ownerFilter,
        );
        if (!updated) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`指示ルール（ID: ${id}）を更新しました: 「${updated.trigger_pattern}」${updated.is_active ? '' : '（現在無効）'}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_tuning_rule failed', err);
        return truncate('指示ルールの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'delete_tuning_rule': {
      const id = Number(args['id']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate(`指示ルール（ID: ${id}）の削除には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      try {
        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const ok = await deleteRule(id, ownerFilter);
        if (!ok) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`指示ルール（ID: ${id}）を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_tuning_rule failed', err);
        return truncate('指示ルールの削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'generate_tuning_rule_test_responses': {
      const id = Number(args['id']);
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      try {
        const result = await generateTestResponses(id, tenantId ?? '', isSuperAdmin);
        if (!result.ok) {
          switch (result.reason) {
            case 'not_found':
              return truncate(`指示ルール（ID: ${id}）が見つかりません`);
            case 'forbidden':
              return truncate('このルールへのアクセス権限がありません');
            case 'no_api_key':
              return truncate('テスト応答の生成機能が現在利用できません');
            case 'llm_error':
              return truncate('LLMとの通信に失敗しました。もう一度お試しください');
            case 'invalid_output':
              return truncate('テスト応答の生成に失敗しました。もう一度お試しください');
          }
        }
        const lines = result.responses.map((r, i) => `${i + 1}. [${r.style}] ${r.text.slice(0, 200)}`);
        return truncate(
          `テスト応答案（ルールID: ${id}）:\n` + lines.join('\n') +
          '\n\n採用する場合はユーザーに確認の上、approve_tuning_rule_response で保存してください。',
        );
      } catch (err) {
        logger.warn('[actionExecutor] generate_tuning_rule_test_responses failed', err);
        return truncate('テスト応答の生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'approve_tuning_rule_response': {
      const id = Number(args['id']);
      const text = String(args['text'] ?? '').trim().slice(0, 4000);
      const style = String(args['style'] ?? '').trim().slice(0, 50);
      const reason = typeof args['reason'] === 'string' ? args['reason'].trim().slice(0, 1000) || undefined : undefined;
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate('返答の採用には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!Number.isFinite(id) || !text || !style) {
        return truncate('id・text・style は必須です');
      }

      try {
        const existing = await db.query('SELECT tenant_id, approved_responses FROM tuning_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`指示ルール（ID: ${id}）が見つかりません`);
        }
        const row = existing.rows[0] as { tenant_id: string; approved_responses: ApprovedResponse[] | null };
        if (!isSuperAdmin && row.tenant_id !== tenantId) {
          return truncate('このルールへのアクセス権限がありません');
        }

        const current = row.approved_responses ?? [];
        const next: ApprovedResponse[] = [...current, { text, style, reason, approved_at: new Date().toISOString() }];

        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const updated = await updateRule(id, { approved_responses: next }, ownerFilter);
        if (!updated) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`返答を採用しました（ルールID: ${id}、現在${next.length}件採用済み）: 「${text.slice(0, 100)}」`);
      } catch (err) {
        logger.warn('[actionExecutor] approve_tuning_rule_response failed', err);
        return truncate('返答の採用に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'remove_approved_response': {
      const id = Number(args['id']);
      const index = Number(args['index']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate('採用済み返答の取消には確認が必要です。confirmed=true を指定して再度実行してください');
      }
      if (!Number.isFinite(id) || !Number.isFinite(index) || index < 0) {
        return truncate('id・index が不正です');
      }

      try {
        const existing = await db.query('SELECT tenant_id, approved_responses FROM tuning_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`指示ルール（ID: ${id}）が見つかりません`);
        }
        const row = existing.rows[0] as { tenant_id: string; approved_responses: ApprovedResponse[] | null };
        if (!isSuperAdmin && row.tenant_id !== tenantId) {
          return truncate('このルールへのアクセス権限がありません');
        }

        const current = row.approved_responses ?? [];
        if (index >= current.length) {
          return truncate(`採用済み返答（${current.length}件）に index ${index} は存在しません`);
        }
        const next = current.filter((_, i) => i !== index);

        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const updated = await updateRule(id, { approved_responses: next }, ownerFilter);
        if (!updated) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`採用済み返答を取り消しました（ルールID: ${id}、残り${next.length}件）`);
      } catch (err) {
        logger.warn('[actionExecutor] remove_approved_response failed', err);
        return truncate('採用済み返答の取消に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase2 (P7 プロアクティブ・ブリーフィング): 直近7日間の状況を1回で要約取得する
    // 読み取り専用ツール。ログイン直後など能動的な状況説明に使う。
    case 'get_weekly_briefing': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const [sessionsRes, prevSessionsRes, evalRes, cvRes, gapsRes] = await Promise.all([
          db.query(
            `SELECT COUNT(*)::int AS n FROM chat_sessions
             WHERE tenant_id = $1 AND started_at >= NOW() - INTERVAL '7 days'`,
            [tenantId],
          ),
          db.query(
            `SELECT COUNT(*)::int AS n FROM chat_sessions
             WHERE tenant_id = $1
               AND started_at >= NOW() - INTERVAL '14 days'
               AND started_at < NOW() - INTERVAL '7 days'`,
            [tenantId],
          ),
          db.query(
            `SELECT AVG(score) AS avg FROM conversation_evaluations
             WHERE tenant_id = $1 AND evaluated_at >= NOW() - INTERVAL '7 days' AND score > 0`,
            [tenantId],
          ),
          db.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(conversion_value), 0)::numeric AS total
             FROM conversion_attributions
             WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
            [tenantId],
          ),
          getGaps({ tenantId, status: 'open', limit: 3 }),
        ]);

        const totalSessions = Number(sessionsRes.rows[0]?.n ?? 0);
        const prevSessions = Number(prevSessionsRes.rows[0]?.n ?? 0);
        const changePct = prevSessions > 0 ? Math.round(((totalSessions - prevSessions) / prevSessions) * 100) : null;
        const avgScoreRaw = evalRes.rows[0]?.avg;
        const avgScore = avgScoreRaw != null ? Math.round(Number(avgScoreRaw)) : null;
        const cvCount = Number(cvRes.rows[0]?.n ?? 0);
        const cvTotal = Math.round(Number(cvRes.rows[0]?.total ?? 0));
        const { gaps, total: gapsTotal } = gapsRes;

        const lines: string[] = ['直近7日間の状況:'];
        lines.push(
          `会話数 ${totalSessions}件` +
          (changePct !== null ? `（前週比 ${changePct >= 0 ? '+' : ''}${changePct}%）` : ''),
        );
        if (avgScore !== null) lines.push(`応答品質スコア ${avgScore}/100`);
        lines.push(`成約 ${cvCount}件・¥${cvTotal.toLocaleString('ja-JP')}`);
        lines.push(`AIが答えられなかった質問 ${gapsTotal}件（未対応の累計）`);
        if (gaps.length > 0) {
          lines.push('うち上位:');
          gaps.forEach((g, i) => {
            lines.push(`${i + 1}. 「${g.user_question.slice(0, 60)}」`);
          });
        }

        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_weekly_briefing failed', err);
        return truncate('週次サマリーの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_knowledge_gaps': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const limit = Math.min(Math.max(Number(args['limit'] ?? 10), 1), 20);

      try {
        const { gaps, total } = await getGaps({ tenantId, status: 'open', limit });
        if (gaps.length === 0) {
          return truncate('未対応の知識ギャップはありません');
        }
        const lines = gaps.map((g) => `[${g.id}] ${g.user_question.slice(0, 100)}（${g.rag_hit_count}件ヒット）`);
        return truncate(`知識ギャップ一覧（未対応${total}件中${gaps.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_knowledge_gaps failed', err);
        return truncate('知識ギャップ一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'dismiss_knowledge_gap': {
      const id = Number(args['id']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate(`知識ギャップ（ID: ${id}）を片付けるには確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const ok = await updateGapStatus(id, 'dismissed', tenantId, null);
        if (!ok) {
          return truncate(`知識ギャップ（ID: ${id}）が見つかりません`);
        }
        return truncate(`知識ギャップ（ID: ${id}）を「対応不要」として片付けました`);
      } catch (err) {
        logger.warn('[actionExecutor] dismiss_knowledge_gap failed', err);
        return truncate('知識ギャップの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: suggest_faq — 自然文からFAQ下書きを生成する読み取り専用ツール
    case 'suggest_faq': {
      const freeText = String(args['free_text'] ?? '').trim();
      if (!freeText) return truncate('free_text は必須です');
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const existing = await db.query(
          `SELECT question FROM faq_docs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 40`,
          [tenantId],
        );
        const existingQuestions = (existing.rows as { question: string }[]).map((r) => r.question);

        const faqs = await textToFaqs(freeText, undefined, existingQuestions);
        if (faqs.length === 0) {
          return truncate('FAQの下書き生成に失敗しました。もう少し具体的に教えてください');
        }

        const top = faqs[0]!;
        const lines = [
          '提案:',
          `質問: ${top.question}`,
          `回答: ${top.answer}`,
          `分類: ${top.category ?? '(自動判定)'}`,
        ];
        if (faqs.length > 1) lines.push(`（他に${faqs.length - 1}件の候補も生成されました。必要なら伝えてください）`);
        lines.push('この内容でよいかユーザーに確認し、同意が得られたら save_faq を呼び出してください（question/answer/category は上記の提案値を使うこと）。');

        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_faq failed', err);
        return truncate('FAQの下書き生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: save_faq — confirmedゲート必須のFAQ保存(add_faqと同じINSERT経路)
    case 'save_faq': {
      const confirmed = Boolean(args['confirmed']);
      const question = String(args['question'] ?? '').slice(0, 500);
      const answer = String(args['answer'] ?? '').slice(0, 2000);
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (!confirmed) {
        return truncate('FAQの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!question || !answer) {
        return truncate('question と answer は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const result = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, question, answer, is_published`,
          [tenantId, question, answer, category],
        );
        const row = result.rows[0] as { id: number; question: string; answer: string; is_published: boolean };

        insertEmbeddingAsync(db, tenantId, `${row.question}\n${row.answer}`, row.id, {
          source: 'admin_agent',
          faq_id: row.id,
        });
        upsertToEsAsync(tenantId, row.id, row.question, row.answer, row.is_published);

        return truncate(`FAQを保存しました（ID: ${row.id}）: ${row.question}`);
      } catch (err) {
        logger.warn('[actionExecutor] save_faq failed', err);
        return truncate('FAQの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: suggest_engagement_rule — 自然文から声がけルールの下書きを生成する読み取り専用ツール
    case 'suggest_engagement_rule': {
      const freeText = String(args['free_text'] ?? '').trim();
      if (!freeText) return truncate('free_text は必須です');
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const suggestion = await suggestEngagementRuleFromText(freeText);
        if (!suggestion.message_template) {
          return truncate('声がけの下書き生成に失敗しました。もう少し具体的に教えてください');
        }

        const lines = [
          '提案:',
          `トリガー種別: ${suggestion.trigger_type}`,
          `トリガー設定: ${JSON.stringify(suggestion.trigger_config)}`,
          `表示文言: ${suggestion.message_template}`,
          `優先度: ${suggestion.priority}`,
        ];
        if (suggestion.reason) lines.push(`理由: ${suggestion.reason}`);
        lines.push('この内容でよいかユーザーに確認し、同意が得られたら save_engagement_rule を呼び出してください（trigger_type/trigger_config/message_template/priority は上記の提案値を使うこと）。');

        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_engagement_rule failed', err);
        return truncate('声がけの下書き生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: save_engagement_rule — confirmedゲート必須の声がけルール保存(trigger_rules)
    case 'save_engagement_rule': {
      const confirmed = Boolean(args['confirmed']);
      const triggerType = String(args['trigger_type'] ?? '');
      const messageTemplate = String(args['message_template'] ?? '').slice(0, 500);
      const priorityRaw = Number(args['priority']);
      const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.min(100, Math.round(priorityRaw))) : 0;
      const triggerConfigRaw = args['trigger_config'];

      const VALID_TYPES = new Set(['scroll_depth', 'idle_time', 'exit_intent', 'page_url_match']);

      if (!confirmed) {
        return truncate('声がけルールの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!VALID_TYPES.has(triggerType)) {
        return truncate('trigger_type が不正です（scroll_depth/idle_time/exit_intent/page_url_match のいずれか）');
      }
      if (!messageTemplate) {
        return truncate('message_template は必須です');
      }
      if (typeof triggerConfigRaw !== 'object' || triggerConfigRaw === null || Array.isArray(triggerConfigRaw)) {
        return truncate('trigger_config はオブジェクト形式で指定してください');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const result = await db.query(
          `INSERT INTO trigger_rules (tenant_id, trigger_type, trigger_config, message_template, is_active, priority)
           VALUES ($1, $2, $3, $4, true, $5)
           RETURNING id, trigger_type, message_template`,
          [tenantId, triggerType, JSON.stringify(triggerConfigRaw), messageTemplate, priority],
        );
        const row = result.rows[0] as { id: number; trigger_type: string; message_template: string };

        return truncate(`声がけルールを保存しました（ID: ${row.id}）: 「${row.trigger_type}」→ ${row.message_template}`);
      } catch (err) {
        logger.warn('[actionExecutor] save_engagement_rule failed', err);
        return truncate('声がけルールの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_engagement_rules': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const result = await db.query(
          `SELECT id, trigger_type, message_template, is_active, priority
           FROM trigger_rules WHERE tenant_id = $1
           ORDER BY priority DESC, created_at DESC LIMIT 15`,
          [tenantId],
        );
        if (result.rows.length === 0) {
          return truncate('声がけルールは登録されていません');
        }
        const lines = (result.rows as { id: number; trigger_type: string; message_template: string; is_active: boolean; priority: number }[]).map(
          (r) => `[${r.id}]${r.is_active ? '' : '(無効)'} ${r.trigger_type} → ${r.message_template.slice(0, 80)}`,
        );
        return truncate(`声がけルール一覧（${result.rows.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_engagement_rules failed', err);
        return truncate('声がけルール一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'update_engagement_rule': {
      const id = Number(args['id']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate(`声がけルール（ID: ${id}）の更新には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const VALID_TRIGGER_TYPES = new Set(['scroll_depth', 'idle_time', 'exit_intent', 'page_url_match']);
      const triggerTypeRaw = args['trigger_type'];
      if (triggerTypeRaw !== undefined && !VALID_TRIGGER_TYPES.has(String(triggerTypeRaw))) {
        return truncate('trigger_type が不正です（scroll_depth/idle_time/exit_intent/page_url_match のいずれか）');
      }
      const triggerType = typeof triggerTypeRaw === 'string' ? triggerTypeRaw : undefined;
      const triggerConfigRaw = args['trigger_config'];
      const triggerConfig =
        typeof triggerConfigRaw === 'object' && triggerConfigRaw !== null && !Array.isArray(triggerConfigRaw)
          ? triggerConfigRaw
          : undefined;
      const messageTemplate = typeof args['message_template'] === 'string' ? args['message_template'].slice(0, 500) : undefined;
      const priorityRaw = args['priority'];
      const priority =
        typeof priorityRaw === 'number' && Number.isFinite(priorityRaw)
          ? Math.max(0, Math.min(100, Math.round(priorityRaw)))
          : undefined;
      const isActive = typeof args['is_active'] === 'boolean' ? args['is_active'] : undefined;

      if (triggerType === undefined && triggerConfig === undefined && messageTemplate === undefined && priority === undefined && isActive === undefined) {
        return truncate('変更する内容がありません（trigger_type・trigger_config・message_template・priority・is_active のいずれかを指定してください）');
      }

      try {
        const existing = await db.query('SELECT id, tenant_id FROM trigger_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`声がけルール（ID: ${id}）が見つかりません`);
        }
        if (!isSuperAdmin && (existing.rows[0] as { tenant_id: string }).tenant_id !== tenantId) {
          return truncate('この声がけルールへのアクセス権限がありません');
        }

        const result = await db.query(
          `UPDATE trigger_rules SET
             trigger_type   = COALESCE($1, trigger_type),
             trigger_config = COALESCE($2::jsonb, trigger_config),
             message_template = COALESCE($3, message_template),
             priority       = COALESCE($4, priority),
             is_active      = COALESCE($5, is_active)
           WHERE id = $6
           RETURNING id, trigger_type, message_template, is_active`,
          [
            triggerType ?? null,
            triggerConfig ? JSON.stringify(triggerConfig) : null,
            messageTemplate ?? null,
            priority ?? null,
            isActive ?? null,
            id,
          ],
        );
        const row = result.rows[0] as { id: number; trigger_type: string; message_template: string; is_active: boolean };
        return truncate(`声がけルール（ID: ${id}）を更新しました: 「${row.trigger_type}」→ ${row.message_template}${row.is_active ? '' : '（現在無効）'}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_engagement_rule failed', err);
        return truncate('声がけルールの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'delete_engagement_rule': {
      const id = Number(args['id']);
      const confirmed = Boolean(args['confirmed']);

      if (!confirmed) {
        return truncate(`声がけルール（ID: ${id}）の削除には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const existing = await db.query('SELECT id, tenant_id FROM trigger_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`声がけルール（ID: ${id}）が見つかりません`);
        }
        if (!isSuperAdmin && (existing.rows[0] as { tenant_id: string }).tenant_id !== tenantId) {
          return truncate('この声がけルールへのアクセス権限がありません');
        }

        await db.query('DELETE FROM trigger_rules WHERE id = $1', [id]);
        return truncate(`声がけルール（ID: ${id}）を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_engagement_rule failed', err);
        return truncate('声がけルールの削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_chat_sessions': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const limit = Math.min(Math.max(Number(args['limit'] ?? 10), 1), 20);

      try {
        const { sessions, total } = await getSessions({ tenantId, limit });
        if (sessions.length === 0) {
          return truncate('会話セッションはありません');
        }
        const lines = sessions.map(
          (s) => `[${s.session_id.slice(0, 8)}] ${s.started_at.slice(0, 10)} (${s.message_count}件) 「${s.first_message_preview}」`,
        );
        return truncate(`会話セッション一覧（全${total}件中${sessions.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_chat_sessions failed', err);
        return truncate('会話セッション一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_escalations': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const escalations = await getActiveEscalations(tenantId);
        if (escalations.length === 0) {
          return truncate('対応中のエスカレーションはありません');
        }
        const lines = escalations.map(
          (e) => `[${e.session_id.slice(0, 8)}] ${e.escalated_at.slice(0, 16).replace('T', ' ')} 「${e.first_message_preview}」`,
        );
        return truncate(`対応中のエスカレーション（${escalations.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_escalations failed', err);
        return truncate('エスカレーション一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_monitoring_summary': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const kpis = await computeKpis(db, tenantId);
        return truncate(
          `直近30日間のサマリー:\n会話数 ${kpis.totalSessions}件\n完了率 ${kpis.completionRate}%\nフォールバック率（AIが答えられなかった割合） ${kpis.fallbackRate}%`,
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_monitoring_summary failed', err);
        return truncate('モニタリングサマリーの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    default:
      return truncate(`不明なツール: ${toolName}`);
  }
}
