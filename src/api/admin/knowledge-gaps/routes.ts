// src/api/admin/knowledge-gaps/routes.ts
// Phase46 Stream B: Knowledge Gap 管理 API（推薦・承認・ナレッジ追加）

import type { Express, Request, Response } from 'express';
import pino from 'pino';
import { z } from 'zod';
import { getPool } from '../../../lib/db';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { superAdminMiddleware } from '../tenants/superAdminMiddleware';
import { generateRecommendations } from '../../../agent/gap/gapRecommender';
import { callGeminiJudge } from '../../../lib/gemini/client';
import { insertEmbeddingAsync, upsertToEsAsync } from '../knowledge/faqCrudRoutes';
import { getGapCount } from '../knowledge/knowledgeGapRepository';

const logger = pino();

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist (Phase69-1.5 PR-C4 v2)
// ---------------------------------------------------------------------------

const ALLOWED_KG_PHASE46_ROLES = ['super_admin', 'client_admin'] as const;
type AllowedKgPhase46Role = typeof ALLOWED_KG_PHASE46_ROLES[number];
function isAllowedKgPhase46Role(role: unknown): role is AllowedKgPhase46Role {
  return typeof role === 'string' &&
         (ALLOWED_KG_PHASE46_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function resolveJwt(req: Request): { su: Record<string, any> | undefined; role: unknown; jwtTenantId: string; isSuperAdmin: boolean; isClientAdmin: boolean } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role: unknown = su?.app_metadata?.role;
  const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const isSuperAdmin = role === 'super_admin';
  const isClientAdmin = role === 'client_admin';
  return { su, role, jwtTenantId, isSuperAdmin, isClientAdmin };
}

function denyKgPhase46Role(req: Request, res: Response, su: Record<string, any> | undefined, role: unknown) {
  logger.warn({
    event: 'knowledge_gaps_access_denied',
    reason: 'invalid_role',
    errorCode: 'AUTHZ_ROLE_DENIED',
    requested_path: req.path,
    actor_email: su?.['email'] ? String(su['email']).slice(0, 3) + '***' : 'unknown',
    actor_role: role,
    required_roles: ALLOWED_KG_PHASE46_ROLES,
    hasAppMetadataRole: !!su?.['app_metadata']?.role,
    hasUserMetadataRole: !!su?.['user_metadata']?.role,
  }, 'knowledge-gaps access denied: invalid actor role');
  return res.status(403).json({ error: 'この操作を実行する権限がありません', code: 'AUTHZ_ROLE_DENIED' });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const recommendationActionSchema = z.object({
  action: z.enum(['approve', 'dismiss']),
});

// 2026-08-25(P10): 旧 knowledgeGapRoutes.ts の PATCH は knowledge_gaps.status
// (ギャップ自体のライフサイクル: open/resolved/dismissed)を更新していたが、
// 本ファイルの PATCH は recommendation_status(AI推薦の承認状態)しか更新できず、
// 別の関心事だった。1つのPATCHエンドポイントで両方受けられるよう union にする
// (第2のPATCHルートを作らない)。
const gapStatusUpdateSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  resolved_faq_id: z.number().int().positive().nullable().optional(),
});

const addKnowledgeSchema = z.object({
  answer_text: z.string().min(1).max(5000),
  category: z.string().max(100).optional(),
  source_type: z.enum(['manual', 'ai_suggested']).default('manual'),
});

const generateRecommendationsSchema = z.object({
  tenant_id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Extended KnowledgeGap row type (Phase46 columns)
// ---------------------------------------------------------------------------

interface KnowledgeGapRow {
  id: number;
  tenant_id: string;
  user_question: string;
  session_id: string | null;
  rag_hit_count: number;
  rag_top_score: number;
  status: string;
  frequency: number | null;
  detection_source: string | null;
  recommended_action: string | null;
  suggested_answer: string | null;
  recommendation_status: string | null;
  last_detected_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 書き込みロジック(HTTPルートとチャットツール actionExecutor.ts の両方から
// 呼ぶ唯一の実装。ナレッジ配線是正「チャット完結」タスク、Asana GID
// 1217811043900566)。FAQ書き込みの6本目を新設しない(CLAUDE.md 禁止6)ため、
// POST /v1/admin/knowledge-gaps/:id/add-knowledge の元の内部ロジックを
// そのままここに切り出し、ルートハンドラ側は薄いラッパーにする。
// ---------------------------------------------------------------------------

export type ApproveGapRecommendationResult =
  | { ok: true; userQuestion: string; detectionSource: string | null; frequency: number | null }
  | { ok: false; reason: 'not_found' };

/**
 * ギャップのAI推薦を承認する(recommendation_status → 'approved')。
 * PATCH /v1/admin/knowledge-gaps/:id の action='approve' 分岐と、
 * チャットツール approve_gap_recommendation の両方から呼ばれる。
 *
 * 呼び出し元がその場で承認の根拠(質問文・検出源・頻度)を提示できるよう、
 * UPDATE と同時に RETURNING で返す(禁止29/33の趣旨: 出所を示さずに承認させない)。
 */
export async function approveGapRecommendation(
  gapId: number,
  tenantId: string,
  isSuperAdmin: boolean,
): Promise<ApproveGapRecommendationResult> {
  const pool = getPool();
  const tenantCondition = isSuperAdmin ? '' : ' AND tenant_id = $3';
  const args: unknown[] = ['approved', gapId];
  if (!isSuperAdmin) args.push(tenantId);

  const result = await pool.query<{ user_question: string; detection_source: string | null; frequency: number | null }>(
    `UPDATE knowledge_gaps SET recommendation_status = $1 WHERE id = $2${tenantCondition}
     RETURNING user_question, detection_source, frequency`,
    args,
  );

  if ((result.rowCount ?? 0) === 0) return { ok: false, reason: 'not_found' };
  const row = result.rows[0]!;
  return {
    ok: true,
    userQuestion: row.user_question,
    detectionSource: row.detection_source,
    frequency: row.frequency,
  };
}

export type AddKnowledgeFromGapResult =
  | { ok: true; faqDocId: number; gapQuestion: string; detectionSource: string | null; frequency: number | null }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'not_approved' };

/**
 * 承認済みギャップから FAQ を作成する(faq_docs INSERT + embedding + ES同期 +
 * ギャップを resolved に更新)。POST /v1/admin/knowledge-gaps/:id/add-knowledge
 * と、チャットツール add_knowledge_from_gap の両方から呼ばれる唯一の実装。
 */
export async function addKnowledgeFromGap(
  gapId: number,
  answerText: string,
  category: string | null,
  tenantId: string,
  isSuperAdmin: boolean,
): Promise<AddKnowledgeFromGapResult> {
  const pool = getPool();

  // 2026-08-25是正(壊れやすいポイント監査): 以前は「SELECTでapproved確認→INSERT→
  // UPDATE resolved」の3ステップが1トランザクションでなく、承認済みギャップに対して
  // ほぼ同時に2回呼ばれる(ダブルクリック・2タブ操作)と両方がSELECTでapprovedを
  // 見てしまい、FAQが重複作成されるTOCTOU(check-then-act)競合があった。
  // まずこのUPDATEで recommendation_status: 'approved' → 'resolved' への遷移を
  // 原子的に「claim」し(Postgresの行ロックにより同時に1件しか成功しない)、
  // 成功した1件だけがFAQ作成に進む。resolved_faq_id はFAQ作成後に別UPDATEで埋める
  // (claimの時点ではまだ存在しないため)。
  const tenantCondition = isSuperAdmin ? '' : ' AND tenant_id = $3';
  const claimArgs: unknown[] = [gapId];
  if (!isSuperAdmin) claimArgs.push(tenantId);
  const claimResult = await pool.query<{
    tenant_id: string;
    user_question: string;
    detection_source: string | null;
    frequency: number | null;
  }>(
    `UPDATE knowledge_gaps
     SET recommendation_status = 'resolved'
     WHERE id = $1 AND recommendation_status = 'approved'${tenantCondition}
     RETURNING tenant_id, user_question, detection_source, frequency`,
    claimArgs,
  );

  if (claimResult.rows.length === 0) {
    // claimに失敗した理由を特定するため、失敗時のみ読み取り専用で状態を確認する
    // (この分岐は書き込みを行わないため、ここでの競合は問題にならない)。
    const probe = await pool.query<{ tenant_id: string; recommendation_status: string }>(
      `SELECT tenant_id, recommendation_status FROM knowledge_gaps WHERE id = $1`,
      [gapId],
    );
    if (probe.rows.length === 0) return { ok: false, reason: 'not_found' };
    if (!isSuperAdmin && probe.rows[0]!.tenant_id !== tenantId) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'not_approved' };
  }
  const gap = claimResult.rows[0]!;

  // faq_docs に INSERT
  const faqResult = await pool.query<{ id: number }>(
    `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id`,
    [gap.tenant_id, gap.user_question.slice(0, 500), answerText.slice(0, 2000), category ?? null],
  );
  const faqDocId = faqResult.rows[0]!.id;

  // embedding を非同期生成（fire-and-forget）。質問文も埋め込む
  // (以前は answer_text のみで、このFAQが答えるべき質問自体がベクトルに
  // 入っておらず検索精度が劣化していた。2026-08-25 是正)。
  insertEmbeddingAsync(
    pool,
    gap.tenant_id,
    `${gap.user_question}\n${answerText}`.slice(0, 2000),
    faqDocId,
    { source: 'knowledge_gap_resolution', faq_id: faqDocId },
  );

  // ES に非同期 upsert（fire-and-forget）。新規作成のため is_excluded_from_search
  // を引き継ぐ必要はない(既定 false で正しい)
  upsertToEsAsync(gap.tenant_id, faqDocId, gap.user_question, answerText, true);

  // status と resolved_faq_id を確定させる(recommendation_statusは既にclaim時に
  // 'resolved'へ遷移済み)。
  await pool.query(
    `UPDATE knowledge_gaps
     SET status = 'resolved',
         resolved_faq_id = $1
     WHERE id = $2`,
    [faqDocId, gapId],
  );

  return {
    ok: true,
    faqDocId,
    gapQuestion: gap.user_question,
    detectionSource: gap.detection_source,
    frequency: gap.frequency,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerKnowledgeGapPhase46Routes(app: Express): void {

  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge-gaps/count  (バッジ用: 未解決件数)
  // 2026-08-25(ナレッジ配線是正P10): 旧 knowledgeGapRoutes.ts(/v1/admin/knowledge/gaps/count)
  // を統合。/:id より先に登録する必要がある(Express のパスマッチ順)。
  // -------------------------------------------------------------------------
  app.get(
    '/v1/admin/knowledge-gaps/count',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, jwtTenantId, isSuperAdmin } = resolveJwt(req);
      if (!isAllowedKgPhase46Role(role)) {
        return denyKgPhase46Role(req, res, su, role);
      }
      const tenantFilter = isSuperAdmin
        ? ((req.query['tenant_id'] as string | undefined) || (req.query['tenant'] as string | undefined) || undefined)
        : jwtTenantId;

      if (!isSuperAdmin && !tenantFilter) {
        return res.status(400).json({ error: 'tenant が解決できません' });
      }

      try {
        const count = await getGapCount(tenantFilter);
        return res.json({ count });
      } catch (err) {
        logger.warn({ err }, '[GET /knowledge-gaps/count]');
        return res.status(500).json({ error: '件数の取得に失敗しました' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge-gaps
  // frequency DESC + last_detected_at DESC デフォルトソート
  // -------------------------------------------------------------------------
  app.get(
    '/v1/admin/knowledge-gaps',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { su, role, jwtTenantId, isSuperAdmin } = resolveJwt(req);
      if (!isAllowedKgPhase46Role(role)) {
        return denyKgPhase46Role(req, res, su, role);
      }

      const tenantFilter = isSuperAdmin
        ? ((req.query['tenant_id'] as string | undefined) || (req.query['tenant'] as string | undefined) || undefined)
        : jwtTenantId;

      if (!isSuperAdmin && !tenantFilter) {
        return res.status(400).json({ error: 'tenant が解決できません' });
      }

      const statusParam = (req.query['status'] as string | undefined) ?? 'open';
      const validStatuses = ['open', 'resolved', 'dismissed'];
      const status = validStatuses.includes(statusParam) ? statusParam : 'open';

      // Phase52b: sort_by, sort_order, trigger_type, period, search
      const validSortBy = ['occurrence_count', 'created_at', 'status', 'trigger_type'];
      const sortByParam = (req.query['sort_by'] as string | undefined) ?? 'occurrence_count';
      const sortBy = validSortBy.includes(sortByParam) ? sortByParam : 'occurrence_count';

      const sortOrderParam = (req.query['sort_order'] as string | undefined) ?? 'desc';
      const sortOrder = sortOrderParam === 'asc' ? 'ASC' : 'DESC';

      const triggerTypeParam = req.query['trigger_type'] as string | undefined;
      const validTriggerTypes = ['user_negative', 'no_rag', 'low_confidence', 'fallback', 'judge_low'];
      const triggerType = triggerTypeParam && validTriggerTypes.includes(triggerTypeParam) ? triggerTypeParam : undefined;

      const periodParam = req.query['period'] as string | undefined;
      const validPeriods = ['7', '30', '90'];
      const period = periodParam && validPeriods.includes(periodParam) ? parseInt(periodParam, 10) : null;

      const searchParam = (req.query['search'] as string | undefined)?.trim() ?? '';

      const orderBy = (() => {
        switch (sortBy) {
          case 'created_at': return `created_at ${sortOrder}`;
          case 'status': return `status ${sortOrder}`;
          case 'trigger_type': return `COALESCE(detection_source, '') ${sortOrder}`;
          default: return `COALESCE(frequency,0) ${sortOrder}, COALESCE(last_detected_at, created_at) DESC`;
        }
      })();

      const limit = Math.max(1, Math.min(parseInt((req.query['limit'] as string) ?? '20', 10) || 20, 200));
      const offset = Math.max(0, parseInt((req.query['offset'] as string) ?? '0', 10) || 0);

      try {
        const pool = getPool();
        const conditions: string[] = ['status = $1'];
        const args: unknown[] = [status];

        if (tenantFilter) {
          conditions.push(`tenant_id = $${args.length + 1}`);
          args.push(tenantFilter);
        }

        if (triggerType) {
          conditions.push(`detection_source = $${args.length + 1}`);
          args.push(triggerType);
        }

        if (period !== null) {
          conditions.push(`COALESCE(last_detected_at, created_at) >= NOW() - INTERVAL '${period} days'`);
        }

        if (searchParam) {
          conditions.push(`user_question ILIKE $${args.length + 1}`);
          args.push(`%${searchParam}%`);
        }

        const where = `WHERE ${conditions.join(' AND ')}`;

        const countResult = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM knowledge_gaps ${where}`,
          args,
        );
        const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

        const listArgs = [...args, limit, offset];
        const listResult = await pool.query<KnowledgeGapRow>(
          `SELECT id, tenant_id, user_question, session_id, rag_hit_count, rag_top_score,
                  status, frequency, detection_source, recommended_action, suggested_answer,
                  recommendation_status, last_detected_at, created_at
           FROM knowledge_gaps
           ${where}
           ORDER BY ${orderBy}
           LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          listArgs,
        );

        // Lazy: fire-and-forget generation if there are pending gaps with no recommendation
        const hasPendingWithoutRec = listResult.rows.some(
          (g: KnowledgeGapRow) => g.recommendation_status === 'pending' && !g.recommended_action,
        );
        if (hasPendingWithoutRec && tenantFilter) {
          const _tid = tenantFilter;
          setImmediate(() => {
            generateRecommendations(_tid).catch(() => {});
          });
        }

        return res.json({ items: listResult.rows, gaps: listResult.rows, total, limit, offset });
      } catch (err) {
        logger.warn({ err }, 'GET /knowledge-gaps failed');
        return res.status(500).json({ error: '一覧の取得に失敗しました' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/admin/knowledge-gaps/:id
  // body に応じて2つの異なる関心事のどちらかを更新する(1エンドポイントに統合。
  // 2026-08-25是正: 旧 knowledgeGapRoutes.ts が別ファイル・別カラムで
  // 同種のPATCHを実装していたため統合した):
  //   { action: 'approve'|'dismiss' } → recommendation_status(AI推薦の承認状態)
  //   { status: 'resolved'|'dismissed', resolved_faq_id? } → status(ギャップ自体のライフサイクル)
  // -------------------------------------------------------------------------
  app.patch(
    '/v1/admin/knowledge-gaps/:id',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const id = parseInt(req.params['id'] ?? '', 10);
      if (isNaN(id)) return res.status(400).json({ error: 'id が不正です' });

      const { su, role, jwtTenantId, isSuperAdmin } = resolveJwt(req);
      if (!isAllowedKgPhase46Role(role)) {
        return denyKgPhase46Role(req, res, su, role);
      }

      const actionParsed = recommendationActionSchema.safeParse(req.body);
      const statusParsed = gapStatusUpdateSchema.safeParse(req.body);
      if (!actionParsed.success && !statusParsed.success) {
        return res.status(400).json({
          error: '入力が不正です',
          issues: [...actionParsed.error.issues, ...statusParsed.error.issues],
        });
      }

      try {
        const pool = getPool();
        const tenantCondition = isSuperAdmin ? '' : ' AND tenant_id = $3';

        // 'approve' は approveGapRecommendation() を共有する
        // (チャットツール approve_gap_recommendation と同じ実装)。
        if (actionParsed.success && actionParsed.data.action === 'approve') {
          const approveResult = await approveGapRecommendation(id, jwtTenantId, isSuperAdmin);
          if (!approveResult.ok) {
            return res.status(404).json({ error: 'ギャップが見つかりません' });
          }
          return res.json({ ok: true });
        }

        let result;
        if (actionParsed.success) {
          // 'dismiss'
          const args: unknown[] = ['dismissed', id];
          if (!isSuperAdmin) args.push(jwtTenantId);
          result = await pool.query(
            `UPDATE knowledge_gaps SET recommendation_status = $1 WHERE id = $2${tenantCondition}`,
            args,
          );
        } else {
          const { status, resolved_faq_id } = statusParsed.data!;
          const args: unknown[] = [status, resolved_faq_id ?? null, id];
          const tenantConditionForStatus = isSuperAdmin ? '' : ' AND tenant_id = $4';
          if (!isSuperAdmin) args.push(jwtTenantId);
          result = await pool.query(
            `UPDATE knowledge_gaps
             SET status = $1, resolved_faq_id = COALESCE($2, resolved_faq_id)
             WHERE id = $3${tenantConditionForStatus}`,
            args,
          );
        }

        if ((result.rowCount ?? 0) === 0) {
          return res.status(404).json({ error: 'ギャップが見つかりません' });
        }
        return res.json({ ok: true });
      } catch (err) {
        logger.warn({ err, id }, 'PATCH /knowledge-gaps/:id failed');
        return res.status(500).json({ error: '更新に失敗しました' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge-gaps/generate-recommendations
  // super_admin のみ: Gemini でバッチ提案生成
  // -------------------------------------------------------------------------
  app.post(
    '/v1/admin/knowledge-gaps/generate-recommendations',
    supabaseAuthMiddleware,
    superAdminMiddleware,
    async (req: Request, res: Response) => {
      const parsed = generateRecommendationsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: '入力が不正です', issues: parsed.error.issues });
      }

      try {
        const recommendations = await generateRecommendations(parsed.data.tenant_id);
        return res.json({ recommendations, count: recommendations.length });
      } catch (err) {
        logger.warn({ err }, 'POST /knowledge-gaps/generate-recommendations failed');
        return res.status(500).json({ error: '提案生成に失敗しました' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge-gaps/:id/add-knowledge
  // Gapからインラインナレッジを追加 → faq_docs + embeddings + ES
  // -------------------------------------------------------------------------
  app.post(
    '/v1/admin/knowledge-gaps/:id/add-knowledge',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const id = parseInt(req.params['id'] ?? '', 10);
      if (isNaN(id)) return res.status(400).json({ error: 'id が不正です' });

      const { su, role, jwtTenantId, isSuperAdmin } = resolveJwt(req);
      if (!isAllowedKgPhase46Role(role)) {
        return denyKgPhase46Role(req, res, su, role);
      }

      const parsed = addKnowledgeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: '入力が不正です', issues: parsed.error.issues });
      }

      try {
        const { answer_text, category } = parsed.data;
        const result = await addKnowledgeFromGap(id, answer_text, category ?? null, jwtTenantId, isSuperAdmin);

        if (!result.ok) {
          if (result.reason === 'not_found') {
            return res.status(404).json({ error: 'ギャップが見つかりません' });
          }
          if (result.reason === 'forbidden') {
            return res.status(403).json({ error: 'forbidden' });
          }
          return res.status(409).json({ error: 'approved 状態のギャップのみナレッジを追加できます' });
        }

        return res.json({ success: true, faq_doc_id: result.faqDocId });
      } catch (err) {
        logger.warn({ err, id }, 'POST /knowledge-gaps/:id/add-knowledge failed');
        return res.status(500).json({ error: 'ナレッジ追加に失敗しました' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/admin/knowledge-gaps/:id/suggest-answer
  // Phase52d: Gemini AI による回答案自動生成
  // -------------------------------------------------------------------------
  app.post(
    '/v1/admin/knowledge-gaps/:id/suggest-answer',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const id = parseInt(req.params['id'] ?? '', 10);
      if (isNaN(id)) return res.status(400).json({ error: 'id が不正です' });

      const { su, role, jwtTenantId, isSuperAdmin } = resolveJwt(req);
      if (!isAllowedKgPhase46Role(role)) {
        return denyKgPhase46Role(req, res, su, role);
      }

      try {
        const pool = getPool();

        // 1. knowledge_gaps レコード取得
        const gapResult = await pool.query<{
          id: number;
          tenant_id: string;
          user_question: string;
          frequency: number | null;
        }>(
          `SELECT id, tenant_id, user_question, frequency
           FROM knowledge_gaps
           WHERE id = $1`,
          [id],
        );

        if (gapResult.rows.length === 0) {
          return res.status(404).json({ error: 'ギャップが見つかりません' });
        }

        const gap = gapResult.rows[0]!;

        // テナント検証: client_admin は自テナントのみ
        if (!isSuperAdmin && gap.tenant_id !== jwtTenantId) {
          return res.status(403).json({ error: 'forbidden' });
        }

        // 2. テナントの system_prompt 取得
        const tenantResult = await pool.query<{ system_prompt: string | null }>(
          `SELECT system_prompt FROM tenants WHERE id = $1`,
          [gap.tenant_id],
        );
        const systemPrompt = tenantResult.rows[0]?.system_prompt ?? '（テナント情報なし）';

        // 3. faq_docs から関連ナレッジを取得（上位3件、Anti-Slop: 200文字以内）
        const faqResult = await pool.query<{ question: string; answer: string }>(
          `SELECT question, answer FROM faq_docs
           WHERE tenant_id = $1 AND is_published = true
           ORDER BY created_at DESC
           LIMIT 3`,
          [gap.tenant_id],
        );
        const relatedDocs = faqResult.rows;
        const relatedText = relatedDocs.length > 0
          ? relatedDocs
              .map((f: { question: string; answer: string }) => `Q: ${f.question.slice(0, 100)}\nA: ${f.answer.slice(0, 200)}`)
              .join('\n\n')
          : '（関連ナレッジなし）';
        const sources = relatedDocs.map((f: { question: string; answer: string }) => f.question.slice(0, 80));

        // 4. Gemini で回答案生成
        const occurrenceCount = gap.frequency ?? 1;
        const prompt = `あなたはBtoB営業サイトのFAQナレッジライターです。
以下の顧客質問に対する回答を作成してください。

【質問】${gap.user_question}
【テナント情報】${systemPrompt.slice(0, 500)}
【関連する既存ナレッジ】
${relatedText}
【この質問が聞かれた回数】${occurrenceCount}回

要件:
- 顧客が知りたい情報を簡潔に回答（200文字以内）
- 専門用語を避け、わかりやすい言葉で
- 嘘や推測は含めない。不明な部分は「詳しくはお問い合わせください」
- コンバージョンにつながる一言を最後に添える（例:「お気軽にご相談ください」）

回答のみを出力してください。前置きや説明は不要です。`;

        const suggestedAnswer = await callGeminiJudge(prompt);

        return res.json({
          suggested_answer: suggestedAnswer.trim().slice(0, 500),
          sources,
          question: gap.user_question,
        });
      } catch (err) {
        logger.warn({ err, id }, 'POST /knowledge-gaps/:id/suggest-answer failed');
        return res.status(500).json({ error: 'AI回答案の生成に失敗しました。しばらく経ってから再試行してください。' });
      }
    },
  );
}
