// src/api/admin/variants/variantsRepository.ts
// Phase46: バリアントCRUD リポジトリ（Stream A）
// tenants.system_prompt_variants は JSONB カラム: [{ id, name, prompt, weight }]

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
  avg_score: number;
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
    avg_score: string;
    conversation_count: string;
  }>(
    `SELECT
       cs.prompt_variant_id,
       COALESCE(AVG(e.score), 0) AS avg_score,
       COUNT(DISTINCT cs.id) AS conversation_count
     FROM chat_sessions cs
     LEFT JOIN conversation_evaluations e ON e.session_id = cs.id::text
     WHERE cs.tenant_id = $1
       AND cs.created_at >= NOW() - INTERVAL '${days} days'
       AND cs.prompt_variant_id IS NOT NULL
     GROUP BY cs.prompt_variant_id`,
    [tenantId],
  );

  const statsMap: Record<string, { avg_score: number; conversation_count: number }> = {};
  for (const row of result.rows) {
    statsMap[row.prompt_variant_id] = {
      avg_score: parseFloat(row.avg_score),
      conversation_count: parseInt(row.conversation_count, 10),
    };
  }

  return variantRows.map((v) => ({
    id: v.id,
    name: v.name,
    weight: v.weight,
    avg_score: statsMap[v.id]?.avg_score ?? 0,
    conversation_count: statsMap[v.id]?.conversation_count ?? 0,
  }));
}
