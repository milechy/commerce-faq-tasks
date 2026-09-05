// src/api/widget/shopifyDeletionQueue.test.ts
//
// 固定する不変条件:
//   FR-16/D15  期限(受信日+30日)の境界(29日/30日/31日)でアラートの深刻度が切り替わる(X-6)
//   禁止50     保留0件を「異常なし」と黙殺せず、pendingCount で正しく認識できる
//   D15        承認は deletion_requested_at が設定済みの行のみに効く(未要求は拒否)
//   D16        削除保留中の再インストールは clearDeletionPending で復元される

jest.mock("../../lib/notifications", () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

import { createNotification, notificationExists } from "../../lib/notifications";
import {
  getDeletionDeadline,
  getDaysUntilDeadline,
  checkAndNotifyApproachingDeadlines,
  executeApprovedDeletion,
  DELETION_APPROVAL_GRACE_DAYS,
} from "./shopifyDeletionQueue";
import {
  markDeletionRequested,
  clearDeletionPending,
  isDeletionPending,
  listPendingDeletions,
} from "./shopifyRepository";

const mockedCreateNotification = createNotification as jest.Mock;
const mockedNotificationExists = notificationExists as jest.Mock;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  mockedNotificationExists.mockResolvedValue(false);
  mockedCreateNotification.mockResolvedValue(undefined);
});

describe("getDeletionDeadline", () => {
  it("受信日+30日を返す", () => {
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const deadline = getDeletionDeadline(requestedAt);
    expect(deadline.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(DELETION_APPROVAL_GRACE_DAYS).toBe(30);
  });

  it("process TZ に依存しない(UTC/JSTどちらの解釈でも同じ絶対時刻を返す)", () => {
    const requestedAt = new Date("2026-06-15T12:34:56.000Z");
    const deadline = getDeletionDeadline(requestedAt);
    expect(deadline.getTime() - requestedAt.getTime()).toBe(30 * DAY_MS);
  });
});

describe("getDaysUntilDeadline(境界値 X-6: 29日/30日/31日)", () => {
  const requestedAt = new Date("2026-01-01T00:00:00.000Z");

  it("29日経過(29日目) → 残り1日", () => {
    const now = new Date(requestedAt.getTime() + 29 * DAY_MS);
    expect(getDaysUntilDeadline(requestedAt, now)).toBe(1);
  });

  it("30日経過(30日目) → 残り0日", () => {
    const now = new Date(requestedAt.getTime() + 30 * DAY_MS);
    expect(getDaysUntilDeadline(requestedAt, now)).toBe(0);
  });

  it("31日経過(31日目、超過) → 残り-1日", () => {
    const now = new Date(requestedAt.getTime() + 31 * DAY_MS);
    expect(getDaysUntilDeadline(requestedAt, now)).toBe(-1);
  });

  it("28日経過(まだ余裕がある) → 残り2日", () => {
    const now = new Date(requestedAt.getTime() + 28 * DAY_MS);
    expect(getDaysUntilDeadline(requestedAt, now)).toBe(2);
  });

  it("受信直後(0日経過) → 残り30日", () => {
    expect(getDaysUntilDeadline(requestedAt, requestedAt)).toBe(30);
  });
});

function makeQueryDb(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }) } as any;
}

describe("checkAndNotifyApproachingDeadlines", () => {
  it("保留0件でも異常ではなく、pendingCount=0 で正しく認識できる(禁止50型)", async () => {
    const db = makeQueryDb([]);
    const result = await checkAndNotifyApproachingDeadlines(db, new Date());
    expect(result).toEqual({ pendingCount: 0, notifiedCount: 0 });
    expect(mockedCreateNotification).not.toHaveBeenCalled();
  });

  it("期限に余裕がある(残り2日以上)テナントには通知しない", async () => {
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(requestedAt.getTime() + 27 * DAY_MS); // 残り3日
    const db = makeQueryDb([
      { id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: requestedAt },
    ]);

    const result = await checkAndNotifyApproachingDeadlines(db, now);

    expect(result).toEqual({ pendingCount: 1, notifiedCount: 0 });
    expect(mockedCreateNotification).not.toHaveBeenCalled();
  });

  it("29日目(残り1日) → warning深刻度で1件通知する", async () => {
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(requestedAt.getTime() + 29 * DAY_MS);
    const db = makeQueryDb([
      { id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: requestedAt },
    ]);

    const result = await checkAndNotifyApproachingDeadlines(db, now);

    expect(result).toEqual({ pendingCount: 1, notifiedCount: 1 });
    expect(mockedCreateNotification).toHaveBeenCalledTimes(1);
    const call = mockedCreateNotification.mock.calls[0][0];
    expect(call.recipientRole).toBe("super_admin");
    expect(call.metadata).toMatchObject({ tenantId: "tenant-a", daysUntilDeadline: 1, severity: "warning" });
  });

  it("30日目(残り0日) → alert深刻度で通知する", async () => {
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(requestedAt.getTime() + 30 * DAY_MS);
    const db = makeQueryDb([
      { id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: requestedAt },
    ]);

    const result = await checkAndNotifyApproachingDeadlines(db, now);

    expect(result).toEqual({ pendingCount: 1, notifiedCount: 1 });
    const call = mockedCreateNotification.mock.calls[0][0];
    expect(call.metadata).toMatchObject({ daysUntilDeadline: 0, severity: "alert" });
  });

  it("31日目(超過) → critical深刻度で通知する", async () => {
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(requestedAt.getTime() + 31 * DAY_MS);
    const db = makeQueryDb([
      { id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: requestedAt },
    ]);

    const result = await checkAndNotifyApproachingDeadlines(db, now);

    expect(result).toEqual({ pendingCount: 1, notifiedCount: 1 });
    const call = mockedCreateNotification.mock.calls[0][0];
    expect(call.metadata).toMatchObject({ daysUntilDeadline: -1, severity: "critical" });
    expect(call.message).toContain("超過");
  });

  it("既に同じ深刻度で通知済み(notificationExists=true)なら重複通知しない", async () => {
    mockedNotificationExists.mockResolvedValue(true);
    const requestedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(requestedAt.getTime() + 30 * DAY_MS);
    const db = makeQueryDb([
      { id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: requestedAt },
    ]);

    const result = await checkAndNotifyApproachingDeadlines(db, now);

    expect(result).toEqual({ pendingCount: 1, notifiedCount: 0 });
    expect(mockedCreateNotification).not.toHaveBeenCalled();
  });

  it("複数テナントのうち期限が近いものだけ通知する", async () => {
    const requestedAtNear = new Date("2026-01-01T00:00:00.000Z");
    const requestedAtFar = new Date("2026-02-01T00:00:00.000Z");
    const now = new Date(requestedAtNear.getTime() + 30 * DAY_MS); // near=残り0日, far=残り30日超
    const db = makeQueryDb([
      { id: "tenant-near", shopify_shop_domain: "near.myshopify.com", deletion_requested_at: requestedAtNear },
      { id: "tenant-far", shopify_shop_domain: "far.myshopify.com", deletion_requested_at: requestedAtFar },
    ]);

    const result = await checkAndNotifyApproachingDeadlines(db, now);

    expect(result).toEqual({ pendingCount: 2, notifiedCount: 1 });
    expect(mockedCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockedCreateNotification.mock.calls[0][0].metadata.tenantId).toBe("tenant-near");
  });
});

// executeApprovedDeletion 用: purgeTenantChatData がトランザクション(pool.connect())を
// 要求するため、retentionRepository.test.ts の makeClient() と同じ流儀で
// SQL 文字列に応じて応答を切り替える最小 Pool モックを用意する。
function makeApprovalPool(opts: { tenantHasDeletionRequested: boolean }) {
  const calls: string[] = [];
  const clientCalls: string[] = [];
  const client = {
    calls: clientCalls,
    query: jest.fn(async (sql: string) => {
      clientCalls.push(sql);
      if (/^\s*BEGIN/i.test(sql)) return {};
      if (/^\s*SET LOCAL/i.test(sql)) return {};
      if (/^\s*COMMIT/i.test(sql)) return {};
      if (/^\s*ROLLBACK/i.test(sql)) return {};
      if (/COUNT\(\*\) AS cnt FROM chat_messages WHERE tenant_id/i.test(sql)) {
        return { rows: [{ cnt: "5" }] };
      }
      if (/UPDATE option_orders SET chat_session_id = NULL/i.test(sql)) {
        return { rowCount: 2 };
      }
      if (/DELETE FROM chat_sessions WHERE tenant_id/i.test(sql)) {
        return { rowCount: 3 };
      }
      if (/UPDATE tenants SET chat_data_purged_at/i.test(sql)) {
        return { rowCount: 1 };
      }
      if (/INSERT INTO audit_logs/i.test(sql)) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };

  const connect = jest.fn(async () => client);
  const query = jest.fn(async (sql: string) => {
    calls.push(sql);
    if (/UPDATE tenants\s+SET deletion_approved_at = NOW\(\), deletion_approved_by = \$2\s+WHERE id = \$1 AND deletion_requested_at IS NOT NULL/i.test(sql)) {
      return { rowCount: opts.tenantHasDeletionRequested ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { query, connect, calls, client };
}

describe("executeApprovedDeletion", () => {
  it("削除が要求されていないテナントは承認できない(approved=false、chatDataPurgedはnull、connectしない)", async () => {
    const pool = makeApprovalPool({ tenantHasDeletionRequested: false });

    const result = await executeApprovedDeletion(pool as any, "tenant-not-requested", "admin@r2c.biz");

    expect(result).toEqual({ approved: false, chatDataPurged: null });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("承認記録を書き込み、既存のpurgeTenantChatDataで会話データを物理削除する(D15)", async () => {
    const pool = makeApprovalPool({ tenantHasDeletionRequested: true });

    const result = await executeApprovedDeletion(pool as any, "tenant-a", "admin@r2c.biz");

    expect(result.approved).toBe(true);
    expect(result.chatDataPurged).toEqual({
      tenant_id: "tenant-a",
      sessions: 3,
      messages: 5,
      option_orders_nulled: 2,
      dryRun: false,
    });
    // 承認(deletion_approved_at)が先、データ削除は承認できた場合のみ実行される
    expect(pool.query.mock.calls[0][0]).toMatch(/deletion_approved_at = NOW\(\)/);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.client.calls.some((s: string) => /DELETE FROM chat_sessions WHERE tenant_id/i.test(s))).toBe(true);
    expect(pool.client.calls.some((s: string) => /INSERT INTO audit_logs/i.test(s))).toBe(true);
    expect(pool.client.calls.some((s: string) => /COMMIT/i.test(s))).toBe(true);
  });
});

// 削除保留キューのライフサイクル(作成 → 一覧 → 再インストールによる復元、D16)。
// shopifyRepository.ts の各関数が正しく組み合わさることを、状態を持つ簡易フェイクDBで検証する
// (このテナント単位の状態遷移は shopifyOAuthRoutes.ts の再インストール処理と同型)。
function makeStatefulTenantDb(seed: { id: string; shopDomain: string }) {
  const state: {
    deletion_requested_at: Date | null;
    deletion_approved_at: Date | null;
    deletion_approved_by: string | null;
  } = { deletion_requested_at: null, deletion_approved_at: null, deletion_approved_by: null };

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (/^UPDATE tenants SET deletion_requested_at = NOW\(\) WHERE id = \$1$/.test(s)) {
      if (params[0] !== seed.id) return { rowCount: 0 };
      state.deletion_requested_at = new Date();
      return { rowCount: 1 };
    }
    if (/^UPDATE tenants SET deletion_requested_at = NULL, deletion_approved_at = NULL, deletion_approved_by = NULL WHERE id = \$1$/.test(s)) {
      if (params[0] !== seed.id) return { rowCount: 0 };
      state.deletion_requested_at = null;
      state.deletion_approved_at = null;
      state.deletion_approved_by = null;
      return { rowCount: 1 };
    }
    if (/^SELECT deletion_requested_at, deletion_approved_at FROM tenants WHERE id = \$1$/.test(s)) {
      if (params[0] !== seed.id) return { rows: [] };
      return {
        rows: [
          {
            deletion_requested_at: state.deletion_requested_at,
            deletion_approved_at: state.deletion_approved_at,
          },
        ],
      };
    }
    if (/^SELECT id, shopify_shop_domain, deletion_requested_at FROM tenants WHERE deletion_requested_at IS NOT NULL AND deletion_approved_at IS NULL$/.test(s)) {
      if (state.deletion_requested_at !== null && state.deletion_approved_at === null) {
        return {
          rows: [
            {
              id: seed.id,
              shopify_shop_domain: seed.shopDomain,
              deletion_requested_at: state.deletion_requested_at,
            },
          ],
        };
      }
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  });

  return { db: { query } as any, state };
}

describe("削除保留キューのライフサイクル(作成 → 一覧 → 再インストールによる復元, D16)", () => {
  it("shop/redact受信(作成) → 一覧に出る → 再インストール(clearDeletionPending)で復元され一覧から消える", async () => {
    const { db } = makeStatefulTenantDb({ id: "tenant-a", shopDomain: "a.myshopify.com" });

    // 1. shop/redact 受信 → 削除保留としてマーク
    expect(await markDeletionRequested(db, "tenant-a")).toBe(true);
    expect(await isDeletionPending(db, "tenant-a")).toBe(true);
    expect(await listPendingDeletions(db)).toEqual([
      expect.objectContaining({ id: "tenant-a", shopify_shop_domain: "a.myshopify.com" }),
    ]);

    // 2. 期限内に同一ストアが再インストール → 削除保留を解除して既存テナントを復元(D16)
    expect(await clearDeletionPending(db, "tenant-a")).toBe(true);
    expect(await isDeletionPending(db, "tenant-a")).toBe(false);
    expect(await listPendingDeletions(db)).toEqual([]);
  });
});
