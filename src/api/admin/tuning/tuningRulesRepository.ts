// src/api/admin/tuning/tuningRulesRepository.ts
// Phase38 Step4-BE: チューニングルール DB リポジトリ

import { getPool } from "../../../lib/db";
import { sanitizeInput } from "../../../lib/security/inputSanitizer";
import { logger } from "../../../lib/logger";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ApprovedResponse {
  text: string;
  style: string;
  reason?: string;
  approved_at: string;
}

export interface RuleEvidence {
  evaluationIds?: number[];
  effectivePrinciples?: string[];
  failedPrinciples?: string[];
  avgScore?: number;
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
  source?: string;
  status?: string;
  evidence?: RuleEvidence | null;
  /** GID 1217752900578379 (R4): before/after の分岐点。updateRule では初回承認時のみ NOW() を入れる(再承認で上書きしない)。 */
  approved_at?: string | null;
  rejected_at?: string | null;
}

export interface ListRulesFilters {
  /** R6: Judge/Hermes提案を同一一覧に出すため、複数値(配列)を受け付ける */
  source?: string | string[];
  status?: string;
}

// ---------------------------------------------------------------------------
// 共有学習プール S3(要件§6 X1・X2 / 受け入れ G1・E4・E9・E10): global ルール可視性判定
// ---------------------------------------------------------------------------

/**
 * global(tenant_id='global') な tuning_rules 行を「読んでよいか」の判定述語。
 *
 * S1/S2までは「共有プールに出す」側(hermesConsent.ts の share フラグ)だけが同意で
 * 絞られ、「読む」側は無条件に全テナントが global 行の恩恵を受けていた。出す側だけ
 * 絞ると「参加しない」ことが常に得なテナントの最適戦略になり、差別化が成立しない
 * ため、読み取り側にも hermesConsent.ts の resolveLearningConsent と同じ share
 * 判定を適用する(このコメント末尾の優先順位の再現)。
 *
 * バインド変数は $1 = tenantId 固定。呼び出し側は tenantId を必ずクエリの $1 に
 * 置くこと(listRules / getActiveRulesForTenant / judgeEvaluator.ts で共通)。
 *
 * 1クエリで完結させるため EXISTS 相関サブクエリで表現する(回答経路にDBラウンド
 * トリップを追加しない)。対象テナント行が存在しない、または share が真でなければ
 * EXISTS が false になり global 行は返らない(fail-closed)。
 *
 * SQL述語の優先順位は hermesConsent.ts の listHermesConsentingTenantIds と同一にする
 * (新形式 features.learning.share を優先し、features.learning が未設定の場合のみ
 * 旧フラグ features.hermes_raw_data_consent にフォールバック):
 *   (features->'learning'->>'share') = 'true'
 *      OR (
 *           (features->'learning') IS NULL
 *           AND (features->>'hermes_raw_data_consent') = 'true'
 *         )
 *
 * ★この述語はここ1箇所だけで定義する(コピーして各所に書かない)。★
 * ★tenants テーブルのエイリアスは t に固定する★。エイリアスを引数化すると
 * tests/phase38/globalRuleGate.test.ts の正規表現検査(alias t を要求)が
 * 空振りする(PR #896 で FAQ_VISIBILITY_WHERE のエイリアスを固定した際と同じ理由)。
 */
export const GLOBAL_RULE_VISIBILITY_WHERE = `(
        tenant_id = $1
        OR (
          tenant_id = 'global'
          AND EXISTS (
            SELECT 1 FROM tenants t
             WHERE t.id = $1
               AND (
                 (t.features->'learning'->>'share') = 'true'
                 OR (
                      (t.features->'learning') IS NULL
                      AND (t.features->>'hermes_raw_data_consent') = 'true'
                    )
               )
          )
        )
      )`;

export interface CreateRuleParams {
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority?: number;
  is_active?: boolean;
  created_by?: string;
  source_message_id?: number | null;
}

export interface UpdateRuleParams {
  trigger_pattern?: string;
  expected_behavior?: string;
  priority?: number;
  is_active?: boolean;
  approved_responses?: ApprovedResponse[];
  // AI提案(source='judge')の承認/却下時のみ指定する。'active' で承認・'rejected' で却下を記録する。
  // is_active だけでは pending(未承認) と rejected(却下済み) を区別できない
  // (どちらも is_active=false のため)。status が無いと却下済みルールが
  // 承認待ち一覧に出続け、店主には「却下したのに戻ってきた」ように見える。
  status?: 'active' | 'rejected';
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * ルール一覧取得。
 * - tenantId 指定: そのテナントのルール + (S3) share 同意済みなら global のルールも返す
 *   (GLOBAL_RULE_VISIBILITY_WHERE 参照。share=OFF のテナントには global 行を出さない)
 * - tenantId 未指定 (super_admin): 全ルールを返す(share の有無に関わらず全件)
 * - ORDER: tenant_id = 'global' を後ろ、各グループ内で priority DESC
 */
export async function listRules(tenantId?: string, filters?: ListRulesFilters): Promise<TuningRule[]> {
  const pool = getPool();

  const args: unknown[] = tenantId ? [tenantId] : [];
  // S3(GID 1217769376950104): 管理UI一覧も同じ述語でフィルタする方針(既定方針を採用)。
  // share=OFF のテナントに「効かないルール(global)」を一覧に出すのは
  // 「押せるのに何も起きないUI」の禁止に触れるため、share を ON にすれば
  // global 行が現れる、という素直な挙動にする(PR本文に理由を記載)。
  const conditions: string[] = tenantId ? [GLOBAL_RULE_VISIBILITY_WHERE] : [];
  if (filters?.source) {
    // R6: 配列(複数source)なら ANY、単一文字列なら従来通り = で絞り込む
    if (Array.isArray(filters.source)) {
      args.push(filters.source);
      conditions.push(`source = ANY($${args.length})`);
    } else {
      args.push(filters.source);
      conditions.push(`source = $${args.length}`);
    }
  }
  if (filters?.status) { args.push(filters.status); conditions.push(`status = $${args.length}`); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  if (tenantId) {
    const result = await pool.query<TuningRule>(
      `SELECT id, tenant_id, trigger_pattern, expected_behavior,
              priority, is_active, created_by, source_message_id,
              created_at, updated_at, source, status, evidence
       FROM tuning_rules
       ${whereClause}
       ORDER BY
         CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
         priority DESC`,
      args,
    );
    return result.rows;
  }

  // super_admin: 全ルール
  const result = await pool.query<TuningRule>(
    `SELECT id, tenant_id, trigger_pattern, expected_behavior,
            priority, is_active, created_by, source_message_id,
            created_at, updated_at, source, status, evidence
     FROM tuning_rules
     ${whereClause}
     ORDER BY
       CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
       priority DESC`,
    args,
  );
  return result.rows;
}

/**
 * アクティブなルールをテナント用に取得（RAG / プロンプト注入向け）。
 * テナント固有ルールを先に、次に global ルール、各グループ内で priority DESC。
 * S3: global ルールは GLOBAL_RULE_VISIBILITY_WHERE により share 同意済みテナントのみ
 * 返る(1クエリ内の EXISTS 相関サブクエリで判定。追加のDBラウンドトリップなし)。
 */
export async function getActiveRulesForTenant(
  tenantId: string,
): Promise<TuningRule[]> {
  const pool = getPool();

  const result = await pool.query<TuningRule>(
    `SELECT id, tenant_id, trigger_pattern, expected_behavior,
            priority, is_active, created_by, source_message_id,
            created_at, updated_at, approved_responses
     FROM tuning_rules
     WHERE ${GLOBAL_RULE_VISIBILITY_WHERE}
       AND is_active = true
     ORDER BY
       CASE WHEN tenant_id = 'global' THEN 1 ELSE 0 END ASC,
       priority DESC`,
    [tenantId],
  );
  return result.rows;
}

/**
 * ルール作成。RETURNING * で作成済み行を返す。
 * is_active は明示的に渡す(未指定時は true)。列を省略してスキーマ既定に
 * 委ねると、作成モーダルが送る is_active=false が黙って無視される
 * (createSchema で受け付けていなかった旧実装の再発防止)。
 */
export async function createRule(params: CreateRuleParams): Promise<TuningRule> {
  const pool = getPool();

  const result = await pool.query<TuningRule>(
    `INSERT INTO tuning_rules
       (tenant_id, trigger_pattern, expected_behavior, priority, is_active,
        created_by, source_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, trigger_pattern, expected_behavior,
               priority, is_active, created_by, source_message_id,
               created_at, updated_at, approved_responses`,
    [
      params.tenant_id,
      params.trigger_pattern,
      params.expected_behavior,
      params.priority ?? 0,
      params.is_active ?? true,
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

  // D8: is_active が唯一の真実。status で承認/却下を指定した場合はここで
  // is_active を導出し、呼び出し側(actionExecutor / LLMプロンプト)が
  // is_active を渡し忘れても不整合が起きないようにする。
  // status 未指定時は従来通り params.is_active(通常のON/OFF切替)を使う。
  const derivedIsActive =
    params.status === "active"
      ? true
      : params.status === "rejected"
        ? false
        : (params.is_active ?? null);

  const result = await pool.query<TuningRule>(
    `UPDATE tuning_rules SET
       trigger_pattern   = COALESCE($1, trigger_pattern),
       expected_behavior = COALESCE($2, expected_behavior),
       priority          = COALESCE($3, priority),
       is_active         = COALESCE($4, is_active),
       approved_responses = CASE WHEN $5::text IS NOT NULL THEN $5::jsonb ELSE approved_responses END,
       status            = COALESCE($6, status),
       -- GID 1217752900578379 (R4): approveTuningRule/rejectTuningRule と対称の記録を、
       -- チャット経由の承認(status='active'/'rejected')でも行う。効果測定(ruleEffect.ts)は
       -- approved_at を before/after の境界に使うため、これが無いとチャット承認したルールが
       -- 永久に「未承認」として扱われる。初回承認で固定し、再承認では上書きしない
       -- (COALESCE(approved_at, NOW())。観測期間の起点をずらさないため)。却下時はNULLに戻し、
       -- approved_at/rejected_at が同時に非NULLになる状態を作らない(承認↔却下の対称性)。
       approved_at       = CASE WHEN $6 = 'active'   THEN COALESCE(approved_at, NOW())
                                 WHEN $6 = 'rejected' THEN NULL
                                 ELSE approved_at END,
       rejected_at       = CASE WHEN $6 = 'rejected' THEN COALESCE(rejected_at, NOW())
                                 WHEN $6 = 'active'   THEN NULL
                                 ELSE rejected_at END,
       updated_at        = NOW()
     WHERE id = $7
     RETURNING id, tenant_id, trigger_pattern, expected_behavior,
               priority, is_active, created_by, source_message_id,
               created_at, updated_at, approved_responses, source, status, evidence,
               approved_at, rejected_at`,
    [
      params.trigger_pattern ?? null,
      params.expected_behavior ?? null,
      params.priority ?? null,
      derivedIsActive,
      approvedJson,
      params.status ?? null,
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

// ---------------------------------------------------------------------------
// プロンプト注入用ユーティリティ
// ---------------------------------------------------------------------------

// 採用済み返答(文体の見本)1件あたりの最大文字数。システムプロンプトの肥大を防ぐ。
const APPROVED_RESPONSE_MAX_CHARS = 300;

/**
 * ルールが持つ採用済み返答のうち最新の1件を「文体の見本」として整形する。
 * G1(要件定義§7.5)の決定に基づく:
 * - 事実の情報源にはしない(§7.1)。矛盾時はFAQを優先する旨を明示する
 * - 複数採用時は approved_at が最新の1件のみ(X10: 全件注入の禁止)
 * - 逐語コピーは強制しない(X9)
 * - 防御層(L5 Input Sanitizer)を通し、危険なパターンを含む場合は注入しない(X11)
 */
function formatApprovedResponseHint(rule: TuningRule): string | null {
  const responses = rule.approved_responses;
  if (!responses || responses.length === 0) return null;

  const latest = [...responses].sort(
    (a, b) => new Date(b.approved_at).getTime() - new Date(a.approved_at).getTime(),
  )[0]!;

  const { safe, sanitized } = sanitizeInput(latest.text);
  if (!safe) return null;

  const excerpt = sanitized.slice(0, APPROVED_RESPONSE_MAX_CHARS);
  return `  文体の見本（逐語コピーは不要。事実がFAQと異なる場合はFAQを優先する）: 「${excerpt}」`;
}

/**
 * アクティブなチューニングルールをシステムプロンプト用テキストに変換する。
 * ルールが空の場合は空文字を返す（呼び出し元で条件分岐不要）。
 *
 * S1(要件§6 X3): approved_responses は formatApprovedResponseHint 内で
 * sanitizeInput() を通しているが、expected_behavior は無検査でシステム
 * プロンプトに埋め込まれていた。共有学習プール(S3/S4)を開けると
 * 「1テナントの会話に混入した注入文字列 → global ルール →
 * 全テナントのシステムプロンプト」という横断経路が成立するため、
 * expected_behavior も同じ sanitizeInput() を通し、safe でないルールは
 * 行ごと生成しない(base も hint も出さない)。落としたルールは黙って
 * 消さず logger.warn で rule id と reason を記録する。
 *
 * 出力例:
 * 以下の応答ルールに従ってください（優先度順）:
 * - 「返品」に関する質問 → 7日以内の返品を案内し、手続きURLを提示する
 *   文体の見本（逐語コピーは不要。事実がFAQと異なる場合はFAQを優先する）: 「...」
 * - 「在庫」に関する質問 → 在庫確認は店舗に電話するよう案内する
 */
export function buildTuningPromptSection(rules: TuningRule[]): string {
  if (rules.length === 0) return "";

  const lines = rules.flatMap((r) => {
    const { safe, sanitized, reason } = sanitizeInput(r.expected_behavior);
    if (!safe) {
      logger.warn(
        { event: "tuning_rule_expected_behavior_blocked", ruleId: r.id, reason },
        "tuning rule expected_behavior failed sanitizeInput; row skipped",
      );
      return [];
    }

    // E5: 空文字・全角スペースのみ(sanitizeInputのtrim()で空になるケースを含む)は
    // safe=true だが中身が無いルール行になる。「→ 」だけの空の指示行を残さない。
    if (sanitized.length === 0) {
      logger.warn(
        { event: "tuning_rule_expected_behavior_blocked", ruleId: r.id, reason: "empty_expected_behavior" },
        "tuning rule expected_behavior is empty after sanitization; row skipped",
      );
      return [];
    }

    const base = `- 「${r.trigger_pattern}」に関する質問 → ${sanitized}`;
    const hint = formatApprovedResponseHint(r);
    return hint ? [base, hint] : [base];
  });

  // E7: 全ルールが sanitizeInput で落ちた場合、rules.length===0 と同じ扱いにする。
  // ヘッダ文言(「以下の応答ルールに従ってください」)だけが残る空の指示ブロックを
  // システムプロンプトに残さない。
  if (lines.length === 0) return "";

  return `以下の応答ルールに従ってください（優先度順）:\n${lines.join("\n")}`;
}
