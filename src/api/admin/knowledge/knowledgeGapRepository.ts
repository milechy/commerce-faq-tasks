// src/api/admin/knowledge/knowledgeGapRepository.ts
// Phase38+: ナレッジギャップ DB リポジトリ

// @ts-ignore
import { Pool } from "pg";

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface KnowledgeGap {
  id: number;
  tenant_id: string;
  user_question: string;
  session_id: string | null;
  message_id: number | null;
  rag_hit_count: number;
  rag_top_score: number;
  status: "open" | "resolved" | "dismissed";
  resolved_faq_id: number | null;
  created_at: string;
}

export interface SaveGapParams {
  tenantId: string;
  userQuestion: string;
  sessionId?: string | null;
  messageId?: number | null;
  ragHitCount?: number;
  ragTopScore?: number;
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

/**
 * ナレッジギャップを保存する。
 * 同一テナント・同一質問が直近24h以内に既に open で存在する場合はスキップ（重複抑制）。
 */
export async function saveKnowledgeGap(params: SaveGapParams): Promise<void> {
  const pool = getPool();

  // 重複チェック: 同じ質問が24h以内に open で記録済みならスキップ
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM knowledge_gaps
     WHERE tenant_id = $1
       AND user_question = $2
       AND status = 'open'
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [params.tenantId, params.userQuestion],
  );
  if (existing.rows.length > 0) return;

  await pool.query(
    `INSERT INTO knowledge_gaps
       (tenant_id, user_question, session_id, message_id, rag_hit_count, rag_top_score)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.tenantId,
      params.userQuestion,
      params.sessionId ?? null,
      params.messageId ?? null,
      params.ragHitCount ?? 0,
      params.ragTopScore ?? 0,
    ],
  );
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

export interface GetGapsParams {
  tenantId?: string;  // undefined = super_admin (全テナント)
  status?: "open" | "resolved" | "dismissed";
  limit?: number;
  offset?: number;
}

export async function getGaps(
  params: GetGapsParams,
): Promise<{ gaps: KnowledgeGap[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;
  const status = params.status ?? "open";

  const conditions: string[] = [`status = $1`];
  const args: unknown[] = [status];

  if (params.tenantId) {
    conditions.push(`tenant_id = $${args.length + 1}`);
    args.push(params.tenantId);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM knowledge_gaps ${whereClause}`,
    args,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const limitPos = args.length + 1;
  const offsetPos = args.length + 2;
  const listArgs = [...args, limit, offset];
  const listResult = await pool.query<KnowledgeGap>(
    `SELECT id, tenant_id, user_question, session_id, message_id,
            rag_hit_count, rag_top_score, status, resolved_faq_id, created_at
     FROM knowledge_gaps
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${limitPos} OFFSET $${offsetPos}`,
    listArgs,
  );

  return { gaps: listResult.rows, total };
}

/**
 * open なギャップ件数を返す（ダッシュボードバッジ用）。
 */
export async function getGapCount(tenantId?: string): Promise<number> {
  const pool = getPool();

  const result = await pool.query<{ count: string }>(
    tenantId
      ? `SELECT COUNT(*) AS count FROM knowledge_gaps WHERE tenant_id = $1 AND status = 'open'`
      : `SELECT COUNT(*) AS count FROM knowledge_gaps WHERE status = 'open'`,
    tenantId ? [tenantId] : [],
  );

  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * ギャップのステータスを更新する。
 */
export async function updateGapStatus(
  id: number,
  status: "resolved" | "dismissed",
  tenantId?: string,
  resolvedFaqId?: number | null,
): Promise<boolean> {
  const pool = getPool();

  const whereClause = tenantId
    ? `WHERE id = $3 AND tenant_id = $4`
    : `WHERE id = $3`;
  const args: unknown[] = [status, resolvedFaqId ?? null, id];
  if (tenantId) args.push(tenantId);

  const result = await pool.query(
    `UPDATE knowledge_gaps
     SET status = $1, resolved_faq_id = $2
     ${whereClause}`,
    args,
  );

  return (result.rowCount ?? 0) > 0;
}
