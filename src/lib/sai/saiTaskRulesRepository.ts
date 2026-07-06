// src/lib/sai/saiTaskRulesRepository.ts
// Phase6 (Sai Judge学習ループ): sai_task_rules DBリポジトリ
// tuning_rulesRepository.ts と同型のパターン。詳細はmigration_sai_task_rules.sqlを参照。

import { getPool } from '../db';

export interface SaiRuleEvidence {
  taskIds?: string[];
  orderIds?: string[];
  outcome?: string;
  note?: string;
}

export interface SaiTaskRule {
  id: number;
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority: number;
  is_active: boolean;
  status: string;
  source: string;
  evidence: SaiRuleEvidence | null;
  created_by: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListSaiRulesFilters {
  source?: string;
  status?: string;
}

export interface CreateSaiRuleParams {
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority?: number;
  source?: string;
  evidence?: SaiRuleEvidence;
  created_by?: string;
}

const SELECT_COLUMNS = `id, tenant_id, trigger_pattern, expected_behavior, priority, is_active,
       status, source, evidence, created_by, approved_at, rejected_at, created_at, updated_at`;

/**
 * ルール一覧取得。
 * - tenantId指定: そのテナント + global のルールを返す
 * - tenantId未指定(super_admin): 全ルールを返す
 */
export async function listSaiRules(tenantId?: string, filters?: ListSaiRulesFilters): Promise<SaiTaskRule[]> {
  const pool = getPool();

  const args: string[] = tenantId ? [tenantId] : [];
  const conditions: string[] = tenantId ? ["(tenant_id = $1 OR tenant_id = 'global')"] : [];
  if (filters?.source) { args.push(filters.source); conditions.push(`source = $${args.length}`); }
  if (filters?.status) { args.push(filters.status); conditions.push(`status = $${args.length}`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<SaiTaskRule>(
    `SELECT ${SELECT_COLUMNS}
     FROM sai_task_rules
     ${whereClause}
     ORDER BY
       CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
       priority DESC, created_at DESC`,
    args,
  );
  return result.rows;
}

/**
 * 注入対象のアクティブなルールを取得する(Agent Sへの指示注入向け)。
 * is_active=true(=承認済み)のもののみ。
 */
export async function getActiveSaiRulesForTenant(tenantId: string): Promise<SaiTaskRule[]> {
  const pool = getPool();

  const result = await pool.query<SaiTaskRule>(
    `SELECT ${SELECT_COLUMNS}
     FROM sai_task_rules
     WHERE (tenant_id = $1 OR tenant_id = 'global')
       AND is_active = true
     ORDER BY
       CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
       priority DESC`,
    [tenantId],
  );
  return result.rows;
}

/** ルール提案の作成。Sai Judge(将来実装)が実行ログから抽出した提案をpending状態で挿入する。 */
export async function insertSuggestedSaiRule(params: CreateSaiRuleParams): Promise<SaiTaskRule> {
  const pool = getPool();

  const result = await pool.query<SaiTaskRule>(
    `INSERT INTO sai_task_rules
       (tenant_id, trigger_pattern, expected_behavior, priority, source, evidence, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [
      params.tenant_id,
      params.trigger_pattern,
      params.expected_behavior,
      params.priority ?? 0,
      params.source ?? 'sai_judge',
      params.evidence ? JSON.stringify(params.evidence) : null,
      params.created_by ?? null,
    ],
  );
  return result.rows[0]!;
}

/**
 * ルール承認。status='active'とis_activeを同時に更新する
 * (tuning_rulesでstatusとis_activeが同期していなかった反省を踏まえた設計)。
 */
export async function approveSaiRule(id: number, tenantId?: string): Promise<SaiTaskRule | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = 'WHERE id = $1';
  if (tenantId) {
    where += ' AND tenant_id = $2';
    args.push(tenantId);
  }

  const result = await pool.query<SaiTaskRule>(
    `UPDATE sai_task_rules
     SET status = 'active', is_active = true, approved_at = NOW(), rejected_at = NULL, updated_at = NOW()
     ${where}
     RETURNING ${SELECT_COLUMNS}`,
    args,
  );
  return result.rows[0] ?? null;
}

export async function rejectSaiRule(id: number, tenantId?: string): Promise<SaiTaskRule | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = 'WHERE id = $1';
  if (tenantId) {
    where += ' AND tenant_id = $2';
    args.push(tenantId);
  }

  const result = await pool.query<SaiTaskRule>(
    `UPDATE sai_task_rules
     SET status = 'rejected', is_active = false, rejected_at = NOW(), approved_at = NULL, updated_at = NOW()
     ${where}
     RETURNING ${SELECT_COLUMNS}`,
    args,
  );
  return result.rows[0] ?? null;
}

/** カンマ区切りのtrigger_patternのいずれかが対象テキストに部分一致するか(tuning_rulesと同じ判定方式)。 */
export function matchesSaiTriggerPattern(text: string, triggerPattern: string): boolean {
  const lower = text.toLowerCase();
  return triggerPattern
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .some((k) => lower.includes(k.toLowerCase()));
}

/**
 * アクティブなルールをAgent Sへの指示に注入するテキストに変換する。
 * ルールが空の場合は空文字を返す(呼び出し元で条件分岐不要)。
 */
export function buildSaiPromptSection(rules: SaiTaskRule[]): string {
  if (rules.length === 0) return '';

  const lines = rules.map((r) => `- 「${r.trigger_pattern}」に関する作業 → ${r.expected_behavior}`);
  return `過去の実行結果から得られた注意点(優先度順):\n${lines.join('\n')}`;
}
