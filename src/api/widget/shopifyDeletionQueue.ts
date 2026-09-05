// src/api/widget/shopifyDeletionQueue.ts
//
// Shopify 連携(docs/SHOPIFY_APP_REQUIREMENTS.md D15/D16/FR-16)の
// 「shop/redact 受信後の削除保留キュー」の判定ロジックを持つ層。
// DBアクセスは shopifyRepository.ts(markDeletionRequested/approveDeletion/
// clearDeletionPending/isDeletionPending/listPendingDeletions)に委譲し、
// ここでは「期限計算・アラート発火・承認実行」だけを扱う
// (shopifyRepository.ts 自身が明記する切り分け方針を踏襲)。
//
// 日付計算について: weekRange.ts / jstOffset.ts は「JST 壁時計のカレンダー境界」
// (今週の月曜00:00等)を process TZ 非依存で求めるために +9h シフトの手法を使うが、
// ここでの「受信日+30日」は単純な経過時間の加算であり、カレンダー境界の判定では
// ない。getTime() のミリ秒算術だけで既に process TZ に一切依存しないため、
// JST シフトの手法は不要(過剰実装しない)。
//
// 通知は既存の createNotification/notificationExists(../../lib/notifications)を
// 使う(新しい通知の仕組みを作らない)。ただしこの2関数は内部で getPool() を
// 呼ぶため、この関数に注入した db を経由しない
// (src/lib/billing/stripeSync.ts の _maybeNotifyGrowthEnterpriseNudge と同じ注記)。
// テストでは "../../lib/notifications" モジュールをモックして検証する。

import type { Pool } from "pg";
import { createNotification, notificationExists } from "../../lib/notifications";
import {
  approveDeletion,
  listPendingDeletions,
  type PendingDeletionRow,
} from "./shopifyRepository";
import {
  purgeTenantChatData,
  type PurgeTenantResult,
} from "../admin/chat-history/retentionRepository";

/** listPendingDeletions に渡すだけなので shopifyRepository.ts と同じ最小インターフェース。 */
type Db = Pick<Pool, "query">;

const DAY_MS = 24 * 60 * 60 * 1000;

/** shop/redact 受信後、人間承認までの猶予日数(D15・FR-16)。 */
export const DELETION_APPROVAL_GRACE_DAYS = 30;

const DEADLINE_NOTIFICATION_TYPE = "shopify_deletion_deadline";

/**
 * 削除保留の承認期限(受信日+30日)を計算する。
 *
 * 経過時間の単純加算のため getTime() のミリ秒算術のみで成立し、process TZ には
 * 依存しない(カレンダー境界の判定ではないので weekRange.ts のような JST 壁時計
 * シフトは不要)。
 */
export function getDeletionDeadline(deletionRequestedAt: Date): Date {
  return new Date(deletionRequestedAt.getTime() + DELETION_APPROVAL_GRACE_DAYS * DAY_MS);
}

/**
 * 期限までの残日数を返す(負数なら超過)。
 * 端数は切り捨て、つまり期限に近い側(より深刻な側)に丸める
 * (例: 29.5日経過時点は「残り0日」= 本日中に承認が必要、として扱う)。
 */
export function getDaysUntilDeadline(deletionRequestedAt: Date, now: Date): number {
  const deadline = getDeletionDeadline(deletionRequestedAt);
  return Math.floor((deadline.getTime() - now.getTime()) / DAY_MS);
}

export type DeadlineSeverity = "warning" | "alert" | "critical";

/**
 * X-6(境界値): 29日目(残り1日)は警告、30日目(残り0日)でアラート、
 * 31日目以降(超過、残り-1日以下)は重大アラートに切り替える。
 * それより前(残り2日以上)は対象外(null)。
 *
 * export済み: Super Admin監視画面のGET /v1/admin/shopify/deletion-queue
 * (src/api/admin/tenants/routes.ts)が通知を送らずに同じ閾値で severity 表示する
 * ため再利用する(CLAUDE.md 禁止6: 同じ閾値ロジックを2箇所に複製しない)。
 */
export function getDeadlineSeverity(daysUntilDeadline: number): DeadlineSeverity | null {
  if (daysUntilDeadline < 0) return "critical";
  if (daysUntilDeadline === 0) return "alert";
  if (daysUntilDeadline === 1) return "warning";
  return null;
}

const SEVERITY_LABEL: Record<DeadlineSeverity, string> = {
  warning: "まもなく期限",
  alert: "本日が期限",
  critical: "期限超過",
};

export interface DeletionDeadlineCheckResult {
  /**
   * 削除保留中の総件数。0件のときも黙って何もしないのではなく、この値で
   * 「この関数自体が正しく動作した(0件を認識して終えた)」ことを検証できる
   * (禁止50: 監視対象0件を「異常なし」と黙殺しない、と同型の設計)。
   */
  pendingCount: number;
  /** 実際に通知を発行した件数(重複防止でスキップした分は含まない)。 */
  notifiedCount: number;
}

/**
 * 削除保留中の全テナントを取得し、期限が近い(残り1日以内)または超過している
 * ものについて createNotification でアラートを出す(FR-16・D15)。
 *
 * 同一テナント・同一深刻度への重複通知は notificationExists で防ぐ
 * (定期実行で呼ばれる想定のため。承認/復元されない限り同じ深刻度で鳴り続けない)。
 */
export async function checkAndNotifyApproachingDeadlines(
  db: Db,
  now: Date = new Date(),
): Promise<DeletionDeadlineCheckResult> {
  const pending: PendingDeletionRow[] = await listPendingDeletions(db);

  let notifiedCount = 0;
  for (const row of pending) {
    const daysUntilDeadline = getDaysUntilDeadline(row.deletion_requested_at, now);
    const severity = getDeadlineSeverity(daysUntilDeadline);
    if (severity === null) {
      continue;
    }

    const dedupeKey = `${row.id}:${severity}`;
    const alreadyNotified = await notificationExists(
      DEADLINE_NOTIFICATION_TYPE,
      "dedupe_key",
      dedupeKey,
    );
    if (alreadyNotified) {
      continue;
    }

    const shopLabel = row.shopify_shop_domain ?? row.id;
    const message =
      severity === "critical"
        ? `${shopLabel} の削除承認期限を ${Math.abs(daysUntilDeadline)}日超過しています。至急、承認するか削除保留を解除してください。`
        : `${shopLabel} の削除承認期限まで残り${daysUntilDeadline}日です。承認または削除保留の解除が必要です。`;

    await createNotification({
      recipientRole: "super_admin",
      type: DEADLINE_NOTIFICATION_TYPE,
      title: `Shopify削除保留: ${SEVERITY_LABEL[severity]}(${shopLabel})`,
      message,
      link: "/admin/tenants",
      metadata: {
        tenantId: row.id,
        shopDomain: row.shopify_shop_domain,
        daysUntilDeadline,
        severity,
        dedupe_key: dedupeKey,
      },
    });
    notifiedCount++;
  }

  return { pendingCount: pending.length, notifiedCount };
}

export interface ExecuteApprovedDeletionResult {
  /** 承認記録(deletion_approved_at/deletion_approved_by)が実際に書き込めたか。 */
  approved: boolean;
  /**
   * 実データ削除の実行結果。
   *
   * ★スコープ注記★ 本タスク(GID 1218199926366347)で実行する実データ削除は、
   * 既存の purgeTenantChatData(retentionRepository.ts — テナント退会フロー
   * `POST /v1/admin/tenants/:id/purge-chat-data` で実運用中の「テナント削除に
   * 相当する処理」)による会話データ(chat_sessions/chat_messages)の物理削除のみ。
   * tenants 行自体・FAQ・APIキー・avatar_configs 等を含む完全な物理削除は、
   * 全テーブルを横断する削除設計が別途必要であり本タスクのスコープ外
   * (承認の記録さえ成立すれば D15 の要件——不可逆操作は人間承認を経てから実行——は
   * 満たされるため、承認記録を主とし、データ削除は「既存処理の再利用」として
   * 付随させるに留めた)。
   *
   * approved=false(削除が要求されていないテナントを承認しようとした)の場合は
   * 実行しない(null)。
   */
  chatDataPurged: PurgeTenantResult | null;
}

/**
 * 削除保留の承認を記録し(D15)、既存の purgeTenantChatData で会話データを
 * 物理削除する。
 *
 * db は purgeTenantChatData がトランザクション(pool.connect())を必要とするため、
 * shopifyRepository.ts の関数群のような Pick<Pool,"query"> ではなく完全な Pool を
 * 受け取る(Pool は query も持つため approveDeletion への受け渡しも問題ない)。
 */
export async function executeApprovedDeletion(
  db: Pool,
  tenantId: string,
  approvedBy: string,
): Promise<ExecuteApprovedDeletionResult> {
  const approved = await approveDeletion(db, tenantId, approvedBy);
  if (!approved) {
    return { approved: false, chatDataPurged: null };
  }

  const chatDataPurged = await purgeTenantChatData({
    tenantId,
    actorRole: "super_admin",
    actorEmail: approvedBy,
    reason: "shopify_shop_redact_approved",
    pool: db,
  });

  return { approved: true, chatDataPurged };
}
