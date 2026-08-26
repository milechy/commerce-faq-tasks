jest.mock("../alerts/slackNotifier", () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("./subscriptionSync", () => ({
  syncSubscriptionForTenant: jest.fn(),
  needsBillingAttention: jest.requireActual("./subscriptionSync").needsBillingAttention,
}));

import {
  reconcileBillingSync,
  billingSyncReconciliationMonitor,
} from "./billingSyncReconciliation";
import { sendSlackAlert } from "../alerts/slackNotifier";
import { syncSubscriptionForTenant } from "./subscriptionSync";

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
const mockSync = syncSubscriptionForTenant as jest.Mock;

function makeDb(tenants: Array<{ id: string; plan: string }>) {
  return {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("FROM tenants")) {
        return Promise.resolve({ rows: tenants.map((t) => ({ id: t.id, plan: t.plan })) });
      }
      return Promise.resolve({ rows: [] });
    }),
    connect: jest.fn(),
  };
}

describe("reconcileBillingSync", () => {
  beforeEach(() => {
    (sendSlackAlert as jest.Mock).mockClear();
    mockSync.mockReset();
  });

  it("対象一覧のSQLは plan IS NOT NULL かつ enterprise を除外する", async () => {
    const db = makeDb([]);
    await reconcileBillingSync(db as any, mockLogger);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("plan IS NOT NULL"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("plan <> 'enterprise'"));
  });

  it("全テナントが synced/no_change 等の健全な状態ならSlackを鳴らさない", async () => {
    const db = makeDb([
      { id: "t1", plan: "standard" },
      { id: "t2", plan: "free_ad" },
    ]);
    mockSync.mockImplementation(async (_db, _logger, tenantId) =>
      tenantId === "t1" ? { status: "no_change" } : { status: "not_billable_plan" }
    );

    const results = await reconcileBillingSync(db as any, mockLogger);

    expect(results).toHaveLength(2);
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it("1件でも要対応(no_subscription等)があればWARNINGで1本にまとめて通知する", async () => {
    const db = makeDb([
      { id: "t1", plan: "standard" },
      { id: "t2", plan: "growth" },
    ]);
    mockSync.mockImplementation(async (_db, _logger, tenantId) =>
      tenantId === "t1" ? { status: "no_change" } : { status: "no_subscription" }
    );

    await reconcileBillingSync(db as any, mockLogger);

    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    const [msg] = (sendSlackAlert as jest.Mock).mock.calls[0];
    expect(msg.level).toBe("WARNING");
    expect(msg.details).toContain("要対応 1 件");
    expect(msg.details).toContain("t2");
    expect(msg.details).not.toContain("t1(plan="); // 健全なテナントは列挙しない
  });

  it("superseded は要対応として扱わない(通知に含めない)", async () => {
    const db = makeDb([{ id: "t1", plan: "standard" }]);
    mockSync.mockResolvedValue({ status: "superseded" });

    await reconcileBillingSync(db as any, mockLogger);

    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it("1テナントのsyncSubscriptionForTenant呼び出しが例外を投げても、他テナントの処理を止めない", async () => {
    const db = makeDb([
      { id: "broken", plan: "standard" },
      { id: "ok", plan: "standard" },
    ]);
    mockSync.mockImplementation(async (_db, _logger, tenantId) => {
      if (tenantId === "broken") throw new Error("connection terminated");
      return { status: "no_change" };
    });

    const results = await reconcileBillingSync(db as any, mockLogger);

    expect(results).toHaveLength(1);
    expect(results[0].tenantId).toBe("ok");
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("乖離が0件でも、照合失敗があればSlackに通知する", async () => {
    const db = makeDb([
      { id: "broken", plan: "standard" },
      { id: "ok", plan: "standard" },
    ]);
    mockSync.mockImplementation(async (_db, _logger, tenantId) => {
      if (tenantId === "broken") throw new Error("connection terminated");
      return { status: "no_change" };
    });

    await reconcileBillingSync(db as any, mockLogger);

    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    const [msg] = (sendSlackAlert as jest.Mock).mock.calls[0];
    expect(msg.details).toContain("照合失敗 1 件");
    expect(msg.details).toContain("broken");
    expect(msg.details).toContain("実態不明");
  });

  it("対象テナントが0件でもクラッシュしない", async () => {
    const db = makeDb([]);
    await expect(reconcileBillingSync(db as any, mockLogger)).resolves.toEqual([]);
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it("failedステータス(Stripe呼び出し失敗)も要対応として通知する", async () => {
    const db = makeDb([{ id: "t1", plan: "standard" }]);
    mockSync.mockResolvedValue({ status: "failed", message: "Stripe API error" });

    await reconcileBillingSync(db as any, mockLogger);

    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    const [msg] = (sendSlackAlert as jest.Mock).mock.calls[0];
    expect(msg.details).toContain("t1");
    expect(msg.details).toContain("Stripe API error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// billingSyncReconciliationMonitor（定期実行ラッパー）
// billingReconciliationMonitor と同じ理由で fake timers を使う
// (global.setInterval への spyOn/mockRestore は環境依存で不安定)。
// ─────────────────────────────────────────────────────────────────────────────
describe("billingSyncReconciliationMonitor", () => {
  beforeEach(() => {
    (sendSlackAlert as jest.Mock).mockClear();
    mockSync.mockReset();
    mockSync.mockResolvedValue({ status: "no_change" });
    jest.useFakeTimers();
  });

  afterEach(() => {
    billingSyncReconciliationMonitor.stop();
    jest.useRealTimers();
  });

  const cleanDb = () => makeDb([]);

  // ★禁止30: 費用が発生する定期処理を多重起動しうる形で登録しない★
  it("start() を2回呼んでもタイマーは1本だけ登録される", () => {
    const db = cleanDb();
    billingSyncReconciliationMonitor.start(db as any, mockLogger);
    billingSyncReconciliationMonitor.start(db as any, mockLogger);
    expect(jest.getTimerCount()).toBe(1);
  });

  it("起動直後に1回実行される(次の24hを待たない)", async () => {
    const db = cleanDb();
    billingSyncReconciliationMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect(db.query).toHaveBeenCalled();
  });

  it("24時間ごとに再実行される", async () => {
    const db = cleanDb();
    billingSyncReconciliationMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    const callsAfterStart = db.query.mock.calls.length;

    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(db.query.mock.calls.length).toBeGreaterThan(callsAfterStart);
  });

  it("DBクエリが例外を投げても評価ループごと落ちない", async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error("connection terminated")), connect: jest.fn() };
    billingSyncReconciliationMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("stop() 後はタイマーが残らない", () => {
    const db = cleanDb();
    billingSyncReconciliationMonitor.start(db as any, mockLogger);
    billingSyncReconciliationMonitor.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
});
