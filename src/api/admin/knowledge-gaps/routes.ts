// src/api/admin/knowledge-gaps/routes.ts
// Phase46 Stream B: Knowledge Gap 管理 API（推薦・承認・ナレッジ追加）

import type { Express, Request, Response } from 'express';
import pino from 'pino';
import { z } from 'zod';
import { getPool } from '../../../lib/db';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { superAdminMiddleware } from '../tenants/superAdminMiddleware';
import { embedText } from '../../../agent/llm/openaiEmbeddingClient';
import { generateRecommendations } from '../../../agent/gap/gapRecommender';

const logger = pino();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function resolveJwt(req: Request): { jwtTenantId: string; isSuperAdmin: boolean; isClientAdmin: boolean } {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const role: string = su?.app_metadata?.role ?? su?.user_metadata?.role ?? '';
  const isSuperAdmin = role === 'super_admin';
  const isClientAdmin = role === 'client_admin';
  return { jwtTenantId, isSuperAdmin, isClientAdmin };
}

// ---------------------------------------------------------------------------
// Embedding + ES helpers (fire-and-forget, same pattern as faqCrudRoutes)
// ---------------------------------------------------------------------------

function insertEmbeddingAsync(
  tenantId: string,
  text: string,
  faqId: number,
): void {
  const pool = getPool();
  embedText(text)
    .then((vec) =>
      pool.query(
        'INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata) VALUES ($1, $2, $3::vector, $4::jsonb)',
        [tenantId, text, `[${vec.join(',')}]`, JSON.stringify({ faq_id: faqId, source: 'knowledge_gap_resolution' })],
      ),
    )
    .catch((e: unknown) => logger.warn({ err: e, faqId }, 'knowledge-gaps: embedding insert failed'));
}

function upsertToEsAsync(
  tenantId: string,
  faqId: number,
  question: string,
  answer: string,
): void {
  const esUrl = process.env['ES_URL'];
  const index = process.env['ES_FAQ_INDEX'] ?? 'faqs';
  if (!esUrl) return;
  const doc = { tenant_id: tenantId, question, answer, faq_id: faqId, is_published: true };
  const url = `${esUrl.replace(/\/$/, '')}/${index}/_doc/${faqId}_${tenantId}`;
  fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const recommendationActionSchema = z.object({
  action: z.enum(['approve', 'dismiss']),
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
// Route registration
// ---------------------------------------------------------------------------

export function registerKnowledgeGapPhase46Routes(app: Express): void {

  // -------------------------------------------------------------------------
  // GET /v1/admin/knowledge-gaps
  // frequency DESC + last_detected_at DESC デフォルトソート
  // -------------------------------------------------------------------------
  app.get(
    '/v1/admin/knowledge-gaps',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const { jwtTenantId, isSuperAdmin, isClientAdmin } = resolveJwt(req);
      if (!isSuperAdmin && !isClientAdmin) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const tenantFilter = isSuperAdmin
        ? ((req.query['tenant_id'] as string | undefined) || undefined)
        : jwtTenantId;

      if (!isSuperAdmin && !tenantFilter) {
        return res.status(400).json({ error: 'tenant が解決できません' });
      }

      const statusParam = (req.query['status'] as string | undefined) ?? 'open';
      const validStatuses = ['open', 'resolved', 'dismissed'];
      const status = validStatuses.includes(statusParam) ? statusParam : 'open';

      const sortParam = (req.query['sort'] as string | undefined) ?? 'frequency';
      const orderBy = sortParam === 'created_at' ? 'created_at DESC' : 'COALESCE(frequency,1) DESC, COALESCE(last_detected_at, created_at) DESC';

      const limit = Math.max(1, Math.min(parseInt((req.query['limit'] as string) ?? '50', 10) || 50, 200));
      const offset = Math.max(0, parseInt((req.query['offset'] as string) ?? '0', 10) || 0);

      try {
        const pool = getPool();
        const conditions: string[] = ['status = $1'];
        const args: unknown[] = [status];

        if (tenantFilter) {
          conditions.push(`tenant_id = $${args.length + 1}`);
          args.push(tenantFilter);
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

        return res.json({ gaps: listResult.rows, total, limit, offset });
      } catch (err) {
        logger.warn({ err }, 'GET /knowledge-gaps failed');
        return res.status(500).json({ error: '一覧の取得に失敗しました' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/admin/knowledge-gaps/:id
  // approve / dismiss → recommendation_status を更新
  // -------------------------------------------------------------------------
  app.patch(
    '/v1/admin/knowledge-gaps/:id',
    supabaseAuthMiddleware,
    async (req: Request, res: Response) => {
      const id = parseInt(req.params['id'] ?? '', 10);
      if (isNaN(id)) return res.status(400).json({ error: 'id が不正です' });

      const { jwtTenantId, isSuperAdmin, isClientAdmin } = resolveJwt(req);
      if (!isSuperAdmin && !isClientAdmin) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const parsed = recommendationActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: '入力が不正です', issues: parsed.error.issues });
      }

      const newStatus = parsed.data.action === 'approve' ? 'approved' : 'dismissed';

      try {
        const pool = getPool();
        const tenantCondition = isSuperAdmin ? '' : ' AND tenant_id = $3';
        const args: unknown[] = [newStatus, id];
        if (!isSuperAdmin) args.push(jwtTenantId);

        const result = await pool.query(
          `UPDATE knowledge_gaps
           SET recommendation_status = $1
           WHERE id = $2${tenantCondition}`,
          args,
        );

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

      const { jwtTenantId, isSuperAdmin, isClientAdmin } = resolveJwt(req);
      if (!isSuperAdmin && !isClientAdmin) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const parsed = addKnowledgeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: '入力が不正です', issues: parsed.error.issues });
      }

      try {
        const pool = getPool();

        // Gapを取得（recommendation_status='approved'かつテナント一致）
        const gapResult = await pool.query<{ id: number; tenant_id: string; user_question: string; recommendation_status: string }>(
          `SELECT id, tenant_id, user_question, recommendation_status
           FROM knowledge_gaps
           WHERE id = $1`,
          [id],
        );

        if (gapResult.rows.length === 0) {
          return res.status(404).json({ error: 'ギャップが見つかりません' });
        }

        const gap = gapResult.rows[0]!;

        // テナント検証: JWTのテナントとGapのテナントが一致すること（super_adminは免除）
        if (!isSuperAdmin && gap.tenant_id !== jwtTenantId) {
          return res.status(403).json({ error: 'forbidden' });
        }

        if (gap.recommendation_status !== 'approved') {
          return res.status(409).json({ error: 'approved 状態のギャップのみナレッジを追加できます' });
        }

        const { answer_text, category } = parsed.data;

        // faq_docs に INSERT
        const faqResult = await pool.query<{ id: number }>(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id`,
          [
            gap.tenant_id,
            gap.user_question.slice(0, 500),
            answer_text.slice(0, 2000),
            category ?? null,
          ],
        );

        const faqDocId = faqResult.rows[0]!.id;

        // embedding を非同期生成（fire-and-forget）
        insertEmbeddingAsync(gap.tenant_id, answer_text.slice(0, 2000), faqDocId);

        // ES に非同期 upsert（fire-and-forget）
        upsertToEsAsync(gap.tenant_id, faqDocId, gap.user_question, answer_text);

        // Gap のステータスを resolved に更新
        await pool.query(
          `UPDATE knowledge_gaps
           SET status = 'resolved',
               recommendation_status = 'resolved',
               resolved_faq_id = $1
           WHERE id = $2`,
          [faqDocId, id],
        );

        return res.json({ success: true, faq_doc_id: faqDocId });
      } catch (err) {
        logger.warn({ err, id }, 'POST /knowledge-gaps/:id/add-knowledge failed');
        return res.status(500).json({ error: 'ナレッジ追加に失敗しました' });
      }
    },
  );
}
