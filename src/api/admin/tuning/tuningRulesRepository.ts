// src/api/admin/tuning/tuningRulesRepository.ts
// Phase38 Step4-BE: チューニングルール DB リポジトリ

import { getPool } from "../../../lib/db";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ApprovedResponse {
  text: string;
  style: string;
  reason?: string;
  approved_at: string;
}

export interface TuningRule {
  id: number;
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority: number;
  is_active: boolean;
  created_by: string | null;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
  approved_responses?: ApprovedResponse[];
}

export interface CreateRuleParams {
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority?: number;
  created_by?: string;
  source_message_id?: number | null;
}

export interface UpdateRuleParams {
  trigger_pattern?: string;
  expected_behavior?: string;
  priority?: number;
  is_active?: boolean;
  approved_responses?: ApprovedResponse[];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * ルール一覧取得。
 * - tenantId 指定: そのテナント + global のルールを返す
 * - tenantId 未指定 (super_admin): 全ルールを返す
 * - ORDER: tenant_id = 'global' を後ろ、各グループ内で priority DESC
 */
export async function listRules(tenantId?: string): Promise<TuningRule[]> {
  const pool = getPool();

  if (tenantId) {
    const result = await pool.query<TuningRule>(
      `SELECT id, tenant_id, trigger_pattern, expected_behavior,
              priority, is_active, created_by, source_message_id,
              created_at, updated_at
       FROM tuning_rules
       WHERE tenant_id = $1 OR tenant_id = 'global'
       ORDER BY
         CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
         priority DESC`,
      [tenantId],
    );
    return result.rows;
  }

  // super_admin: 全ルール
  const result = await pool.query<TuningRule>(
    `SELECT id, tenant_id, trigger_pattern, expected_behavior,
            priority, is_active, created_by, source_message_id,
            created_at, updated_at
     FROM tuning_rules
     ORDER BY
       CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
       priority DESC`,
  );
  return result.rows;
}

/**
 * アクティブなルールをテナント用に取得（RAG / プロンプト注入向け）。
 * テナント固有ルールを先に、次に global ルール、各グループ内で priority DESC。
 */
export async function getActiveRulesForTenant(
  tenantId: string,
): Promise<TuningRule[]> {
  const pool = getPool();

  const result = await pool.query<TuningRule>(
    `SELECT id, tenant_id, trigger_pattern, expected_behavior,
            priority, is_active, created_by, source_message_id,
            created_at, updated_at
     FROM tuning_rules
     WHERE (tenant_id = $1 OR tenant_id = 'global')
       AND is_active = true
     ORDER BY
       CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
       priority DESC`,
    [tenantId],
  );
  return result.rows;
}

/** ルール作成。RETURNING * で作成済み行を返す。 */
export async function createRule(params: CreateRuleParams): Promise<TuningRule> {
  const pool = getPool();

  const result = await pool.query<TuningRule>(
    `INSERT INTO tuning_rules
       (tenant_id, trigger_pattern, expected_behavior, priority,
        created_by, source_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, trigger_pattern, expected_behavior,
               priority, is_active, created_by, source_message_id,
               created_at, updated_at, approved_responses`,
    [
      params.tenant_id,
      params.trigger_pattern,
      params.expected_behavior,
      params.priority ?? 0,
      params.created_by ?? null,
      params.source_message_id ?? null,
    ],
  );

  return result.rows[0]!;
}

/**
 * ルール更新。
 * tenantId を渡すことで所有権を検証（super_admin は undefined を渡して全権）。
 * 対象が見つからない / テナント不一致 の場合は null を返す。
 */
export async function updateRule(
  id: number,
  params: UpdateRuleParams,
  tenantId?: string,
): Promise<TuningRule | null> {
  const pool = getPool();

  // 存在 + 所有権確認
  const check = await pool.query<{ id: number; tenant_id: string }>(
    `SELECT id, tenant_id FROM tuning_rules WHERE id = $1`,
    [id],
  );
  if (check.rows.length === 0) return null;
  if (tenantId && check.rows[0]!.tenant_id !== tenantId) return null;

  const approvedJson =
    params.approved_responses !== undefined
      ? JSON.stringify(params.approved_responses)
      : null;

  const result = await pool.query<TuningRule>(
    `UPDATE tuning_rules SET
       trigger_pattern   = COALESCE($1, trigger_pattern),
       expected_behavior = COALESCE($2, expected_behavior),
       priority          = COALESCE($3, priority),
       is_active         = COALESCE($4, is_active),
       approved_responses = CASE WHEN $5::text IS NOT NULL THEN $5::jsonb ELSE approved_responses END,
       updated_at        = NOW()
     WHERE id = $6
     RETURNING id, tenant_id, trigger_pattern, expected_behavior,
               priority, is_active, created_by, source_message_id,
               created_at, updated_at, approved_responses`,
    [
      params.trigger_pattern ?? null,
      params.expected_behavior ?? null,
      params.priority ?? null,
      params.is_active ?? null,
      approvedJson,
      id,
    ],
  );

  return result.rows[0] ?? null;
}

/**
 * ルール削除。
 * - tenantId 指定: 自テナントのルールのみ削除可
 * - tenantId 未指定 (super_admin): 制限なし
 * 対象が見つからない / テナント不一致 の場合は false を返す。
 */
export async function deleteRule(
  id: number,
  tenantId?: string,
): Promise<boolean> {
  const pool = getPool();

  const whereClause = tenantId
    ? `WHERE id = $1 AND tenant_id = $2`
    : `WHERE id = $1`;
  const args: unknown[] = tenantId ? [id, tenantId] : [id];

  const result = await pool.query(
    `DELETE FROM tuning_rules ${whereClause}`,
    args,
  );

  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// テナント固有システムプロンプト取得
// ---------------------------------------------------------------------------

/**
 * tenants.system_prompt を取得する。
 * カラムが存在しない / 空の場合は null を返す。
 * テーブルまたはカラムが存在しない場合は null を返す（migration未実行環境でも安全）。
 */
async function getTenantSystemPrompt(
  tenantId: string,
): Promise<string | null> {
  const pool = getPool();
  try {
    const result = await pool.query<{ system_prompt: string | null }>(
      `SELECT system_prompt FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const raw = result.rows[0]?.system_prompt;
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    // カラム未追加など（migration前のデプロイ）は null を返す
    return null;
  }
}

// ---------------------------------------------------------------------------
// プロンプト注入用ユーティリティ
// ---------------------------------------------------------------------------

/**
 * アクティブなチューニングルールをシステムプロンプト用テキストに変換する。
 * ルールが空の場合は空文字を返す（呼び出し元で条件分岐不要）。
 *
 * 出力例:
 * 以下の応答ルールに従ってください（優先度順）:
 * - 「返品」に関する質問 → 7日以内の返品を案内し、手続きURLを提示する
 * - 「在庫」に関する質問 → 在庫確認は店舗に電話するよう案内する
 */
export function buildTuningPromptSection(rules: TuningRule[]): string {
  if (rules.length === 0) return "";

  const lines = rules.map(
    (r) => `- 「${r.trigger_pattern}」に関する質問 → ${r.expected_behavior}`,
  );

  return `以下の応答ルールに従ってください（優先度順）:\n${lines.join("\n")}`;
}
