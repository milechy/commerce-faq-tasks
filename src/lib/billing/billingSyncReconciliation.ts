// src/lib/billing/billingSyncReconciliation.ts
// P1-11(2026-08-26 レビュー)本筋対応: billing_sync 日次照合cron。
//
// ★なぜ必要か★
// syncSubscriptionForTenant(subscriptionSync.ts) は tenants.plan の変更時
// (PUT/PATCH /v1/admin/tenants 系)にのみオンデマンドで呼ばれる。webhookの
// 取りこぼし・Stripeダッシュボードでの手動変更・DBへの直接操作など、
// plan変更を経由しない経路でtenants.planとStripeの実際のsubscription item
// 構成がズレた場合、そのテナントの次のプラン変更が起きるまでズレは誰にも
// 気づかれない。このジョブは billingReconciliation.ts(月次請求突合)と同じ
// 「起動プロセスへ配線した定期実行」パターンで、全テナントを毎日巡回して
// Stripeの実態と再照合する(cron登録という人間の運用に依存しない。
// billingReconciliationMonitorが孤立していた反省と同じ理由)。
//
// ★enterpriseプランは対象外★
// enterpriseはsyncSubscriptionItemsToPlanが常に'manual_plan'を返す設計
// (個別契約・自動修正の対象外)。毎日呼んでも何も直らず、needsBillingAttention
// が常にtrueになるため、対象に含めると「直しようのない警告」がenterprise
// テナントの数だけ毎日鳴り続けるノイズになる(壊れているときに黙る禁止の裏返し
// ——鳴り続けて誰も見なくなる失敗)。自動請求の対象になり得るプラン
// (free_ad含む。free_adはsyncSubscriptionItemsToPlan内部で解約予約のみ行う)
// のみを巡回する。
//
// ★billing_sync_statusカラムを対象の絞り込みには使わない★
// migration_billing_sync_status.sql は本番未適用の可能性がある
// (docs/DEPLOY_CHECKLIST.md参照)。対象テナントの絞り込みにこのカラムを
// 使うと、未適用環境でクエリごと失敗しうる。代わりに tenants.plan だけで
// 対象を決め、Stripeとの実照合そのもの(syncSubscriptionForTenant、
// 内部のUPDATEは既にfail-open)に委ねる。
import type pino from "pino";
import {
  syncSubscriptionForTenant,
  needsBillingAttention,
  type SubscriptionSyncResult,
} from "./subscriptionSync";
import { sendSlackAlert } from "../alerts/slackNotifier";

interface DbLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  connect: () => Promise<any>;
}

export interface BillingSyncCheckResult {
  tenantId: string;
  plan: string;
  result: SubscriptionSyncResult;
}

/** 自動請求の対象になり得る(=このジョブで意味のある再照合ができる)プランのテナント一覧。 */
async function listTenantsToSync(db: DbLike): Promise<Array<{ id: string; plan: string }>> {
  const result = await db.query(
    `SELECT id, plan FROM tenants WHERE plan IS NOT NULL AND plan <> 'enterprise'`
  );
  return result.rows.map((r) => ({ id: r.id as string, plan: r.plan as string }));
}

/**
 * 全テナントを巡回し、Stripeの実際のsubscription item構成とtenants.planを
 * 再照合する。1テナントの失敗が他テナントの処理を止めないよう、テナント単位で
 * 隔離する(billingReconciliation.tsのreconcileMonthと同じ理由)。
 */
export async function reconcileBillingSync(
  db: DbLike,
  logger: pino.Logger
): Promise<BillingSyncCheckResult[]> {
  const tenants = await listTenantsToSync(db);

  const results: BillingSyncCheckResult[] = [];
  const executionFailures: Array<{ tenantId: string; error: string }> = [];

  for (const { id: tenantId, plan } of tenants) {
    try {
      const result = await syncSubscriptionForTenant(db, logger, tenantId, plan);
      results.push({ tenantId, plan, result });
    } catch (err) {
      logger.error(
        { err, tenantId, plan },
        "[billingSyncReconciliation] tenant sync check failed unexpectedly"
      );
      executionFailures.push({
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // superseded は「別のプラン変更が追随中」という正常系のノイズなので対象外
  // (needsBillingAttentionの判定基準どおり)。
  const needsAttention = results.filter((r) => needsBillingAttention(r.result));

  if (needsAttention.length > 0 || executionFailures.length > 0) {
    const attentionLines = needsAttention
      .map(
        (r) =>
          `・${r.tenantId}(plan=${r.plan}): ${r.result.status}` +
          (r.result.message ? ` — ${r.result.message}` : "")
      )
      .join("\n");
    const failureLines = executionFailures
      .map((f) => `・${f.tenantId}: 照合そのものが失敗(${f.error})`)
      .join("\n");

    const parts: string[] = [
      `billing_sync日次照合で ${tenants.length} テナント中、` +
        `要対応 ${needsAttention.length} 件・照合失敗 ${executionFailures.length} 件があります。`,
    ];
    if (needsAttention.length > 0) {
      parts.push(
        `Stripeのsubscription item構成が追随していないか、支払い設定が未完了です。\n${attentionLines}`
      );
    }
    if (executionFailures.length > 0) {
      // 突合失敗は「乖離が無い」とは別物。実態不明なだけで、実際にはズレがあっても
      // 検知できていない(billingReconciliation.tsと同じ考え方)。
      parts.push(`以下のテナントは照合自体が実行できませんでした(実態不明):\n${failureLines}`);
    }
    parts.push(
      "管理画面の該当テナントのプラン設定から再送(no-op保存で再同期)するか、Stripeダッシュボードで確認してください。"
    );

    await sendSlackAlert({
      ruleId: "billing_sync_reconciliation_attention",
      name: "billing_sync_reconciliation_attention",
      level: "WARNING",
      status: "FIRING",
      details: parts.join("\n\n"),
    }).catch((err) =>
      logger.warn({ err }, "[billingSyncReconciliation] slack send failed")
    );
  }

  logger.info(
    {
      totalTenants: tenants.length,
      needsAttention: needsAttention.length,
      executionFailures: executionFailures.length,
    },
    "[billingSyncReconciliation] daily sync check completed"
  );

  return results;
}

// ---------------------------------------------------------------------------
// 定期実行ラッパー。billingReconciliationMonitor(billingReconciliation.ts)と
// 同じ形(DI・二重起動防止・起動直後の初回tick・stop())を踏襲する。対象は
// 「毎日Stripeの実態を再確認する」性質のため、乖離が起きた場合は直るまで
// 日次でSlackが鳴り続ける(billingReconciliation.tsと同じ意図的な設計。
// 一度鳴って忘れられるより、直るまで毎日思い出させる方を選ぶ。cooldownは付けない)。
// ---------------------------------------------------------------------------

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間ごと(billingReconciliationMonitorと同じ周期)

class BillingSyncReconciliationMonitor {
  private timer: NodeJS.Timeout | null = null;

  start(db: DbLike, logger: pino.Logger): void {
    if (this.timer) return; // 二重起動防止(CLAUDE.md 禁止30: 費用が発生する定期処理の多重起動)
    const tick = () => {
      reconcileBillingSync(db, logger).catch((err) => {
        logger.error({ err }, "[billingSyncReconciliation] scheduled run failed");
      });
    };
    this.timer = setInterval(tick, SYNC_INTERVAL_MS);
    // 起動直後に1回実行する(次の24hを待たない)。
    tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const billingSyncReconciliationMonitor = new BillingSyncReconciliationMonitor();
