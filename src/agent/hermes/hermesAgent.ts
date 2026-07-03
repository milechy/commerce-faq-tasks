// src/agent/hermes/hermesAgent.ts
// Phase74: Hermes Agent — 常駐スケジューラ
//
// strategyAggregator が生成する提案候補(横断=crossTenantContext由来の匿名集計 /
// tenant別=autoTuning detect群由来)を新規分のみ永続化(proposalRepository)し、
// 承認ゲートのため管理者に通知するだけの常駐ジョブ。
// system_prompt / system_prompt_variants は一切自動書き換えしない(提案→人間承認ゲート)。
//
// heartbeatHandler.ts と同型: setInterval + 二重起動ガード + unref()。

import pino from "pino";
import {
  isHermesEnabled,
  isHermesNotifyEnabled,
  isHermesTenantAllowed,
} from "./featureFlag";
import {
  collectAllProposalCandidates,
  listActiveTenantIds,
  type HermesProposalCandidate,
} from "./strategyAggregator";
import { createHermesProposalRepository } from "./proposalRepository";
import { createNotification } from "../../lib/notifications";
import { sendSlackAlert } from "../../lib/alerts/slackNotifier";

const logger = pino({ name: "hermes-agent" });

const HERMES_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6時間周期(MVPは低頻度で十分)

let intervalHandle: NodeJS.Timeout | null = null;

export interface HermesCycleResult {
  generated: number;
  skipped: number;
}

async function notifyProposal(
  candidate: HermesProposalCandidate,
  proposalId: string | null,
): Promise<void> {
  if (!isHermesNotifyEnabled()) return;

  const recipientRole = candidate.scope === "global" ? "super_admin" : "client_admin";
  try {
    await createNotification({
      recipientRole,
      recipientTenantId: candidate.tenantId,
      type: "hermes_proposal",
      title: candidate.title,
      message: candidate.rationale,
      link: candidate.scope === "global" ? "/admin/hermes" : "/admin/conversion",
      metadata: {
        proposal_id: proposalId,
        dedup_key: candidate.dedupKey,
        proposal_type: candidate.proposalType,
        scope: candidate.scope,
      },
    });
  } catch (err) {
    logger.warn({ err }, "hermes.notify_failed");
  }
}

/**
 * 1サイクル分の処理: アクティブテナントをFlagで絞り込み → 提案候補を集約 →
 * 新規分のみ永続化 → 通知(In-App) → Slackサマリ(件数のみ)。
 *
 * Flag マスタースイッチ(isHermesEnabled)の判定は startHermes 側の責務。
 * ここでは無条件に実行する(手動検証:
 * `HERMES_ENABLED=true HERMES_NOTIFY_ENABLED=false pnpm dev` から直接呼べるように)。
 */
export async function runHermesCycle(): Promise<HermesCycleResult> {
  const repo = createHermesProposalRepository();

  let targetTenantIds: string[] = [];
  try {
    const activeTenantIds = await listActiveTenantIds();
    targetTenantIds = activeTenantIds.filter((tenantId) => isHermesTenantAllowed(tenantId));
  } catch (err) {
    logger.warn({ err }, "hermes.list_active_tenants_failed");
  }

  let candidates: HermesProposalCandidate[] = [];
  try {
    candidates = await collectAllProposalCandidates(targetTenantIds);
  } catch (err) {
    logger.warn({ err }, "hermes.collect_candidates_failed");
    return { generated: 0, skipped: 0 };
  }

  let generated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      const inserted = await repo.insertProposal({
        scope: candidate.scope,
        tenantId: candidate.tenantId,
        proposalType: candidate.proposalType,
        title: candidate.title,
        rationale: candidate.rationale,
        suggestedAction: candidate.suggestedAction,
        evidence: candidate.evidence,
        dedupKey: candidate.dedupKey,
      });

      if (!inserted) {
        skipped++;
        continue;
      }
      generated++;

      const proposalId = await repo.findProposalIdByDedupKey(candidate.dedupKey);
      await notifyProposal(candidate, proposalId);
    } catch (err) {
      logger.warn({ err, dedupKey: candidate.dedupKey }, "hermes.proposal_failed");
    }
  }

  logger.info(
    { generated, skipped, totalCandidates: candidates.length },
    "hermes.cycle_done",
  );

  if (generated > 0) {
    try {
      // カウントのみ(会話内容・PII・principle名の列挙はしない)
      await sendSlackAlert({
        ruleId: "hermes-agent-cycle",
        name: "Hermes Agent — 戦略提案サイクル",
        level: "INFO",
        status: "FIRING",
        details: `今サイクルで${generated}件の新規提案を生成しました(重複スキップ${skipped}件)。管理画面で確認してください。`,
      });
    } catch (err) {
      logger.warn({ err }, "hermes.slack_summary_failed");
    }
  }

  return { generated, skipped };
}

export function startHermes(): void {
  if (!isHermesEnabled()) return; // マスタースイッチ OFF は no-op
  if (intervalHandle) return; // 二重起動ガード

  intervalHandle = setInterval(() => {
    runHermesCycle().catch((err) => {
      logger.warn({ err }, "hermes.cycle_failed");
    });
  }, HERMES_INTERVAL_MS);
  intervalHandle.unref(); // プロセス終了 / jest をブロックしない
}

export function stopHermes(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
