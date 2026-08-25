// src/api/admin/chat-history/chatHistoryRepository.outcome.test.ts
// getConversionTypes / recordOutcome / getSessionOutcome の単体テスト。
// これら3関数は agentRoutes.test.ts では jest.mock でモジュールごと差し替えられているため、
// SQL・パラメータ・フォールバック挙動そのものはこれまで一切実行されていなかった。

const mockQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import {
  getConversionTypes,
  getNonConvertingOutcomes,
  recordOutcome,
  getSessionOutcome,
  getActiveEscalations,
  AUTO_OUTCOME_RECORDED_BY,
} from "./chatHistoryRepository";

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

describe("getNonConvertingOutcomes", () => {
  // memoryDistiller.ts(learned_memory昇格, D2) と abResultsOutcomeSync.ts(CV副次指標)が
  // 共有する唯一の情報源。「末尾2件が非成約」という慣習は conversion_types が3件以上の
  // ときにのみ意味を持つため、境界(2件/3件/0件)を明示的に固定する。

  it("5件構成(既定値)では末尾2件('離脱','不明')が非成約、reliable=true", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ conversion_types: ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"] }],
    });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result).toEqual({ nonConvertingOutcomes: ["離脱", "不明"], reliable: true });
  });

  it("境界: ちょうど3件なら末尾2件が非成約、reliable=true", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: ["成約", "離脱", "不明"] }] });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result).toEqual({ nonConvertingOutcomes: ["離脱", "不明"], reliable: true });
  });

  it("回帰: 2件だと慣習が成立せず、reliable=falseかつ全件を返す(呼び出し元が誤って成約系を非成約扱いしないよう明示する)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: ["成約", "キャンセル"] }] });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result.reliable).toBe(false);
    // slice(-2) をそのまま使うと "成約" まで非成約扱いになるため、reliable=false のときは
    // 呼び出し元が nonConvertingOutcomes を判定に使わない前提で、生の配列を返す。
    expect(result.nonConvertingOutcomes).toEqual(["成約", "キャンセル"]);
  });

  it("回帰: 1件だと reliable=false", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: ["成約"] }] });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result.reliable).toBe(false);
  });

  it("回帰: 空配列だと reliable=false(空配列のまま返す。呼び出し元が誤って全件成約扱いしないよう明示する)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: [] }] });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result).toEqual({ nonConvertingOutcomes: [], reliable: false });
  });

  it("conversion_types未設定(null)なら既定5件にフォールバックし、reliable=true", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: null }] });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result).toEqual({ nonConvertingOutcomes: ["離脱", "不明"], reliable: true });
  });

  it("10件構成でも末尾2件のみが非成約になる(先頭側の成約系を巻き込まない)", async () => {
    const types = ["A", "B", "C", "D", "E", "F", "G", "H", "離脱", "不明"];
    mockQuery.mockResolvedValueOnce({ rows: [{ conversion_types: types }] });

    const result = await getNonConvertingOutcomes("tenant-abc");

    expect(result).toEqual({ nonConvertingOutcomes: ["離脱", "不明"], reliable: true });
  });
});

describe("recordOutcome", () => {
  it("正しいSQL(UPDATE chat_sessions ... WHERE id = $3 AND tenant_id = $4)とパラメータで更新する", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "sess-db-1" }] }); // UPDATE ... RETURNING id
    mockQuery.mockResolvedValueOnce({ rows: [] });     // createNotification内のINSERT(fire-and-forget)

    await recordOutcome({
      sessionDbId: "sess-db-1",
      tenantId: "tenant-abc",
      outcome: "購入完了",
      recordedBy: "staff@example.com",
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE chat_sessions");
    expect(sql).toContain("WHERE id = $3 AND tenant_id = $4");
    expect(sql).toContain("RETURNING id");
    expect(params).toEqual(["購入完了", "staff@example.com", "sess-db-1", "tenant-abc"]);
  });

  it("recordedBy が null でも正しく渡る(チャット経由は実行者メールを持たないため)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "sess-db-1" }] });
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
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "sess-db-1" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await recordOutcome({
      sessionDbId: "sess-db-1",
      tenantId: "tenant-abc",
      outcome: "離脱",
      recordedBy: null,
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("離脱");
    expect(result!.recordedBy).toBeNull();
    expect(typeof result!.recordedAt).toBe("string");
  });

  // PR-6訂正: 以前は rowCount を見ておらず、UPDATE が対象行0件(セッションが
  // 競合削除された、または越境)で終わっても例外にならず無音で「成功」の戻り値を
  // 返していた(CLAUDE.md 禁止20違反)。RETURNING id + rows.length===0 チェックで
  // 「無い/越境」を null として呼び出し元に返す。
  it("UPDATEが対象0件(RETURNING行なし)ならnullを返し、通知も出さない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // 対象セッションが存在しない/越境

    const result = await recordOutcome({
      sessionDbId: "sess-does-not-exist",
      tenantId: "tenant-abc",
      outcome: "購入完了",
      recordedBy: null,
    });

    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1); // 通知INSERTは呼ばれない
  });

  it("通知(createNotification)がDBエラーで失敗しても、recordOutcome自体は成功として解決する(fire-and-forgetで例外を伝播させない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "sess-db-1" }] }); // UPDATE 成功
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

  // GID 1216970103691946 (PR-6): 自動記録(recordedBy=AUTO_OUTCOME_RECORDED_BY)は
  // 通知を出さない(CVの度に通知が大量発生するのを防ぐ)。
  it("recordedByがAUTO_OUTCOME_RECORDED_BYのときは通知(createNotification)を呼ばない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "sess-db-1" }] }); // UPDATEのみ

    const result = await recordOutcome({
      sessionDbId: "sess-db-1",
      tenantId: "tenant-abc",
      outcome: "購入完了",
      recordedBy: AUTO_OUTCOME_RECORDED_BY,
    });

    expect(result).not.toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1); // UPDATEのみ、通知INSERTは呼ばれない
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

  // -------------------------------------------------------------------------
  // GID 1217808492496192: source(e2e/内部テスト)フィルタ。
  // 既定は 'user' のみ(NULLも安全側でuser扱いに含める)、'all' 明示時だけ全件。
  // count クエリと一覧クエリの両方に同じ条件が効くことを固定する
  // (対象0件→count 0件、対象N件→count N件が常に一致すること)。
  // -------------------------------------------------------------------------

  const SOURCE_FILTER_CONDITION = "s.metadata->>'source' = 'user' OR s.metadata->>'source' IS NULL";

  it("source未指定(既定)は 'user' と source未設定(NULL)を対象にする条件をSELECTとCOUNTの両方に含める", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "2" }] }); // COUNT
    mockQuery.mockResolvedValueOnce({ rows: [ROW, { ...ROW, id: "s2" }] }); // SELECT

    await getActiveEscalations("tenant-a");

    const countSql = mockQuery.mock.calls[0]![0] as string;
    const listSql = mockQuery.mock.calls[1]![0] as string;
    expect(countSql).toContain(SOURCE_FILTER_CONDITION);
    expect(listSql).toContain(SOURCE_FILTER_CONDITION);
  });

  // actionExecutor.ts の get_escalations ツールは getActiveEscalations(tenantId, limit) の
  // 2引数で呼ぶ(source は渡さない)。JSのデフォルト引数は「呼び出し側の引数の個数」ではなく
  // 「その位置の値がundefinedか」で発火するため2引数呼び出しでも既定'user'が効くはずだが、
  // 実際にそのシェイプ(位置引数2つ)で呼んでも同じ結果になることを固定しておく
  // (チャットエージェントがe2e残骸を店主に見せてしまう回帰を防ぐ)。
  it("[get_escalationsツール回帰] tenantIdとlimitの2引数のみの呼び出しでも既定sourceフィルタが効く", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] }); // COUNT
    mockQuery.mockResolvedValueOnce({ rows: [ROW] }); // SELECT

    await getActiveEscalations("tenant-abc", 20);

    const countSql = mockQuery.mock.calls[0]![0] as string;
    const listSql = mockQuery.mock.calls[1]![0] as string;
    expect(countSql).toContain(SOURCE_FILTER_CONDITION);
    expect(listSql).toContain(SOURCE_FILTER_CONDITION);
  });

  it("source='all' を渡すと source 条件を追加せず、e2e等も含めた全件になる", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] }); // COUNT
    mockQuery.mockResolvedValueOnce({ rows: [ROW] }); // SELECT

    await getActiveEscalations("tenant-a", undefined, "all");

    const countSql = mockQuery.mock.calls[0]![0] as string;
    const listSql = mockQuery.mock.calls[1]![0] as string;
    expect(countSql).not.toContain(SOURCE_FILTER_CONDITION);
    expect(listSql).not.toContain(SOURCE_FILTER_CONDITION);
  });

  it("SELECTは metadata->>'source' を source 列として返し、user/e2e/未設定(NULL)の3種類をそのまま反映する", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] }); // COUNT
    mockQuery.mockResolvedValueOnce({
      rows: [
        { ...ROW, id: "s-user", source: "user" },
        { ...ROW, id: "s-e2e", source: "e2e" },
        { ...ROW, id: "s-null", source: null },
      ],
    });

    const result = await getActiveEscalations("tenant-a", undefined, "all");

    const listSql = mockQuery.mock.calls[1]![0] as string;
    expect(listSql).toContain(`s.metadata->>'source' AS source`);
    expect(result.escalations.map((e) => e.source)).toEqual(["user", "e2e", null]);
  });

  it("total は絞る前の実件数のまま(source条件を反映したcountだが、絞った一覧件数とは独立)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "373" }] }); // COUNT: e2e混入時の実件数を模す
    mockQuery.mockResolvedValueOnce({ rows: [ROW] }); // SELECT: limitで絞られた結果

    const result = await getActiveEscalations("tenant-a", 1);

    expect(result.total).toBe(373);
    expect(result.escalations).toHaveLength(1);
  });
});
