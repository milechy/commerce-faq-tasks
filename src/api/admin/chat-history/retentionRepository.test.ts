// src/api/admin/chat-history/retentionRepository.test.ts
// 保持期間バッチ + テナント退会消去の DB ロジック検証(pool を注入してモック)。

import {
  purgeExpiredChatData,
  purgeTenantChatData,
  findTenantsDueForPurge,
} from "./retentionRepository";

// SQL 文字列を見て応答を切り替える汎用モック。呼び出し順に依存しないため頑健。
function makeClient(): { query: jest.Mock; release: jest.Mock; calls: string[] } {
  const calls: string[] = [];
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    calls.push(sql);
    if (/^\s*BEGIN/i.test(sql)) return {};
    if (/^\s*SET LOCAL/i.test(sql)) return {};
    if (/^\s*COMMIT/i.test(sql)) return {};
    if (/^\s*ROLLBACK/i.test(sql)) return {};
    if (/SELECT id FROM chat_sessions\s+WHERE last_message_at/i.test(sql)) {
      return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }, { id: "22222222-2222-2222-2222-222222222222" }] };
    }
    if (/COUNT\(\*\) AS cnt FROM chat_messages WHERE session_id = ANY/i.test(sql)) {
      return { rows: [{ cnt: "4" }] };
    }
    if (/COUNT\(\*\) AS cnt FROM chat_messages WHERE tenant_id/i.test(sql)) {
      return { rows: [{ cnt: "7" }] };
    }
    if (/UPDATE option_orders SET chat_session_id = NULL/i.test(sql)) {
      return { rowCount: 1 };
    }
    if (/DELETE FROM chat_sessions WHERE id = ANY/i.test(sql)) {
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
  });
  return { query, release: jest.fn(), calls };
}

describe("purgeExpiredChatData", () => {
  it("retentionDays<=0 は例外", async () => {
    const pool: any = { query: jest.fn(), connect: jest.fn() };
    await expect(purgeExpiredChatData({ retentionDays: 0, dryRun: true, pool })).rejects.toThrow();
    await expect(purgeExpiredChatData({ retentionDays: -5, dryRun: true, pool })).rejects.toThrow();
  });

  it("dryRun=true は件数のみ返し、connect(書き込み)しない", async () => {
    const poolQuery = jest.fn(async (sql: string) => {
      if (/AS cutoff/i.test(sql)) return { rows: [{ cutoff: "2020-01-01T00:00:00.000Z" }] };
      if (/COUNT\(\*\) AS cnt FROM chat_sessions/i.test(sql)) return { rows: [{ cnt: "3" }] };
      if (/COUNT\(\*\) AS cnt FROM chat_messages/i.test(sql)) return { rows: [{ cnt: "10" }] };
      return { rows: [] };
    });
    const connect = jest.fn();
    const pool: any = { query: poolQuery, connect };

    const result = await purgeExpiredChatData({ retentionDays: 180, dryRun: true, pool });

    expect(result.dryRun).toBe(true);
    expect(result.sessions).toBe(3);
    expect(result.messages).toBe(10);
    expect(result.batches).toBe(0);
    expect(connect).not.toHaveBeenCalled(); // 書き込み経路に入っていない
  });

  it("dryRun=false は TX 内で削除し、監査を記録する", async () => {
    const client = makeClient();
    const poolQuery = jest.fn(async (sql: string) => {
      if (/AS cutoff/i.test(sql)) return { rows: [{ cutoff: "2020-01-01T00:00:00.000Z" }] };
      return { rows: [] };
    });
    const pool: any = { query: poolQuery, connect: jest.fn(async () => client) };

    const result = await purgeExpiredChatData({ retentionDays: 30, dryRun: false, pool });

    expect(result.dryRun).toBe(false);
    expect(result.sessions).toBe(2);
    expect(result.messages).toBe(4);
    expect(result.option_orders_nulled).toBe(1);
    expect(result.batches).toBe(1);
    expect(client.calls.some((s) => /INSERT INTO audit_logs/i.test(s))).toBe(true);
    expect(client.calls.some((s) => /COMMIT/i.test(s))).toBe(true);
    expect(client.calls.some((s) => /DELETE FROM chat_sessions/i.test(s))).toBe(true);
  });
});

describe("purgeTenantChatData", () => {
  it("dryRun=true は件数のみ・connectしない", async () => {
    const poolQuery = jest.fn(async (sql: string) => {
      if (/COUNT\(\*\) AS cnt FROM chat_sessions WHERE tenant_id/i.test(sql)) return { rows: [{ cnt: "5" }] };
      if (/COUNT\(\*\) AS cnt FROM chat_messages WHERE tenant_id/i.test(sql)) return { rows: [{ cnt: "20" }] };
      return { rows: [] };
    });
    const connect = jest.fn();
    const pool: any = { query: poolQuery, connect };

    const result = await purgeTenantChatData({
      tenantId: "tenant-x",
      actorRole: "super_admin",
      actorEmail: "a@b.c",
      reason: "退会",
      dryRun: true,
      pool,
    });

    expect(result.dryRun).toBe(true);
    expect(result.sessions).toBe(5);
    expect(result.messages).toBe(20);
    expect(connect).not.toHaveBeenCalled();
  });

  it("tenantId 空は例外", async () => {
    const pool: any = { query: jest.fn(), connect: jest.fn() };
    await expect(
      purgeTenantChatData({ tenantId: "", actorRole: "super_admin", actorEmail: "", reason: "x" as any, pool }),
    ).rejects.toThrow();
  });

  it("dryRun=false は削除+purged_at更新+監査記録", async () => {
    const client = makeClient();
    const pool: any = { query: jest.fn(), connect: jest.fn(async () => client) };

    const result = await purgeTenantChatData({
      tenantId: "tenant-x",
      actorRole: "super_admin",
      actorEmail: "a@b.c",
      reason: "退会に伴う消去",
      pool,
    });

    expect(result.sessions).toBe(3);
    expect(result.messages).toBe(7);
    expect(client.calls.some((s) => /UPDATE tenants SET chat_data_purged_at/i.test(s))).toBe(true);
    expect(client.calls.some((s) => /INSERT INTO audit_logs/i.test(s))).toBe(true);
    expect(client.calls.some((s) => /COMMIT/i.test(s))).toBe(true);
  });
});

describe("findTenantsDueForPurge", () => {
  it("予約済みで猶予経過のテナントを返す", async () => {
    const poolQuery = jest.fn(async () => ({
      rows: [{ id: "t1", chat_data_purge_requested_at: "2020-01-01T00:00:00.000Z" }],
    }));
    const pool: any = { query: poolQuery };
    const due = await findTenantsDueForPurge(30, pool);
    expect(due).toEqual([{ tenant_id: "t1", requested_at: "2020-01-01T00:00:00.000Z" }]);
    // NOW() - grace の条件を SQL に含む
    expect(/chat_data_purge_requested_at IS NOT NULL/i.test((poolQuery.mock.calls[0] as any[])[0])).toBe(true);
  });
});
