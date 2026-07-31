// src/api/admin/agent/actionExecutor.ts
// Phase B-Admin: 10ツールのアクション実行（tenantId は引数固定 — body禁止）

import { Pool, PoolClient } from 'pg';
import { logger } from '../../../lib/logger';
import { getWeekRange } from '../../../lib/date/weekRange';
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
import {
  generateTextFaqPreview,
  generateScrapeFaqPreview,
  commitTextFaqs,
  commitScrapeFaqs,
} from '../../../lib/knowledge/faqImport';
import {
  setStagedFaqImport,
  getStagedFaqImport,
  clearStagedFaqImport,
  recordPlanLimitMention,
} from './knowledgeImportStaging';
import { suggestEngagementRuleFromText } from './engagementSuggest';
import { getSessions, getActiveEscalations, getMessages, saveMessage, resolveEscalation } from '../chat-history/chatHistoryRepository';
import { computeKpis } from '../monitoring/routes';
import { checkSaiMonthlyCostCeiling } from '../options/routes';
import { submitSaiTask, getSaiTask } from '../../../lib/sai/saiClient';
import { trackUsage } from '../../../lib/billing/usageTracker';
import { queryTenantPlan, planHasFeature } from '../../../lib/billing/planFeatures';
import { fetchAnalyticsSummary, fetchConversionSummary } from '../analytics/summaryQueries';
import { isOnboardingIndustry, ONBOARDING_INDUSTRY_LABELS, INDUSTRY_FAQ_TEMPLATES } from './industryFaqTemplates';

// チャットでの一括インポートで一度に生成・コミットできるFAQ数の上限。
// POST /v1/admin/knowledge/text/commit・/scrape/commit の zod スキーマ(max 20)と揃える。
const MAX_IMPORT_FAQS = 20;

// 有人返信1件の最大文字数。POST /v1/admin/chat-history/sessions/:id/reply の
// zod スキーマ(z.string().min(1).max(2000))と揃える。
const MAX_OPERATOR_REPLY_LENGTH = 2000;

// ---------------------------------------------------------------------------
// プラン制限の案内文
// ---------------------------------------------------------------------------
//
// full は他のAPI(analytics/routes.ts, tenants/routes.ts 等)と同じ文言。変更しないこと。
// 同じ会話の中で同じ機能について何度も full を返すと同じ売り込みの繰り返しになるため、
// 2回目以降は short に切り替える(制限そのものは変わらない)。判定は
// knowledgeImportStaging.ts の recordPlanLimitMention((tenantId, sessionId, feature)単位)。
type PlanLimitedFeature = 'avatar' | 'analytics' | 'conversion' | 'sai_task';

const PLAN_LIMIT_NOTICES: Record<PlanLimitedFeature, { full: string; short: string }> = {
  avatar: {
    full: 'AIアバター機能はGrowthプラン以上でご利用いただけます',
    short: 'AIアバター機能はプラン対象外のままです',
  },
  analytics: {
    full: 'この機能はGrowthプラン以上でご利用いただけます',
    short: 'この機能はプラン対象外のままです',
  },
  conversion: {
    full: 'この機能はGrowthプラン以上でご利用いただけます',
    short: 'この機能はプラン対象外のままです',
  },
  sai_task: {
    full: 'Saiへの代行依頼はEnterpriseプラン以上でご利用いただけます',
    short: 'Saiへの代行依頼はプラン対象外のままです',
  },
};

function planLimitNotice(tenantId: string, sessionId: string, feature: PlanLimitedFeature): string {
  const notice = PLAN_LIMIT_NOTICES[feature];
  return recordPlanLimitMention(tenantId, sessionId, feature) ? notice.short : notice.full;
}

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
// 会話セッションの短縮ID解決（get_chat_sessions が表示する [xxxxxxxx] を受け取る）
// ---------------------------------------------------------------------------

export type ResolveSessionResult =
  | { ok: true; session: { id: string; session_id: string } }
  | { ok: false; message: string };

/** 短縮IDの前方一致でセッションを解決する。tenant_id 条件は省略不可（越境参照防止）。 */
export async function resolveSessionByShortId(
  db: Pool,
  tenantId: string,
  input: string
): Promise<ResolveSessionResult> {
  const shortId = input.trim();
  if (!shortId) {
    return { ok: false, message: 'セッションIDを指定してください' };
  }
  // LIKE のワイルドカードを無効化し、意図しない広域一致を防ぐ（Postgres の既定エスケープ文字は \）
  const prefix = shortId.replace(/[\\%_]/g, (c) => `\\${c}`);

  const result = await db.query<{ id: string; session_id: string }>(
    `SELECT id, session_id FROM chat_sessions
     WHERE tenant_id = $1 AND session_id LIKE $2 || '%'
     ORDER BY last_message_at DESC
     LIMIT 6`,
    [tenantId, prefix]
  );

  if (result.rows.length === 0) {
    return { ok: false, message: `セッション[${shortId}]は見つかりません。get_chat_sessions で表示されたIDをご確認ください` };
  }
  if (result.rows.length > 1) {
    // 8文字だと候補同士が同じ表示になりうるため、区別できるよう長めのIDを提示する
    const candidates = result.rows.map((r) => `[${r.session_id.slice(0, 16)}]`).join(' ');
    return {
      ok: false,
      message: `セッション[${shortId}]に一致する会話が${result.rows.length}件あります: ${candidates}\nどれか1つのIDをそのまま指定してください`,
    };
  }
  return { ok: true, session: result.rows[0] };
}

const CHAT_ROLE_LABELS: Record<string, string> = {
  user: 'お客様',
  assistant: 'AI',
  operator: '担当者',
};

// ---------------------------------------------------------------------------
// ツール実行結果
// ---------------------------------------------------------------------------

// フィールド名は copilot-preview の Card union の link バリアントに揃えてあり、
// フロントは自然文を正規表現で読み直さずそのまま描画できる。
export type LegacyLinkCardPayload = {
  kind: 'legacy_link';
  label: string;
  url: string;
  description: string;
};

// get_weekly_briefing 用。数値はLLMの生成文を経由せず、この構造化データを
// そのままカードとして描画する(数値=サーバ、解釈=LLMの文、という権威分離の実体)。
// 各グループは対応するクエリが失敗した場合に null になる(Promise.allSettledでの
// 部分失敗時、text側で行ごと省略するのと同じ意味)。card はUIが「取得できなかった」を
// 判別するための情報であり、0埋めしてはならない。
export type WeeklySummaryCardPayload = {
  kind: 'weekly_summary';
  /** この応答を生成した瞬間(ISO)。会話復元時に古いまとめだと判別するために使う */
  asOf: string;
  sessions: { total: number; changePct: number | null; prevTotal: number } | null;
  avgScore: number | null;
  conversions: { count: number; total: number } | null;
  faq: { total: number; published: number; lastUpdated: string | null } | null;
  pendingTuningRules: number | null;
  gaps: { total: number; top: Array<{ id: number; question: string }> } | null;
};

// ツール結果は既定では素の文字列で、構造化データを添えるツールだけが
// { text, card } 形を返す。card は text の置き換えではなく追加である
// （text 側の自然文は既存の正規表現パーサのフォールバック契約として残す）。
export type ActionResult = string | { text: string; card?: LegacyLinkCardPayload | WeeklySummaryCardPayload };

// ---------------------------------------------------------------------------
// メインエントリ
// ---------------------------------------------------------------------------

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Pool,
  sessionId: string,
  isSuperAdmin: boolean = false
): Promise<ActionResult> {
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
    // 新規テナントのオンボーディング(GID 1216274591838389のチャット版):
    // 業種別FAQたたき台を一括登録し、旧UI(OnboardingModal)と同じ条件で
    // onboarding_completed_at を更新する(業種選択のみで完了扱いになる仕様を踏襲)。
    case 'import_industry_faq_templates': {
      const industryRaw = args['industry'];
      if (!isOnboardingIndustry(industryRaw)) {
        return truncate(`不明な業種です: ${String(industryRaw)}`);
      }
      const confirmed = Boolean(args['confirmed']);
      const templates = INDUSTRY_FAQ_TEMPLATES[industryRaw];
      const label = ONBOARDING_INDUSTRY_LABELS[industryRaw];

      if (!confirmed) {
        const lines = templates.map((t, i) => `${i + 1}. Q: ${t.question} / A: ${t.answer}`);
        return truncate(
          `「${label}」向けのFAQたたき台を${templates.length}件ご用意しました:\n` +
          lines.join('\n') +
          `\nよろしければ登録しますか？（登録後も自由に編集・削除できます）`,
        );
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        let inserted = 0;
        for (const t of templates) {
          try {
            const result = await db.query(
              `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
               VALUES ($1, $2, $3, $4, true)
               RETURNING id, question, answer, is_published`,
              [tenantId, t.question, t.answer, t.category ?? 'general'],
            );
            const row = result.rows[0] as { id: number; question: string; answer: string; is_published: boolean };
            insertEmbeddingAsync(db, tenantId, `${row.question}\n${row.answer}`, row.id, {
              source: 'admin_agent_onboarding',
              faq_id: row.id,
            });
            upsertToEsAsync(tenantId, row.id, row.question, row.answer, row.is_published);
            inserted++;
          } catch (err) {
            logger.warn('[actionExecutor] import_industry_faq_templates insert failed', err);
          }
        }

        await db.query(
          `UPDATE tenants SET onboarding_industry = $1, onboarding_completed_at = NOW() WHERE id = $2`,
          [industryRaw, tenantId],
        ).catch((err) => {
          logger.warn('[actionExecutor] import_industry_faq_templates onboarding update failed', err);
        });

        return truncate(`「${label}」向けのFAQを${inserted}件登録しました`);
      } catch (err) {
        logger.warn('[actionExecutor] import_industry_faq_templates failed', err);
        return truncate('FAQテンプレートの登録に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_avatar_status': {
      try {
        const tenantRes = await db.query(
          `SELECT features->>'avatar' AS avatar_enabled FROM tenants WHERE id = $1`,
          [tenantId],
        );
        if (tenantRes.rows.length === 0) {
          return truncate('テナント設定が見つかりません');
        }
        const enabled = (tenantRes.rows[0] as { avatar_enabled: string | null }).avatar_enabled === 'true';
        if (!enabled) {
          return truncate('アバターは現在無効です');
        }
        const activeRes = await db.query(
          `SELECT id, name FROM avatar_configs WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId],
        );
        const active = activeRes.rows[0] as { id: string; name: string } | undefined;
        return truncate(
          active
            ? `アバターは有効です（稼働中の設定: ${active.name}）`
            : 'アバターは有効ですが、稼働中の設定がありません',
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_avatar_status failed', err);
        return truncate('アバター状況の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 一覧が無いと activate_avatar は「ID を知っている人しか使えない」ツールになるため、
    // 切替の前段としてここで ID を提示する。
    // 既定アバター(tenant_id='r2c_default')は avatar_configs の部分unique制約から
    // 除外されており全行 is_active = true なので、is_active だけで稼働中を判定すると
    // 見本18体がすべて「稼働中」に見える。稼働中の判定は自テナント行に限る。
    case 'get_avatar_list': {
      try {
        const res = await db.query(
          `SELECT id, name, is_active, tenant_id
             FROM avatar_configs
            WHERE tenant_id = $1 OR tenant_id = 'r2c_default'
            ORDER BY (tenant_id = $1) DESC, is_default ASC, created_at DESC`,
          [tenantId],
        );
        const rows = res.rows as { id: string; name: string; is_active: boolean; tenant_id: string }[];
        if (rows.length === 0) {
          return truncate('アバター設定はまだありません');
        }

        // 戻り値は500字で切られる。切られると一覧の末尾が黙って欠けるため、
        // 収まる分だけ出して残件数を明示する（欠落を沈黙させない）。
        const LIST_CHAR_BUDGET = 420;
        const lines: string[] = [];
        let used = 0;
        for (const row of rows) {
          const own = row.tenant_id === tenantId;
          const mark = own ? (row.is_active ? '（稼働中）' : '') : '（既定の見本）';
          const line = `- ${row.name}${mark} ID: ${row.id}`;
          if (used + line.length > LIST_CHAR_BUDGET) break;
          lines.push(line);
          used += line.length + 1;
        }
        const remaining = rows.length - lines.length;
        const footer = remaining > 0 ? `\nほか${remaining}件` : '';
        return truncate(`アバター設定は${rows.length}件あります:\n${lines.join('\n')}${footer}`);
      } catch (err) {
        logger.warn('[actionExecutor] get_avatar_list failed', err);
        return truncate('アバター一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'activate_avatar': {
      const id = String(args['id'] ?? '');
      if (!id) {
        return truncate('id は必須です');
      }

      // GID: LP料金表(Growth〜: AIアバター)に基づくプラン制限。
      // tenants/routes.ts の features.avatar 更新チェックと同じ基準をここでも適用する
      // （AIエージェント経由でのチャットからのアクティベートがプラン制限を素通りしないように）。
      // 注入済みの db を使う（tenantHasFeature 経由だと内部で getPool() の実Poolを
      // 使ってしまい、テストのモックPoolと食い違って汚染するため queryTenantPlan を直接使う）。
      const plan = await queryTenantPlan(db, tenantId);
      if (!planHasFeature(plan, 'avatar')) {
        return truncate(planLimitNotice(tenantId, sessionId, 'avatar'));
      }

      const client = await db.connect();
      try {
        const res = await activateAvatarConfig(client, id, tenantId);
        if (!res.ok) {
          // 見つからない原因の大半はIDの取り違え。次の一手（一覧で確認）を示す。
          return truncate(
            `アバターの有効化に失敗しました: ${res.error ?? '不明なエラー'}。get_avatar_list で ID を確認してください`,
          );
        }
        return truncate(`アバター（ID: ${id}）を有効化しました`);
      } catch (err) {
        // 不正な形式のID（UUIDでない文字列）もここに来る。500にはせず日本語で返す。
        logger.warn('[actionExecutor] activate_avatar failed', err);
        return truncate('アバターの有効化に失敗しました。get_avatar_list で ID を確認してください');
      } finally {
        client.release();
      }
    }

    // -----------------------------------------------------------------------
    // 既定アバター(is_default)は全テナント共通の見本で、常に is_active = true の
    // 前提で運用されている（部分unique制約から除外されている）。停止対象から外す。
    case 'deactivate_avatar': {
      try {
        const res = await db.query(
          `UPDATE avatar_configs SET is_active = false
            WHERE tenant_id = $1 AND is_active = true AND (is_default = false OR is_default IS NULL)
            RETURNING name`,
          [tenantId],
        );
        const stopped = res.rows as { name: string }[];
        if (stopped.length === 0) {
          return truncate('稼働中のアバターはありません');
        }
        const names = stopped.map((r) => `「${r.name}」`).join('');
        return truncate(
          `アバター${names}を停止しました。ウィジェットにアバターは表示されなくなります。` +
          '再開したいときは activate_avatar で同じ設定を有効化できます',
        );
      } catch (err) {
        logger.warn('[actionExecutor] deactivate_avatar failed', err);
        return truncate('アバターの停止に失敗しました');
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
    // Phase2 (P7 プロアクティブ・ブリーフィング): 今週(暦週・月曜00:00 JST起点)の状況を
    // 1回で要約取得する読み取り専用ツール。ログイン直後など能動的な状況説明に使う。
    // 期間の計算は weekRange.ts に集約する(SQLへ AT TIME ZONE を直書きしない)。
    case 'get_weekly_briefing': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const { weekStart, prevWeekStart, prevWeekEnd } = getWeekRange(new Date());
        // 指標ごとに Promise.allSettled で独立させる。以前は1本の失敗で全指標が
        // 「取得に失敗しました」に落ちていたが、指標が増えるほど1本の不調が全体を
        // 巻き込む確率が上がるため、取れた指標だけを出す方式に変更する。
        const [sessionsRes, prevSessionsRes, evalRes, cvRes, faqRes, tuningRes, gapsRes] = await Promise.allSettled([
          db.query(
            `SELECT COUNT(*)::int AS n FROM chat_sessions
             WHERE tenant_id = $1 AND started_at >= $2`,
            [tenantId, weekStart],
          ),
          db.query(
            `SELECT COUNT(*)::int AS n FROM chat_sessions
             WHERE tenant_id = $1
               AND started_at >= $2
               AND started_at < $3`,
            [tenantId, prevWeekStart, prevWeekEnd],
          ),
          db.query(
            `SELECT AVG(score) AS avg FROM conversation_evaluations
             WHERE tenant_id = $1 AND evaluated_at >= $2 AND score > 0`,
            [tenantId, weekStart],
          ),
          db.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(conversion_value), 0)::numeric AS total
             FROM conversion_attributions
             WHERE tenant_id = $1 AND created_at >= $2`,
            [tenantId, weekStart],
          ),
          // 旧ダッシュボードStatCard代替: FAQ総数・公開数・最終更新日(週に限定しないテナント全体の値)
          db.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE is_published)::int AS published,
                    MAX(updated_at) AS last_updated
             FROM faq_docs WHERE tenant_id = $1`,
            [tenantId],
          ),
          // weeklyReportGenerator(Phase46)からの唯一の引き継ぎ指標
          db.query(
            `SELECT COUNT(*)::int AS n FROM tuning_rules
             WHERE tenant_id = $1 AND approved_at IS NULL AND rejected_at IS NULL`,
            [tenantId],
          ),
          getGaps({ tenantId, status: 'open', limit: 3 }),
        ]);

        const lines: string[] = ['今週(月曜起点)の状況:'];
        // 数値の権威はこのcard(サーバ集計値)。text はLLMに渡す自然文とフォールバック
        // 表示用で、card と同じ値から組み立てる(2箇所に別の計算を書かない)。
        const card: WeeklySummaryCardPayload = {
          kind: 'weekly_summary',
          asOf: new Date().toISOString(),
          sessions: null,
          avgScore: null,
          conversions: null,
          faq: null,
          pendingTuningRules: null,
          gaps: null,
        };

        if (sessionsRes.status === 'fulfilled') {
          const totalSessions = Number(sessionsRes.value?.rows?.[0]?.n ?? 0);
          // 先週の同一経過時間との比較値。先週は既に終わっているため確定値として併記する
          // （週初の部分週をまる1週間の前週と比べると常に大幅マイナスになり指標として使えない）。
          let changePct: number | null = null;
          let prevSessions = 0;
          if (prevSessionsRes.status === 'fulfilled') {
            prevSessions = Number(prevSessionsRes.value?.rows?.[0]?.n ?? 0);
            if (prevSessions > 0) {
              changePct = Math.round(((totalSessions - prevSessions) / prevSessions) * 100);
            }
          }
          card.sessions = { total: totalSessions, changePct, prevTotal: prevSessions };
          const changeSuffix = changePct !== null
            ? `（先週同時点比 ${changePct >= 0 ? '+' : ''}${changePct}%、先週同時点は${prevSessions}件）`
            : '';
          lines.push(`会話数 ${totalSessions}件${changeSuffix}`);
        }

        if (evalRes.status === 'fulfilled') {
          const avgScoreRaw = evalRes.value?.rows?.[0]?.avg;
          if (avgScoreRaw != null) {
            card.avgScore = Math.round(Number(avgScoreRaw));
            lines.push(`応答品質スコア ${card.avgScore}/100`);
          }
        }

        if (cvRes.status === 'fulfilled') {
          const cvCount = Number(cvRes.value?.rows?.[0]?.n ?? 0);
          const cvTotal = Math.round(Number(cvRes.value?.rows?.[0]?.total ?? 0));
          card.conversions = { count: cvCount, total: cvTotal };
          lines.push(`成約 ${cvCount}件・¥${cvTotal.toLocaleString('ja-JP')}`);
        }

        if (faqRes.status === 'fulfilled') {
          const row = faqRes.value?.rows?.[0];
          const faqTotal = Number(row?.total ?? 0);
          const faqPublished = Number(row?.published ?? 0);
          const lastUpdatedIso: string | null = row?.last_updated
            ? new Date(row.last_updated).toISOString()
            : null;
          card.faq = { total: faqTotal, published: faqPublished, lastUpdated: lastUpdatedIso };
          const lastUpdatedDisplay = lastUpdatedIso
            ? new Date(lastUpdatedIso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })
            : null;
          lines.push(
            `FAQ ${faqTotal}件（公開${faqPublished}件）` + (lastUpdatedDisplay ? `・最終更新 ${lastUpdatedDisplay}` : ''),
          );
        }

        if (tuningRes.status === 'fulfilled') {
          const pending = Number(tuningRes.value?.rows?.[0]?.n ?? 0);
          card.pendingTuningRules = pending;
          lines.push(`承認待ちの指示ルール ${pending}件`);
        }

        if (gapsRes.status === 'fulfilled') {
          const { gaps, total: gapsTotal } = gapsRes.value;
          card.gaps = { total: gapsTotal, top: gaps.map((g) => ({ id: g.id, question: g.user_question.slice(0, 60) })) };
          lines.push(`AIが答えられなかった質問 ${gapsTotal}件（未対応の累計）`);
          if (gaps.length > 0) {
            lines.push('うち上位:');
            gaps.forEach((g, i) => {
              lines.push(`${i + 1}. 「${g.user_question.slice(0, 60)}」`);
            });
          }
        }

        if (lines.length === 1) {
          // 全指標が取得失敗
          return truncate('週次サマリーの取得に失敗しました');
        }

        return { text: truncate(lines.join('\n')), card };
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
    // チャット版 FAQ一括取り込み(テキスト): 旧UIの「AIの知識データ」テキストタブと
    // 同じ generateTextFaqPreview を使ってFAQ案を生成し、結果をサーバー側にステージングする
    // (LLMに配列を持ち回らせない設計。詳細は knowledgeImportStaging.ts のコメント参照)。
    // DB書き込みはしない読み取り専用ツール。登録は commit_faq_import で行う。
    case 'suggest_faq_import_from_text': {
      const text = String(args['text'] ?? '').trim();
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (text.length < 50 || text.length > 10000) {
        return truncate('text は50文字以上10000文字以内で入力してください');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        let faqs = await generateTextFaqPreview(db, tenantId, text, category);
        if (faqs.length === 0) {
          return truncate('FAQを生成できませんでした。テキストをもう少し詳しく入力してみてください');
        }

        const truncated = faqs.length > MAX_IMPORT_FAQS;
        if (truncated) faqs = faqs.slice(0, MAX_IMPORT_FAQS);

        setStagedFaqImport(tenantId, sessionId, {
          kind: 'text',
          tenantId,
          faqs,
          categoryOverride: category,
          truncated,
          createdAt: Date.now(),
        });

        const dupCount = faqs.filter((f) => f.duplicate).length;
        const examples = faqs.slice(0, 3).map((f) => `「${f.question.slice(0, 40)}」`).join('、');
        const lines = [
          `${faqs.length}件のFAQ案を作成しました。` +
            (dupCount > 0 ? `うち${dupCount}件は既存と重複のため登録時にスキップされます。` : ''),
          `例: ${examples}`,
        ];
        if (truncated) lines.push(`※ 生成数が上限(${MAX_IMPORT_FAQS}件)を超えたため、先頭${MAX_IMPORT_FAQS}件のみを対象にしています。`);
        lines.push('登録してよろしければお知らせください。');
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_faq_import_from_text failed', err);
        return truncate('FAQ案の生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込み(URL): 旧UIの「AIの知識データ」URLタブと同じ
    // generateScrapeFaqPreview を使ってFAQ案を生成し、結果をサーバー側にステージングする。
    // DB書き込みはしない読み取り専用ツール。登録は commit_faq_import で行う。
    case 'suggest_faq_import_from_urls': {
      const urlsRaw = args['urls'];
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (!Array.isArray(urlsRaw) || urlsRaw.length === 0 || urlsRaw.length > 5) {
        return truncate('urls は1〜5件のURLを配列で指定してください');
      }
      const urls = urlsRaw.map((u) => String(u));
      const invalidUrl = urls.find((u) => !/^https?:\/\//i.test(u));
      if (invalidUrl) {
        return truncate(`URLの形式が不正です: ${invalidUrl.slice(0, 100)}`);
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const items = await generateScrapeFaqPreview(db, tenantId, urls, category);
        let totalFaqs = items.reduce((sum, item) => sum + item.faqs.length, 0);
        const errorItems = items.filter((item) => item.error);

        if (totalFaqs === 0) {
          const detail = errorItems.length > 0 ? `（${errorItems[0]!.error}）` : '';
          return truncate(`指定されたURLからFAQを生成できませんでした${detail}`);
        }

        // 20件上限は item をまたいで先頭から詰める（末尾の item・faq から間引く）
        let truncated = false;
        if (totalFaqs > MAX_IMPORT_FAQS) {
          truncated = true;
          let remaining = MAX_IMPORT_FAQS;
          for (const item of items) {
            if (remaining <= 0) { item.faqs = []; continue; }
            if (item.faqs.length > remaining) item.faqs = item.faqs.slice(0, remaining);
            remaining -= item.faqs.length;
          }
          totalFaqs = MAX_IMPORT_FAQS;
        }

        setStagedFaqImport(tenantId, sessionId, {
          kind: 'scrape',
          tenantId,
          items,
          categoryOverride: category,
          truncated,
          createdAt: Date.now(),
        });

        const allFaqs = items.flatMap((item) => item.faqs);
        const dupCount = allFaqs.filter((f) => f.duplicate).length;
        const examples = allFaqs.slice(0, 3).map((f) => `「${f.question.slice(0, 40)}」`).join('、');
        const lines = [
          `${urls.length}件のURLから合計${totalFaqs}件のFAQ案を作成しました。` +
            (dupCount > 0 ? `うち${dupCount}件は既存と重複のため登録時にスキップされます。` : ''),
          `例: ${examples}`,
        ];
        if (errorItems.length > 0) lines.push(`取得できなかったURL: ${errorItems.length}件`);
        if (truncated) lines.push(`※ 生成数が上限(${MAX_IMPORT_FAQS}件)を超えたため、先頭${MAX_IMPORT_FAQS}件のみを対象にしています。`);
        lines.push('登録してよろしければお知らせください。');
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_faq_import_from_urls failed', err);
        return truncate('FAQ案の生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込みのコミット: suggest_faq_import_from_text/urls で
    // ステージング済みのFAQをDBに登録する。confirmedゲート必須。
    case 'commit_faq_import': {
      const confirmed = Boolean(args['confirmed']);
      const targetRaw = typeof args['target'] === 'string' ? args['target'] : undefined;

      if (!confirmed) {
        return truncate('FAQの一括登録には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const staged = getStagedFaqImport(tenantId, sessionId);
      if (!staged) {
        return truncate('プレビューがありません。先に suggest_faq_import_from_text または suggest_faq_import_from_urls でFAQ案を作成してください');
      }

      const target = targetRaw || tenantId;
      if (target === 'global' && !isSuperAdmin) {
        return truncate('全店舗共通の知識データはSuper Adminのみ登録可能です');
      }
      // target は toolDefinitions でLLMに公開されているため、client_admin が自然文で
      // 他テナントIDを指定できてしまう。'global' 以外の越境書き込みもここで塞ぐ
      // （旧HTTPルート /text/commit の requireKnowledgeTenant は body の target を
      // 見ないため同じ穴があるが、チャットからは自然文で到達可能なのでここで防ぐ）。
      if (target !== tenantId && !isSuperAdmin) {
        return truncate('他のテナントには登録できません');
      }

      try {
        const categoryOverride = staged.categoryOverride ?? undefined;
        const result =
          staged.kind === 'text'
            ? await commitTextFaqs(db, target, staged.faqs, categoryOverride, 'admin_agent_text_import')
            : await commitScrapeFaqs(db, target, staged.items, categoryOverride, 'admin_agent_scrape_import');

        clearStagedFaqImport(tenantId, sessionId);

        return truncate(
          `FAQを${result.inserted}件登録しました` +
            (result.skipped > 0 ? `（重複のため${result.skipped}件はスキップしました）` : ''),
        );
      } catch (err) {
        logger.warn('[actionExecutor] commit_faq_import failed', err);
        return truncate('FAQの一括登録に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込みのプレビュー破棄: 直前の suggest_faq_import_from_text/urls
    // の結果を明示的に取り消す。TTL(30分)でも自動失効するが、続けて別の内容を試す前に
    // 古いプレビューが残っていることでの誤登録を避けるための明示的な取消手段として用意する。
    // 確認は不要(DBへの書き込みは何もしていない取り消しのため、他の削除系ツールと違いconfirmedゲートは設けない)。
    case 'discard_faq_import': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const staged = getStagedFaqImport(tenantId, sessionId);
      if (!staged) {
        return truncate('破棄する対象のFAQ案はありません');
      }
      clearStagedFaqImport(tenantId, sessionId);
      return truncate('FAQ案を破棄しました');
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
        const suggestion = await suggestEngagementRuleFromText(freeText, tenantId);
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
    case 'get_chat_session_messages': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const limitRaw = Number(args['limit'] ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }

        const messages = await getMessages({ sessionDbId: resolved.session.id, tenantId });
        if (messages.length === 0) {
          return truncate(`セッション[${resolved.session.session_id.slice(0, 8)}]にメッセージはありません`);
        }

        const recent = messages.slice(-limit);
        const lines = recent.map((m) => `${CHAT_ROLE_LABELS[m.role] ?? m.role}: ${m.content}`);
        return truncate(
          `セッション[${resolved.session.session_id.slice(0, 8)}]の会話（全${messages.length}件中${recent.length}件）:\n` +
          lines.join('\n'),
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_chat_session_messages failed', err);
        return truncate('会話内容の取得に失敗しました');
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
    // 有人返信 / 対応完了: 旧UI(/admin/escalations)と同じ書き込みをチャットから行う。
    // セッションの特定は必ず resolveSessionByShortId 経由（tenant_id 条件込み）とし、
    // 他テナントのセッションへ書き込む経路を作らない。
    case 'reply_to_escalation': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const content = String(args['content'] ?? '').trim();
      const confirmed = args['confirmed'] === true;

      if (!content) {
        return truncate('返信内容（content）は必須です');
      }
      if (content.length > MAX_OPERATOR_REPLY_LENGTH) {
        return truncate(`返信内容は${MAX_OPERATOR_REPLY_LENGTH}文字以内で指定してください（現在${content.length}文字）`);
      }

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        if (!confirmed) {
          return truncate(
            `お客様への返信には確認が必要です。セッション[${display}]に以下の文面を送信します。` +
            'ユーザーに提示し、同意を得てから confirmed=true で再度実行してください\n' +
            `返信内容: ${content}`,
          );
        }

        await saveMessage({
          tenantId,
          sessionId: resolved.session.session_id,
          role: 'operator',
          content,
        });
        return truncate(`セッション[${display}]への返信を保存しました。お客様の画面に表示されます`);
      } catch (err) {
        logger.warn('[actionExecutor] reply_to_escalation failed', err);
        return truncate('返信の送信に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'resolve_escalation': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const confirmed = args['confirmed'] === true;

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        if (!confirmed) {
          return truncate(
            `対応完了にするには確認が必要です。セッション[${display}]を対応完了にすると、エスカレーション一覧から外れます。` +
            'ユーザーに提示し、同意を得てから confirmed=true で再度実行してください',
          );
        }

        const ok = await resolveEscalation({ sessionDbId: resolved.session.id, tenantId });
        if (!ok) {
          return truncate(`セッション[${display}]は見つかりません`);
        }
        return truncate(`セッション[${display}]のエスカレーションを対応完了に更新しました`);
      } catch (err) {
        logger.warn('[actionExecutor] resolve_escalation failed', err);
        return truncate('対応完了の記録に失敗しました');
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
    // Saiへの代行依頼: テナント(client_admin)・super_admin共通で利用可能。
    // 費用は一回限りの即時課金ではなく、他のLLM機能(admin_agent等)と同じ従量課金
    // (trackUsage → usage_logs → 月次Stripe請求)に計上される。
    case 'request_sai_task': {
      const confirmed = Boolean(args['confirmed']);
      const description = String(args['description'] ?? '').trim().slice(0, 2000);

      if (!confirmed) {
        return truncate('Saiへの依頼には確認が必要です。作業内容をユーザーに提示し、同意を得てから confirmed=true で再度実行してください');
      }
      if (!description) {
        return truncate('description は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      // GID 1216944249525907: LP料金表(Enterprise〜: Sai代行)に基づくプラン制限。
      // super_adminは従来どおりバイパス。fail-safe: plan取得失敗時はstarter扱い(=拒否)。
      if (!isSuperAdmin) {
        const plan = await queryTenantPlan(db, tenantId);
        if (!planHasFeature(plan, 'sai_task')) {
          return truncate(planLimitNotice(tenantId, sessionId, 'sai_task'));
        }
      }

      try {
        const ceilingCheck = await checkSaiMonthlyCostCeiling(db, tenantId);
        if (!ceilingCheck.ok) {
          logger.warn({ event: 'sai_cost_ceiling_blocked', tenantId, ...ceilingCheck }, 'request_sai_task blocked: monthly cost ceiling reached');
          const msg =
            ceilingCheck.reason === 'global'
              ? 'Saiの全体月次コスト上限に達しているため、今回は依頼できません。管理者に確認してください'
              : 'Saiの月次コスト上限に達しているため、今回は依頼できません。管理者に確認してください';
          return truncate(msg);
        }

        const { task_id } = await submitSaiTask({ description });
        return truncate(`Saiにタスクを依頼しました（タスクID: ${task_id}）。get_sai_task_status で進捗を確認できます`);
      } catch (err: any) {
        if (err?.message === 'SAI_API_KEY not set') {
          return truncate('Saiが設定されていません');
        }
        logger.warn('[actionExecutor] request_sai_task failed', err);
        return truncate('Saiへの依頼に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_sai_task_status': {
      const taskId = String(args['task_id'] ?? '').trim();
      if (!taskId) {
        return truncate('task_id は必須です');
      }

      try {
        const task = await getSaiTask(taskId);

        // 完了時のみ、他のLLM機能と同じ従量課金ロジックでコストを計上する
        // (requestIdをtask_idで固定し、再ポーリングでも二重計上しない)
        if (task.status === 'complete' && tenantId) {
          trackUsage({
            tenantId,
            requestId: `sai-agent-request:${taskId}`,
            model: 'agent-s',
            inputTokens: 0,
            outputTokens: 0,
            featureUsed: 'sai_agent',
            saiAgentSteps: task.steps,
          });
        }

        const lines = [
          `状態: ${task.status}`,
          `ステップ: ${task.steps}/${task.max_steps}`,
        ];
        if (task.outcome) lines.push(`自己申告: ${task.outcome}（自己申告は信用しない設計のため、最終スクリーンショットを目視確認してから完了させてください）`);
        if (task.last_action) lines.push(`直近の操作: ${task.last_action}`);
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_sai_task_status failed', err);
        return truncate('Saiタスクの状態取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_legacy_ui_link': {
      const feature = String(args['feature'] ?? '');
      const LEGACY_UI_LINKS: Record<string, { label: string; path: string; description: string }> = {
        billing: {
          label: '請求管理',
          path: '/admin/billing',
          description: '請求書の再送・金額調整・無料期間設定・一時停止/再開はこちらの画面で行えます',
        },
        avatar_studio: {
          label: 'アバタースタジオ',
          path: '/admin/avatar/studio',
          description: '画像候補の選択・音声クローン・性格設定・ライブテストはこちらの画面で行えます',
        },
        escalation_reply: {
          label: 'エスカレーション対応',
          path: '/admin/escalations',
          description: '有人での返信・対応記録はこちらの画面で行えます',
        },
        session_deletion: {
          label: '会話履歴',
          path: '/admin/chat-history',
          description: '会話内容の確認とその会話セッションの削除はこちらの画面で行えます',
        },
        analytics: {
          label: '会話分析',
          path: '/admin/analytics',
          description: '会話数・満足度スコア・品質指標の推移や低評価セッションの確認はこちらの画面で行えます',
        },
        conversion: {
          label: '成約・効果分析',
          path: '/admin/conversion',
          description: '成約への貢献度・ABテスト・効果測定の確認はこちらの画面で行えます',
        },
        chat_test: {
          label: 'テストチャット',
          path: '/admin/chat-test',
          description: '設定した内容を実際のチャットで試すのはこちらの画面で行えます',
        },
        avatar_wizard: {
          label: 'アバター新規作成',
          path: '/admin/avatar/wizard',
          description: 'アバターを新しく作る手順（ウィザード）はこちらの画面で行えます',
        },
        // PDFアップロードはファイル選択がGUI固有の操作のため、当初チャット化せず旧UIへ誘導していた。
        // docs/CHAT_SURFACE_DECISION.md の方針に沿い、新UI(/copilot-preview)のコンポーザへの
        // ドラッグ＆ドロップで会話内に取り込む経路を試作済み(同じ book-pdf エンドポイントを直接叩く)。
        // ただし取り込み後の状態追跡・タイトル編集・書籍一覧はこの旧UIにしか無いため、案内先としては
        // 引き続き有効。docs/LEGACY_UI_SUNSET.md のクローズ判定を通るまでこのキーは残す(追加のみ)。
        // /admin/knowledge (tenantId無し)は KnowledgeIndexPage が navigate() で
        // /admin/knowledge/:tenantId へリダイレクトする際に location.search を引き継がず
        // ?tab=pdf が失われるため、他のキーと異なりここでは tenantId を path に含める必要がある
        // (下のガードで !tenantId は事前に弾いている)。
        knowledge_pdf: {
          label: 'PDFアップロード',
          path: `/admin/knowledge/${tenantId}?tab=pdf`,
          description: 'PDFファイルからの知識登録はこちらの画面で行えます',
        },
      };

      // GID: LP料金表(Growth〜: 高度なAnalytics、CV計測)に基づくプラン制限。
      // AppSidebar.tsx(225行付近)とは異なり、ここでは super_admin もバイパスさせない。
      // super_admin がこの新UIに入る経路は「クライアントビューで見る」(previewMode)であり、
      // 目的はテナントに見えている状態の再現なので、Starterテナントのプレビューで
      // Growth限定機能の案内を出すのは再現として誤り。読み取り専用の案内でしかなく、
      // planFeatures.ts の GID 1216961878992581 が扱う「永続的な権能付与 vs 都度原価」の
      // 判断軸（activate_avatar 等）にも当てはまらない。
      if (feature === 'analytics' || feature === 'conversion') {
        if (!tenantId) {
          return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
        }
        const plan = await queryTenantPlan(db, tenantId);
        if (!planHasFeature(plan, feature)) {
          return truncate(planLimitNotice(tenantId, sessionId, feature));
        }
      }

      // knowledge_pdf は path に tenantId を埋め込む都合上、他のキーと違い必須。
      if (feature === 'knowledge_pdf' && !tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const link = LEGACY_UI_LINKS[feature];
      if (!link) {
        return truncate(`不明な案内先です: ${feature}`);
      }

      // session_deletion で対象の会話が分かっているときは、一覧ではなくその会話を直接開くリンクにする
      // (一覧から探し直させないため)。解決できない場合(存在しない/曖昧/他テナント)は一覧へ素直に戻す。
      let path = link.path;
      if (feature === 'session_deletion' && tenantId) {
        const shortId = String(args['session_id'] ?? '').trim();
        if (shortId) {
          try {
            const resolved = await resolveSessionByShortId(db, tenantId, shortId);
            if (resolved.ok) {
              path = `/admin/chat-history/${resolved.session.id}`;
            }
          } catch (err) {
            logger.warn('[actionExecutor] get_legacy_ui_link session resolve failed', err);
          }
        }
      }

      // 冒頭は「できません」ではなく「どこでできるか」から始める(行き止まりに見せない)。
      // 続く3行(画面:/URL:/説明:)は copilot-preview の parseLegacyUiLink が
      // リンクカード描画のために正規表現で読む契約なので、順序・ラベルを変えないこと。
      // card を併せて返すことで新しいクライアントは正規表現を経ずに描画できるが、
      // 自然文だけを見る経路(LLMへの差し戻し・旧クライアント)のために text は不可欠。
      // 失敗パス(プラン制限・不明なfeature等)は素の文字列を返すため、押せないリンク
      // カードが出ないという性質は card 側でもそのまま保たれる。
      return {
        text: truncate(`この操作は${link.label}画面から行えます。\n画面: ${link.label}\nURL: ${path}\n説明: ${link.description}`),
        card: { kind: 'legacy_link', label: link.label, url: path, description: link.description },
      };
    }

    // -----------------------------------------------------------------------
    case 'get_analytics_summary':
    case 'get_conversion_summary': {
      const feature = toolName === 'get_analytics_summary' ? 'analytics' : 'conversion';

      // get_legacy_ui_link の analytics/conversion と同じ扱い。super_admin もバイパスさせない
      // （クライアントビューはテナントに見えている状態の再現が目的のため）。
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const plan = await queryTenantPlan(db, tenantId);
      if (!planHasFeature(plan, feature)) {
        return truncate(planLimitNotice(tenantId, sessionId, feature));
      }

      const period = args['period'] === '7d' ? '7d' : '30d';
      const periodLabel = period === '7d' ? '直近7日間' : '直近30日間';

      try {
        if (toolName === 'get_analytics_summary') {
          const s = await fetchAnalyticsSummary({ db, tenantId, period });
          const sent = s.sentiment_distribution;
          const lines = [
            `会話分析サマリー（${periodLabel}）`,
            `• 会話数: ${s.total_sessions}件（前期間 ${s.prev_total_sessions}件 / ${s.sessions_change_pct >= 0 ? '+' : ''}${s.sessions_change_pct.toFixed(1)}%）`,
            `• 満足度スコア: ${s.avg_judge_score != null ? s.avg_judge_score.toFixed(1) : '評価データなし'}`,
            `• 1会話あたりのメッセージ数: ${s.avg_messages_per_session.toFixed(1)}件`,
            `• 答えられなかった質問: ${s.total_knowledge_gaps}件`,
          ];
          if (sent.total > 0) {
            lines.push(`• 感情の内訳: ポジティブ${sent.positive} / ネガティブ${sent.negative} / ニュートラル${sent.neutral}`);
          }
          return truncate(lines.join('\n'));
        }

        const c = await fetchConversionSummary({ db, tenantId, period });
        const lines = [
          `成約・効果分析サマリー（${periodLabel}）`,
          `• 会話数: ${c.summary.total_sessions}件（うち結果記録済み ${c.summary.recorded_outcomes}件 / 記録率 ${c.summary.recording_rate}%）`,
        ];
        const outcomeEntries = Object.entries(c.summary.outcomes);
        if (outcomeEntries.length > 0) {
          lines.push(`• 結果の内訳: ${outcomeEntries.map(([k, v]) => `${k} ${v}件`).join(' / ')}`);
        }
        const topTechniques = c.technique_effectiveness.slice(0, 3);
        if (topTechniques.length > 0) {
          lines.push(`• 成果の高い話法: ${topTechniques.map((t) => `${t.technique} ${t.conversion_rate}%（${t.sessions_used}件）`).join(' / ')}`);
        }
        const topDropout = Object.entries(c.stage_dropout)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])[0];
        if (topDropout) {
          lines.push(`• 離脱が最も多いステージ: ${topDropout[0]}（${topDropout[1]}件）`);
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn(`[actionExecutor] ${toolName} failed`, err);
        return truncate('分析サマリーの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    default:
      return truncate(`不明なツール: ${toolName}`);
  }
}
