// src/api/admin/chat-history/chatHistoryRepository.outcome.test.ts
// getConversionTypes / recordOutcome / getSessionOutcome の単体テスト。
// これら3関数は agentRoutes.test.ts では jest.mock でモジュールごと差し替えられているため、
// SQL・パラメータ・フォールバック挙動そのものはこれまで一切実行されていなかった。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { getConversionTypes, recordOutcome, getSessionOutcome, getActiveEscalations } from "./chatHistoryRepository";

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getConversionTypes", () => {
  it("テナントに conversion_types が設定されていれば、その配列をそのまま返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: ["購入完了", "資料請求"] }] });

    const result = await getConversionTypes("tenant-abc");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT conversion_types FROM tenants WHERE id = $1"),
      ["tenant-abc"],
    );
    expect(result).toEqual(["購入完了", "資料請求"]);
  });

  it("conversion_types が null(未設定)なら既定の5種類にフォールバックする", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: null }] });

    const result = await getConversionTypes("tenant-abc");

    expect(result).toEqual(["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"]);
  });

  it("テナント行自体が見つからない(rows[0]がundefined)場合も既定値にフォールバックする", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getConversionTypes("tenant-missing");

    expect(result).toEqual(["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"]);
  });

  // 既知のリスク: conversion_types が「null」ではなく「空配列 []」として設定されている場合、
  // ?? による既定値フォールバックは発火しない(null/undefinedのみが対象のため)。結果として
  // record_session_outcome は常に「有効な選択肢:」の後ろが空文字になり、どんなoutcomeを
  // 指定しても許可されなくなる(成果記録機能が事実上使えなくなる)。設定ミスへの対処
  // (空配列も未設定として扱うなど)は現状コードに存在しない。
  it("[既知のリスク] conversion_types が空配列の場合、既定値にフォールバックせず空配列のまま返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: [] }] });

    const result = await getConversionTypes("tenant-misconfigured");

    expect(result).toEqual([]);
  });
});

describe("recordOutcome", () => {
  it("正しいSQL(UPDATE chat_sessions ... WHERE id = $3)とパラメータで更新する", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [] });     // createNotification内のINSERT(fire-and-forget)

    await recordOutcome({
      sessionDbId: "sess-db-1",
      tenantId: "tenant-abc",
      outcome: "購入完了",
      recordedBy: "staff@example.com",
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE chat_sessions");
    expect(sql).toContain("WHERE id = $3");
    expect(params).toEqual(["購入完了", "staff@example.com", "sess-db-1"]);
  });

  it("recordedBy が null でも正しく渡る(チャット経由は実行者メールを持たないため)", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordOutcome({
      sessionDbId: "sess-db-1",
      tenantId: "tenant-abc",
      outcome: "予約完了",
      recordedBy: null,
    });

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[1]).toBeNull();
  });

  it("戻り値の outcome/recordedBy は渡した値をそのまま反映する", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await recordOutcome({
      sessionDbId: "sess-db-1",
      tenantId: "tenant-abc",
      outcome: "離脱",
      recordedBy: null,
    });

    expect(result.outcome).toBe("離脱");
    expect(result.recordedBy).toBeNull();
    expect(typeof result.recordedAt).toBe("string");
  });

  // 既知のリスク: deleteSessionRepository.deleteSession() は削除行数(rowCount)を検証し、
  // 0件なら null を返して呼び出し元(actionExecutor)が「見つかりません」を返せるようにしている。
  // recordOutcome() には同種の検証が無く、UPDATE が対象行0件(セッションが競合削除された等)
  // で終わっても例外にならず「成功」の戻り値を返す。actionExecutor.ts の
  // record_session_outcome はこの戻り値を無条件に「記録しました」として表示するため、
  // 実際には何も更新されていないのに成功したように見えるケースがありうる。
  it("[既知のリスク] UPDATEが対象0件(rowCount:0)でも例外にならず「成功」の戻り値を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // 対象セッションが既に存在しない
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      recordOutcome({
        sessionDbId: "sess-does-not-exist",
        tenantId: "tenant-abc",
        outcome: "購入完了",
        recordedBy: null,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ outcome: "購入完了" }),
    );
  });

  it("通知(createNotification)がDBエラーで失敗しても、recordOutcome自体は成功として解決する(fire-and-forgetで例外を伝播させない)", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE 成功
    mockQuery.mockRejectedValueOnce(new Error("notifications insert failed")); // 通知INSERTは失敗

    await expect(
      recordOutcome({
        sessionDbId: "sess-db-1",
        tenantId: "tenant-abc",
        outcome: "購入完了",
        recordedBy: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ outcome: "購入完了" }));
  });
});

describe("getSessionOutcome", () => {
  it("記録済みならoutcome/記録日時/記録者を返す", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ outcome: "購入完了", outcome_recorded_at: "2026-07-17T10:00:00Z", outcome_recorded_by: "a@example.com" }],
    });

    const result = await getSessionOutcome("sess-db-1");

    expect(result).toEqual({
      outcome: "購入完了",
      outcomeRecordedAt: "2026-07-17T10:00:00Z",
      outcomeRecordedBy: "a@example.com",
    });
  });

  it("行は存在するがoutcomeが未記録(null)の場合、outcome:nullを返す(未記録と「行が無い」を区別する)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ outcome: null, outcome_recorded_at: null, outcome_recorded_by: null }],
    });

    const result = await getSessionOutcome("sess-db-1");

    expect(result).toEqual({ outcome: null, outcomeRecordedAt: null, outcomeRecordedBy: null });
  });

  it("セッション行自体が存在しない場合はnullを返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getSessionOutcome("sess-not-found");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getActiveEscalations の件数上限。旧UIのHTTPルート(limit未指定)は従来どおり
// 全件返す必要があり、チャットツールだけが上限を渡す。total は常に絞る前の
// 実件数であること(絞った件数を全件数として見せない)を固定する。
// ---------------------------------------------------------------------------

describe("getActiveEscalations", () => {
  const ROW = {
    id: "s1", tenant_id: "tenant-a", session_id: "sess-1",
    escalated_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-01T00:00:00Z",
    message_count: 3, first_message_preview: "help",
  };

  it("limit未指定なら LIMIT を付けず全件返す(旧UIのHTTPルート経路の後方互換)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "2" }] });      // COUNT
    mockQuery.mockResolvedValueOnce({ rows: [ROW, { ...ROW, id: "s2" }] }); // SELECT

    const result = await getActiveEscalations("tenant-a");

    const listSql = mockQuery.mock.calls[1]![0] as string;
    expect(listSql).not.toContain("LIMIT $");
    expect(result.escalations).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("limit指定時は LIMIT を付け、total は絞る前の実件数を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "120" }] }); // COUNT: 実件数
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });              // SELECT: 絞られた結果

    const result = await getActiveEscalations("tenant-a", 20);

    const listSql = mockQuery.mock.calls[1]![0] as string;
    const listArgs = mockQuery.mock.calls[1]![1] as unknown[];
    expect(listSql).toContain("LIMIT $2");
    expect(listArgs).toEqual(["tenant-a", 20]);
    expect(result.escalations).toHaveLength(1);
    expect(result.total).toBe(120); // 絞った件数(1)ではない
  });

  it("tenantId未指定(super_admin全テナント)でも limit を正しいプレースホルダ番号で渡す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "5" }] });
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });

    await getActiveEscalations(undefined, 20);

    // tenant条件が無いぶん limit は $1 になる(番号ズレの回帰)
    expect(mockQuery.mock.calls[1]![0] as string).toContain("LIMIT $1");
    expect(mockQuery.mock.calls[1]![1] as unknown[]).toEqual([20]);
  });
});
