// src/api/admin/tuning/tuningRulesRepository.ts
// Phase38 Step4-BE: チューニングルール DB リポジトリ

import { getPool } from "../../../lib/db";
import { sanitizeInput } from "../../../lib/security/inputSanitizer";
import { logger } from "../../../lib/logger";
import { shareConsentSqlPredicate } from "../../../lib/hermesConsent";

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
  /** D8-2: 'behavior'(応答方針・従来) | 'upsell'(営業提案。承認しても is_active は立たない)。 */
  proposal_type?: string;
  /** DBの列ではない。updateRule が status 指定の呼び出しで「既にその状態だった(冪等な繰り返し)」
   *  ことを呼び出し側(actionExecutor)へ伝えるためだけのフラグ。他のcaseでは常にundefined。 */
  alreadyApplied?: boolean;
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
 * ★share の判定そのものは hermesConsent.ts の shareConsentSqlPredicate() が唯一の定義★
 * (この定数は「global 行に限って」その判定を適用するラッパー)。以前はここと
 * listHermesConsentingTenantIds が別々に生SQLを持っており、どちらも
 * `->>'share' = 'true'` という緩い形だったため JS 側リゾルバと食い違っていた。
 * 詳細と実測結果は shareConsentSqlPredicate() のコメントを参照。
 *
 * ★tenants テーブルのエイリアスは t に固定する★
 * (FROM tenants t / t.features)。tests/phase38/globalRuleGate.test.ts が
 * 生成後の文字列に対して alias t を要求している(PR #896 で FAQ_VISIBILITY_WHERE の
 * エイリアスを固定したのと同じ理由)。share 判定式だけを関数に切り出しても、
 * このラッパー側で "t.features" を渡す形は変えないこと。
 */
export const GLOBAL_RULE_VISIBILITY_WHERE = `(
        tenant_id = $1
        OR (
          tenant_id = 'global'
          AND EXISTS (
            SELECT 1 FROM tenants t
             WHERE t.id = $1
               AND ${shareConsentSqlPredicate("t.features")}
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
              created_at, updated_at, source, status, evidence, proposal_type
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
            created_at, updated_at, source, status, evidence, proposal_type
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

  // ★D8-2: ここに proposal_type を足さない(SELECT にも WHERE にも)★
  // アップセル提案(proposal_type='upsell')の混入防止は、DB の CHECK 制約
  // tuning_rules_upsell_never_active_check が「is_active=true になれるのは
  // behavior だけ」を保証することで既に成立している。
  // このクエリは全テナントの全回答が通るホットパスであり、ここに列を1つ足すと
  // migration 未適用のままデプロイした瞬間に 42703 で回答経路が全滅する
  // (usage_logs の plan_multiplier / session_id で2回起きた事故と同型)。
  // 防御は DB 制約と承認側の分岐に置き、ここは1文字も変えない。
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

  // 存在 + 所有権確認。status も合わせて読み、承認/却下の冪等な繰り返し
  // (「もう一度承認して」に対して「すでに反映済みです」を返す)を判定する。
  const check = await pool.query<{
    id: number; tenant_id: string; status: string | null; proposal_type: string | null;
  }>(
    `SELECT id, tenant_id, status, proposal_type FROM tuning_rules WHERE id = $1`,
    [id],
  );
  if (check.rows.length === 0) return null;
  if (tenantId && check.rows[0]!.tenant_id !== tenantId) return null;
  const alreadyApplied =
    params.status !== undefined && check.rows[0]!.status === params.status;

  const approvedJson =
    params.approved_responses !== undefined
      ? JSON.stringify(params.approved_responses)
      : null;

  // D8: is_active が唯一の真実。status で承認/却下を指定した場合はここで
  // is_active を導出し、呼び出し側(actionExecutor / LLMプロンプト)が
  // is_active を渡し忘れても不整合が起きないようにする。
  // status 未指定時は従来通り params.is_active(通常のON/OFF切替)を使う。
  //
  // D8-2: proposal_type='upsell'(営業提案)は「採用」しても本番プロンプトへ入れない。
  // status='active' でも is_active は false のままにする。手動のON/OFF切替
  // (params.is_active)でも true にしない — upsell に「有効化」という状態は無い。
  // 漏れた場合は DB の CHECK 制約が 23514 で弾く(コードが唯一の砦ではない)。
  const isUpsell = check.rows[0]!.proposal_type === "upsell";
  const derivedIsActive = isUpsell
    ? false
    : params.status === "active"
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

  const updated = result.rows[0];
  if (updated && alreadyApplied) {
    updated.alreadyApplied = true;
  }
  return updated ?? null;
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
/**
 * システムプロンプトの1行に埋め込むテキストから改行を潰す。
 *
 * buildTuningPromptSection は行を "\n" で join して箇条書きを組み立てるため、
 * 1フィールドの中に改行が入ると「- 「x」に関する質問 → ...」という偽の
 * ルール行を1件のルールから何行でも捏造できる(sanitizeInput は URL/script 等の
 * パターンしか見ておらず、改行は素通しする)。承認者の目視は防御層の代替に
 * ならない(要件 X11 / E11)ため、構造そのものを壊せないようにここで潰す。
 */
function flattenForPromptLine(text: string): string {
  // \u3000 = 全角スペース。改行・タブ・全角/半角スペースの連続を半角1個に潰す。
  return text.replace(/[\r\n\t\u3000 ]+/g, " ").trim();
}

function formatApprovedResponseHint(rule: TuningRule): string | null {
  const responses = rule.approved_responses;
  if (!responses || responses.length === 0) return null;

  const latest = [...responses].sort(
    (a, b) => new Date(b.approved_at).getTime() - new Date(a.approved_at).getTime(),
  )[0]!;

  const { safe, sanitized } = sanitizeInput(latest.text);
  if (!safe) return null;

  // 改行を潰してから切り出す(切り出し後だと末尾に改行が残りうる)。
  const excerpt = flattenForPromptLine(sanitized).slice(0, APPROVED_RESPONSE_MAX_CHARS);
  if (excerpt.length === 0) return null;
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
    // trigger_pattern / expected_behavior はどちらもプロンプトの同じ1行に
    // 埋め込まれ、どちらも Hermes 提案経由で外部から入りうる
    // (hermes-mcp/routes.ts: title → trigger_pattern, suggested_action →
    // expected_behavior。長さ検証のみで sanitizeInput は通らない)。
    // 片方だけ検査すると、もう片方が同じ注入経路として残る。
    const fields: Array<{ name: "trigger_pattern" | "expected_behavior"; raw: string }> = [
      { name: "trigger_pattern", raw: r.trigger_pattern },
      { name: "expected_behavior", raw: r.expected_behavior },
    ];

    const cleaned: Record<string, string> = {};
    for (const { name, raw } of fields) {
      const { safe, sanitized, reason } = sanitizeInput(raw ?? "");
      if (!safe) {
        logger.warn(
          { event: "tuning_rule_field_blocked", ruleId: r.id, field: name, reason },
          "tuning rule field failed sanitizeInput; row skipped",
        );
        return [];
      }
      // E5: 空文字・全角スペースのみ(sanitizeInputのtrim()で空になるケースを含む)は
      // safe=true だが中身が無いルール行になる。「→ 」だけの空の指示行を残さない。
      // 改行潰し(flattenForPromptLine)の後に判定する(改行だけの入力もここで落ちる)。
      const flattened = flattenForPromptLine(sanitized);
      if (flattened.length === 0) {
        logger.warn(
          { event: "tuning_rule_field_blocked", ruleId: r.id, field: name, reason: "empty_after_sanitize" },
          "tuning rule field is empty after sanitization; row skipped",
        );
        return [];
      }
      cleaned[name] = flattened;
    }

    const base = `- 「${cleaned["trigger_pattern"]}」に関する質問 → ${cleaned["expected_behavior"]}`;
    const hint = formatApprovedResponseHint(r);
    return hint ? [base, hint] : [base];
  });

  // E7: 全ルールが sanitizeInput で落ちた場合、rules.length===0 と同じ扱いにする。
  // ヘッダ文言(「以下の応答ルールに従ってください」)だけが残る空の指示ブロックを
  // システムプロンプトに残さない。
  if (lines.length === 0) return "";

  return `以下の応答ルールに従ってください（優先度順）:\n${lines.join("\n")}`;
}
