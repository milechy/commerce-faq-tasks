// src/api/admin/analytics/ruleEffect.ts
//
// GID 1216978677398163 (PR-14): tuning_rules 承認の効果測定（R4: 承認を「信仰」から「学習」に変える）
//
// 母集団の定義（G3 で確定した制約）:
//   - セッションの最初のユーザー発言が matchesTriggerPattern に一致した会話を「treatment」、
//     一致しなかった会話を同一テナントの「control」とする。
//     最初の発言はどのAI応答よりも前に発生するため外生的（内生性による水増しを避ける）。
//   - before/after の分岐点は tuning_rules.approved_at。
//
// Judge自己成就バイアスへの対処:
//   judgeEvaluator.ts はテナントの「現在アクティブな」tuning_rules を評価時点で
//   Judge プロンプトに注入するため、ルール承認は Judge 自身の採点基準を変える。
//   これは対象ルールにマッチしたセッションだけでなく、同一テナントの全セッションの
//   評価に等しく効くテナント一律のシフトのため、control 群（非マッチセッション）を
//   同じ期間で比較する DiD (Difference-in-Differences) を取ることで相殺できる。
//   このため本モジュールは judgeEvaluator.ts を変更せず、既存の conversation_evaluations
//   を DiD 設計の下で読むだけに留める（対象ファイル外への変更は行わない）。
//
// 母数不足時（CLAUDE.md「絶対にやってはいけないこと」内、命名・エラーハンドリング章の
// 禁止34相当）は差分・率・矢印を一切出さず、到達条件（現在N/必要N/見込み日数）を返す。

import { matchesTriggerPattern } from "../tuning/triggerMatching";
import { userSourceClause } from "./summaryQueries";

type Db = Pick<import("pg").Pool, "query">;

/** 各群で Judge スコアの平均を「統計的に意味がある」とみなす最低セッション数。 */
export const MIN_SAMPLE_SIZE = 5;

export type RuleEffectGroupKey =
  | "beforeTreatment"
  | "afterTreatment"
  | "beforeControl"
  | "afterControl";

/** 群固定(before系)か蓄積中(after系)かの分類。ETA計算の可否に使う。 */
const ACCUMULATING_GROUPS = new Set<RuleEffectGroupKey>(["afterTreatment", "afterControl"]);

export interface GroupInput {
  /** Judge スコアを持つセッションのスコア配列（0-100） */
  judgeScores: number[];
  /** 母集団に含まれる全セッション数（Judgeスコアの有無を問わない） */
  sessionCount: number;
  /** ユーザー発言が2通以上に到達したセッション数 */
  twoTurnCount: number;
  /** conversion_attributions に紐づくセッション数（記録のみ・判定には使わない） */
  convertedCount: number;
}

export interface RuleEffectGroups {
  beforeTreatment: GroupInput;
  afterTreatment: GroupInput;
  beforeControl: GroupInput;
  afterControl: GroupInput;
}

interface MeanStats {
  n: number;
  mean: number;
  stddev: number;
  se: number;
  ci95: [number, number];
}

function meanStats(scores: number[]): MeanStats | null {
  const n = scores.length;
  if (n === 0) return null;
  const mean = scores.reduce((s, v) => s + v, 0) / n;
  const variance =
    n > 1 ? scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  // n=1 の標準誤差は定義できない(ばらつきが測れない)。呼び出し側は
  // MIN_SAMPLE_SIZE(既定5)未満を insufficient_data とするため、通常この分岐には来ない。
  const se = n > 1 ? stddev / Math.sqrt(n) : NaN;
  return {
    n,
    mean,
    stddev,
    se,
    ci95: [mean - 1.96 * se, mean + 1.96 * se],
  };
}

export interface GroupProgress {
  group: RuleEffectGroupKey;
  currentN: number;
  requiredN: number;
  /** 蓄積が続く after 系のみ。before 系は観測期間が固定のため null。 */
  etaDays: number | null;
}

export interface RuleEffectComparison {
  minSampleSize: number;
  groups: Record<
    RuleEffectGroupKey,
    {
      n: number;
      mean: number;
      ci95: [number, number];
      twoTurnRate: number;
      /** 参考値のみ。単体のルール効果判定に使うには標本数が不足するのが通例(CV率)。 */
      convertedCount: number;
      sessionCount: number;
    }
  >;
  /** DiD = (afterTreatment - beforeTreatment) - (afterControl - beforeControl) */
  did: {
    estimate: number;
    ci95: [number, number];
  };
  /** DiD で相殺する前の素朴な before/after 差（参考表示用。単体では自己成就バイアスを含む） */
  naiveTreatmentDelta: number;
}

export type RuleEffectResult =
  | {
      status: "insufficient_data";
      minSampleSize: number;
      progress: GroupProgress[];
    }
  | {
      status: "ok";
      comparison: RuleEffectComparison;
    };

/**
 * 統計判定の純関数本体。DB・時刻に触れない(daysSinceApproval は呼び出し側が計算して渡す)。
 */
export function evaluateRuleEffect(
  groups: RuleEffectGroups,
  daysSinceApproval: number,
  minSampleSize: number = MIN_SAMPLE_SIZE,
): RuleEffectResult {
  const keys: RuleEffectGroupKey[] = [
    "beforeTreatment",
    "afterTreatment",
    "beforeControl",
    "afterControl",
  ];
  const stats: Record<RuleEffectGroupKey, MeanStats | null> = {
    beforeTreatment: meanStats(groups.beforeTreatment.judgeScores),
    afterTreatment: meanStats(groups.afterTreatment.judgeScores),
    beforeControl: meanStats(groups.beforeControl.judgeScores),
    afterControl: meanStats(groups.afterControl.judgeScores),
  };

  const shortGroups = keys.filter((k) => (stats[k]?.n ?? 0) < minSampleSize);
  if (shortGroups.length > 0) {
    const progress: GroupProgress[] = shortGroups.map((k) => {
      const currentN = stats[k]?.n ?? 0;
      let etaDays: number | null = null;
      if (ACCUMULATING_GROUPS.has(k) && daysSinceApproval > 0) {
        const rate = currentN / daysSinceApproval;
        etaDays = rate > 0 ? Math.ceil((minSampleSize - currentN) / rate) : null;
      }
      return { group: k, currentN, requiredN: minSampleSize, etaDays };
    });
    return { status: "insufficient_data", minSampleSize, progress };
  }

  const bt = stats.beforeTreatment!;
  const at = stats.afterTreatment!;
  const bc = stats.beforeControl!;
  const ac = stats.afterControl!;

  const naiveTreatmentDelta = at.mean - bt.mean;
  const controlDelta = ac.mean - bc.mean;
  const didEstimate = naiveTreatmentDelta - controlDelta;
  const didSe = Math.sqrt(bt.se ** 2 + at.se ** 2 + bc.se ** 2 + ac.se ** 2);

  const twoTurnRate = (g: GroupInput) =>
    g.sessionCount > 0 ? g.twoTurnCount / g.sessionCount : 0;

  return {
    status: "ok",
    comparison: {
      minSampleSize,
      groups: {
        beforeTreatment: {
          n: bt.n,
          mean: Number(bt.mean.toFixed(2)),
          ci95: [Number(bt.ci95[0].toFixed(2)), Number(bt.ci95[1].toFixed(2))],
          twoTurnRate: Number(twoTurnRate(groups.beforeTreatment).toFixed(4)),
          convertedCount: groups.beforeTreatment.convertedCount,
          sessionCount: groups.beforeTreatment.sessionCount,
        },
        afterTreatment: {
          n: at.n,
          mean: Number(at.mean.toFixed(2)),
          ci95: [Number(at.ci95[0].toFixed(2)), Number(at.ci95[1].toFixed(2))],
          twoTurnRate: Number(twoTurnRate(groups.afterTreatment).toFixed(4)),
          convertedCount: groups.afterTreatment.convertedCount,
          sessionCount: groups.afterTreatment.sessionCount,
        },
        beforeControl: {
          n: bc.n,
          mean: Number(bc.mean.toFixed(2)),
          ci95: [Number(bc.ci95[0].toFixed(2)), Number(bc.ci95[1].toFixed(2))],
          twoTurnRate: Number(twoTurnRate(groups.beforeControl).toFixed(4)),
          convertedCount: groups.beforeControl.convertedCount,
          sessionCount: groups.beforeControl.sessionCount,
        },
        afterControl: {
          n: ac.n,
          mean: Number(ac.mean.toFixed(2)),
          ci95: [Number(ac.ci95[0].toFixed(2)), Number(ac.ci95[1].toFixed(2))],
          twoTurnRate: Number(twoTurnRate(groups.afterControl).toFixed(4)),
          convertedCount: groups.afterControl.convertedCount,
          sessionCount: groups.afterControl.sessionCount,
        },
      },
      did: {
        estimate: Number(didEstimate.toFixed(2)),
        ci95: [
          Number((didEstimate - 1.96 * didSe).toFixed(2)),
          Number((didEstimate + 1.96 * didSe).toFixed(2)),
        ],
      },
      naiveTreatmentDelta: Number(naiveTreatmentDelta.toFixed(2)),
    },
  };
}

// ---------------------------------------------------------------------------
// DB 取得部
// ---------------------------------------------------------------------------

export interface RuleMeta {
  id: number;
  tenantId: string;
  triggerPattern: string;
  createdAt: string;
  approvedAt: string | null;
}

type FetchRuleResult =
  | { status: "not_found" }
  | { status: "not_yet_approved"; rule: RuleMeta }
  | { status: "found"; rule: RuleMeta };

export async function fetchRuleMeta(db: Db, ruleId: number): Promise<FetchRuleResult> {
  const result = await db.query<{
    id: number;
    tenant_id: string;
    trigger_pattern: string;
    created_at: string;
    approved_at: string | null;
  }>(
    `SELECT id, tenant_id, trigger_pattern, created_at, approved_at
       FROM tuning_rules
      WHERE id = $1
      LIMIT 1`,
    [ruleId],
  );
  const row = result.rows[0];
  if (!row) return { status: "not_found" };
  const rule: RuleMeta = {
    id: row.id,
    tenantId: row.tenant_id,
    triggerPattern: row.trigger_pattern,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
  if (!row.approved_at) return { status: "not_yet_approved", rule };
  return { status: "found", rule };
}

interface CandidateSessionRow {
  session_uuid: string;
  first_message: string;
  first_message_at: string;
  judge_score: number | null;
  user_message_count: number;
  converted: boolean;
}

/**
 * ルールの母集団候補（最初のユーザー発言 + Judgeスコア + ユーザー発言数 + CV有無）を取得する。
 * トリガー一致判定(matchesTriggerPattern)は純関数のためSQLでは行わず、呼び出し側でJS実行する
 * (triggerMatching.ts の判定ロジックを複製しない)。
 *
 * 観測窓: [rule.createdAt, NOW()]。ルールが存在しない期間を「before」に含めても
 * 比較上意味がないため、下限をルール作成時点に揃える。
 */
async function fetchCandidateSessions(
  db: Db,
  tenantId: string,
  sinceIso: string,
): Promise<CandidateSessionRow[]> {
  const result = await db.query<CandidateSessionRow>(
    `WITH first_user_msg AS (
       SELECT DISTINCT ON (cm.session_id)
         cm.session_id AS session_uuid,
         cm.content AS first_message,
         cm.created_at AS first_message_at
       FROM chat_messages cm
       JOIN chat_sessions cs ON cs.id = cm.session_id
       WHERE cs.tenant_id = $1
         AND cm.role = 'user'
         AND cm.created_at >= $2::timestamptz
         ${userSourceClause("cs")}
       ORDER BY cm.session_id, cm.created_at ASC
     )
     SELECT
       f.session_uuid::text AS session_uuid,
       f.first_message,
       f.first_message_at,
       ev.score AS judge_score,
       (SELECT COUNT(*)::int FROM chat_messages cm2
          WHERE cm2.session_id = f.session_uuid AND cm2.role = 'user') AS user_message_count,
       (ca.id IS NOT NULL) AS converted
     FROM first_user_msg f
     JOIN chat_sessions cs ON cs.id = f.session_uuid
     LEFT JOIN conversation_evaluations ev
       ON ev.session_id = cs.session_id AND ev.score > 0
     LEFT JOIN conversion_attributions ca
       ON ca.session_id = f.session_uuid`,
    [tenantId, sinceIso],
  );
  return result.rows;
}

function emptyGroup(): GroupInput {
  return { judgeScores: [], sessionCount: 0, twoTurnCount: 0, convertedCount: 0 };
}

function addToGroup(g: GroupInput, row: CandidateSessionRow): void {
  g.sessionCount += 1;
  if (row.judge_score != null) g.judgeScores.push(row.judge_score);
  if (row.user_message_count >= 2) g.twoTurnCount += 1;
  if (row.converted) g.convertedCount += 1;
}

export type RuleEffectFetchResult =
  | { status: "rule_not_found" }
  | { status: "not_yet_approved"; ruleId: number; tenantId: string }
  | ({ status: "insufficient_data" | "ok"; ruleId: number; tenantId: string; approvedAt: string } & RuleEffectResult);

/**
 * ルールIDから効果測定結果を組み立てる。会話本文はここから外に出さない
 * (matchesTriggerPattern の判定にのみ使い、ログにも戻り値にも含めない。Anti-Slop)。
 */
export async function getRuleEffect(
  db: Db,
  ruleId: number,
  minSampleSize: number = MIN_SAMPLE_SIZE,
): Promise<RuleEffectFetchResult> {
  const ruleResult = await fetchRuleMeta(db, ruleId);
  if (ruleResult.status === "not_found") return { status: "rule_not_found" };
  if (ruleResult.status === "not_yet_approved") {
    return { status: "not_yet_approved", ruleId, tenantId: ruleResult.rule.tenantId };
  }

  const { rule } = ruleResult;
  const approvedAtMs = new Date(rule.approvedAt!).getTime();
  const rows = await fetchCandidateSessions(db, rule.tenantId, rule.createdAt);

  const groups: RuleEffectGroups = {
    beforeTreatment: emptyGroup(),
    afterTreatment: emptyGroup(),
    beforeControl: emptyGroup(),
    afterControl: emptyGroup(),
  };

  for (const row of rows) {
    const matched = matchesTriggerPattern(row.first_message, rule.triggerPattern);
    const isAfter = new Date(row.first_message_at).getTime() >= approvedAtMs;
    const key: RuleEffectGroupKey = matched
      ? isAfter
        ? "afterTreatment"
        : "beforeTreatment"
      : isAfter
        ? "afterControl"
        : "beforeControl";
    addToGroup(groups[key], row);
  }

  const daysSinceApproval = Math.max(0, (Date.now() - approvedAtMs) / 86_400_000);
  const evalResult = evaluateRuleEffect(groups, daysSinceApproval, minSampleSize);

  return { ...evalResult, ruleId, tenantId: rule.tenantId, approvedAt: rule.approvedAt! };
}
