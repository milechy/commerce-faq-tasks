// src/api/admin/variants/variantsRepository.ts
// Phase46: バリアントCRUD リポジトリ（Stream A）
// tenants.system_prompt_variants は JSONB カラム: [{ id, name, prompt, weight }]

import { getPool } from "../../../lib/db";
import { userSourceClause } from "../analytics/summaryQueries";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface SystemPromptVariant {
  id: string;
  name: string;
  prompt: string;
  weight: number;
}

export interface VariantStatRow {
  id: string;
  name: string;
  weight: number;
  // CLAUDE.md 禁止34: 母数不足(会話0件)を数値0と区別するためnullを許容する
  avg_score: number | null;
  conversation_count: number;
}

// ---------------------------------------------------------------------------
// バリアント一覧取得（tenants.system_prompt_variants JSONB）
// ---------------------------------------------------------------------------

export async function listVariants(tenantId: string): Promise<SystemPromptVariant[]> {
  const pool = getPool();
  const result = await pool.query<{ system_prompt_variants: SystemPromptVariant[] | null }>(
    `SELECT system_prompt_variants FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return result.rows[0]?.system_prompt_variants ?? [];
}

// ---------------------------------------------------------------------------
// バリアント一括更新（JSONB カラムを丸ごと上書き）
// ---------------------------------------------------------------------------

export async function upsertVariants(
  tenantId: string,
  variants: SystemPromptVariant[],
): Promise<SystemPromptVariant[]> {
  const pool = getPool();
  const result = await pool.query<{ system_prompt_variants: SystemPromptVariant[] }>(
    `UPDATE tenants
     SET system_prompt_variants = $1::jsonb,
         updated_at = NOW()
     WHERE id = $2
     RETURNING system_prompt_variants`,
    [JSON.stringify(variants), tenantId],
  );
  return result.rows[0]?.system_prompt_variants ?? variants;
}

// ---------------------------------------------------------------------------
// バリアント別統計（chat_sessions.prompt_variant_id + conversation_evaluations JOIN）
// ---------------------------------------------------------------------------

export async function getVariantStats(
  tenantId: string,
  days: number,
): Promise<VariantStatRow[]> {
  const pool = getPool();

  // JSONB からバリアント一覧を取得
  const variantRows = await listVariants(tenantId);

  if (variantRows.length === 0) {
    return [];
  }

  // chat_sessions + conversation_evaluations で variant別集計
  const result = await pool.query<{
    prompt_variant_id: string;
    avg_score: string | null;
    conversation_count: string;
  }>(
    `SELECT
       cs.prompt_variant_id,
       AVG(e.score) AS avg_score,
       COUNT(DISTINCT cs.id) AS conversation_count
     FROM chat_sessions cs
     LEFT JOIN conversation_evaluations e ON e.session_id = cs.session_id
     WHERE cs.tenant_id = $1
       -- chat_sessions の時刻列は started_at(created_at は存在しない)
       AND cs.started_at >= NOW() - INTERVAL '${days} days'
       AND cs.prompt_variant_id IS NOT NULL
       ${userSourceClause("cs")}
     GROUP BY cs.prompt_variant_id`,
    [tenantId],
  );

  // CLAUDE.md 禁止34: 母数不足(評価が1件も無い)ときの avg_score は 0 ではなく null
  // (AVGはグループ内が全てNULLなら自動的にNULLを返すため、COALESCEで0に丸めない)
  const statsMap: Record<string, { avg_score: number | null; conversation_count: number }> = {};
  for (const row of result.rows) {
    statsMap[row.prompt_variant_id] = {
      avg_score: row.avg_score != null ? parseFloat(row.avg_score) : null,
      conversation_count: parseInt(row.conversation_count, 10),
    };
  }

  return variantRows.map((v) => ({
    id: v.id,
    name: v.name,
    weight: v.weight,
    avg_score: statsMap[v.id]?.avg_score ?? null,
    conversation_count: statsMap[v.id]?.conversation_count ?? 0,
  }));
}
