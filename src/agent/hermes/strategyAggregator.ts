// src/agent/hermes/strategyAggregator.ts
// Phase74: Hermes Agent — 横断・tenant別シグナルを戦略提案候補に変換する
//
// crossTenantContext(匿名横断集計)と autoTuning の detect 群(tenant別、tenant_id=$1 付き)を
// そのまま呼び出し、新規の横断生SQLは書かない(越境リスクをゼロに保つレビュー基準)。
// ここで作るのは「提案候補」のみで、DB永続化(proposalRepository)・通知は
// 呼び出し側(hermesAgent.ts)の責務とする。純関数の集合として単体テスト可能に保つ。

import { pool } from "../../lib/db";
import { getCrossTenantContext } from "../../lib/crossTenantContext";
import {
  detectABWinners,
  detectRepeatedJudgeSuggestions,
  detectTopPrinciples,
  type AutoTuningCandidate,
} from "../../api/conversion/autoTuning";
import type { HermesProposalScope, HermesProposalType } from "./proposalRepository";

export interface HermesProposalCandidate {
  scope: HermesProposalScope;
  /** scope='tenant' のときのみ設定される。 */
  tenantId?: string;
  proposalType: HermesProposalType;
  title: string;
  rationale: string;
  suggestedAction: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
}

/** 横断提案として採用する心理原則の上限件数(通知過多を避ける)。 */
const GLOBAL_PRINCIPLE_TOP_N = 3;

/** アクティブテナント判定に使う既定の窓(日数)。 */
const DEFAULT_ACTIVE_WINDOW_DAYS = 30;

/** dedup_key に使うため、自由記述のルール文を短い識別子に正規化する。 */
function slugifyRule(rule: string): string {
  return rule
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .toLowerCase();
}

/**
 * crossTenantContext の匿名集計から、横断戦略提案を生成する。
 * 生ログ・tenant_id は一切扱わない(getCrossTenantContext の返り値のみを材料にする)。
 */
export async function collectGlobalProposalCandidates(): Promise<HermesProposalCandidate[]> {
  const ctx = await getCrossTenantContext();

  return ctx.topPsychologyPrinciples.slice(0, GLOBAL_PRINCIPLE_TOP_N).map((p) => ({
    scope: "global" as const,
    proposalType: "xt_principle" as const,
    title: `心理原則「${p.principle}」の全体採用を検討`,
    rationale: `全テナント横断でCV率${p.conversionRate}%(直近90日・サンプル${p.sampleSize}件、匿名集計)`,
    suggestedAction: `デフォルト戦略に心理原則「${p.principle}」を優先ルールとして追加検討`,
    evidence: {
      principle: p.principle,
      conversionRate: p.conversionRate,
      sampleSize: p.sampleSize,
    },
    dedupKey: `xt_principle:${p.principle}`,
  }));
}

function candidateDedupKey(tenantId: string, candidate: AutoTuningCandidate): string {
  switch (candidate.type) {
    case "ab_winner":
      return `tenant:${tenantId}:ab_winner:${String(candidate.data.experimentId)}`;
    case "effectiveness_top":
      return `tenant:${tenantId}:effectiveness_top:${String(candidate.data.principle)}`;
    case "judge_repeated":
      return `tenant:${tenantId}:judge_repeated:${slugifyRule(
        String(candidate.data.rule ?? candidate.suggestedAction),
      )}`;
    default:
      return `tenant:${tenantId}:unknown:${slugifyRule(candidate.description)}`;
  }
}

/**
 * 既存の autoTuning detect 群(全て tenant_id=$1 付き)をそのまま呼び、
 * tenant別の戦略提案候補に正規化する。
 */
export async function collectTenantProposalCandidates(
  tenantId: string,
): Promise<HermesProposalCandidate[]> {
  const [judgeResults, abResults, principleResults] = await Promise.all([
    detectRepeatedJudgeSuggestions(tenantId),
    detectABWinners(tenantId),
    detectTopPrinciples(tenantId),
  ]);

  return [...judgeResults, ...abResults, ...principleResults].map((candidate) => ({
    scope: "tenant" as const,
    tenantId,
    proposalType: candidate.type,
    title: candidate.description,
    rationale: candidate.description,
    suggestedAction: candidate.suggestedAction,
    evidence: candidate.data,
    dedupKey: candidateDedupKey(tenantId, candidate),
  }));
}

/**
 * アクティブテナント一覧(直近windowDays日にJudge評価があるテナント)。
 * hermesAgent 側で Feature Flag によるテナント絞り込みの母集団として使う。
 */
export async function listActiveTenantIds(
  windowDays: number = DEFAULT_ACTIVE_WINDOW_DAYS,
): Promise<string[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT DISTINCT tenant_id FROM conversation_evaluations
     WHERE evaluated_at > NOW() - ($1 * INTERVAL '1 day')`,
    [windowDays],
  );
  return (result.rows as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
}

/**
 * 横断提案 + 指定テナント群のtenant別提案をまとめて集約する。
 * tenantIds は呼び出し側(hermesAgent)が Feature Flag で絞り込んだ後に渡す想定。
 * 省略時は listActiveTenantIds() で母集団を自動取得する(絞り込み無し)。
 */
export async function collectAllProposalCandidates(
  tenantIds?: string[],
): Promise<HermesProposalCandidate[]> {
  const targetTenantIds = tenantIds ?? (await listActiveTenantIds());

  const [globalCandidates, ...tenantCandidateLists] = await Promise.all([
    collectGlobalProposalCandidates(),
    ...targetTenantIds.map((tenantId) => collectTenantProposalCandidates(tenantId)),
  ]);

  return [...globalCandidates, ...tenantCandidateLists.flat()];
}
