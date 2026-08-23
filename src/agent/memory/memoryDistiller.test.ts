// src/agent/memory/memoryDistiller.test.ts
// Phase71-A: memoryDistiller テスト

import { distillAndPromote } from "./memoryDistiller";
import { groqClient } from "../llm/groqClient";
import { createLearnedMemoryRepository } from "./learnedMemoryRepository";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn() },
}));

jest.mock("./learnedMemoryRepository", () => ({
  createLearnedMemoryRepository: jest.fn(),
}));

// GID 1216978660043409 (PR-17, R9): CV/outcome判定に使うDB層のモック。
const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));
// getNonConvertingOutcomes(conversion_types → 非成約終端の導出)自体の単体テストは
// chatHistoryRepository.getNonConvertingOutcomes.test.ts に置く。ここでは
// distillAndPromote が getNonConvertingOutcomes の結果(reliable/nonConvertingOutcomes)を
// 正しく使い分けるかだけを、結果を直接モックして検証する(導出ロジックを再実装しない)。
const mockGetNonConvertingOutcomes = jest.fn();
jest.mock("../../api/admin/chat-history/chatHistoryRepository", () => ({
  getNonConvertingOutcomes: (...args: unknown[]) => mockGetNonConvertingOutcomes(...args),
}));

const mockCall = groqClient.call as jest.Mock;
const mockCreateRepo = createLearnedMemoryRepository as jest.Mock;
const mockSave = jest.fn();

/** conversion_attributions に行がある想定でDBモックを設定する(=CVを伴う会話)。 */
function mockHasAttribution() {
  mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: true, outcome: null }] });
}

/** outcome が成約系(非成約終端2件でない)想定でDBモックを設定する。 */
function mockHasConvertingOutcome(outcome = "購入完了") {
  mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: false, outcome }] });
}

/** CV/outcomeどちらも無い想定でDBモックを設定する。 */
function mockNoConversion() {
  mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: false, outcome: null }] });
}

const ENV_KEYS = [
  "LEARNED_MEMORY_ENABLED",
  "LEARNED_MEMORY_TENANTS",
  "LEARNED_MEMORY_THRESHOLD",
] as const;

const MESSAGES = [
  { role: "user", content: "保証はありますか" },
  { role: "assistant", content: "全車3ヶ月保証付きです。延長保証もご用意しています。" },
];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = "test"; // embedText がダミーベクトルを返す
  mockCreateRepo.mockReturnValue({ saveLearnedMemory: mockSave });
  mockSave.mockResolvedValue(true);
  mockGetNonConvertingOutcomes.mockReset().mockResolvedValue({ nonConvertingOutcomes: ["離脱", "不明"], reliable: true });
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function enable(tenant = "carnation") {
  process.env.LEARNED_MEMORY_ENABLED = "true";
  process.env.LEARNED_MEMORY_TENANTS = tenant;
}

describe("distillAndPromote", () => {
  it("Feature Flag (write) オフなら蒸留せず false", async () => {
    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 95,
      messages: MESSAGES,
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("スコアが閾値未満なら蒸留しない", async () => {
    enable();
    process.env.LEARNED_MEMORY_THRESHOLD = "80";
    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 70,
      messages: MESSAGES,
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("高スコアなら蒸留→保存し true", async () => {
    enable();
    mockHasAttribution();
    mockCall.mockResolvedValue(
      '{"question":"保証はありますか","answer":"全車3ヶ月保証付きです"}',
    );

    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    expect(ok).toBe(true);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
    const saved = mockSave.mock.calls[0]![0];
    expect(saved.tenantId).toBe("carnation");
    expect(saved.question).toBe("保証はありますか");
    expect(saved.answer).toBe("全車3ヶ月保証付きです");
    expect(saved.judgeScore).toBe(90);
    expect(saved.embedding).toHaveLength(1536); // ダミー埋め込み
  });

  it("蒸留が空Q&Aを返したら保存しない", async () => {
    enable();
    mockHasAttribution();
    mockCall.mockResolvedValue('{"question":"","answer":""}');

    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    expect(ok).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("メッセージが2未満なら蒸留しない", async () => {
    enable();
    const ok = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ok).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("Groq が例外でも伝播させず false", async () => {
    enable();
    mockHasAttribution();
    mockCall.mockRejectedValue(new Error("groq down"));

    await expect(
      distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      }),
    ).resolves.toBe(false);
  });

  // ---------------------------------------------------------------------
  // GID 1216978660043409 (PR-17, R9 / D2): 高スコアだが成果なしは昇格しない
  // ---------------------------------------------------------------------
  describe("D2: CV/outcomeを伴う会話のみ昇格する", () => {
    it("高スコアだがCV/outcomeが無い会話は蒸留せず false(Groqを呼ばない)", async () => {
      enable();
      mockNoConversion();

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 95,
        messages: MESSAGES,
      });

      expect(ok).toBe(false);
      expect(mockCall).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("conversion_attributions に行があれば昇格する", async () => {
      enable();
      mockHasAttribution();
      mockCall.mockResolvedValue(
        '{"question":"保証はありますか","answer":"全車3ヶ月保証付きです"}',
      );

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      });

      expect(ok).toBe(true);
    });

    it("outcomeが成約系(テナントのconversion_types非成約終端2件でない)なら昇格する", async () => {
      enable();
      mockHasConvertingOutcome("予約完了");
      mockCall.mockResolvedValue(
        '{"question":"保証はありますか","answer":"全車3ヶ月保証付きです"}',
      );

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      });

      expect(ok).toBe(true);
    });

    it("outcomeが非成約終端(既定'離脱'/'不明')なら昇格しない", async () => {
      enable();
      mockHasConvertingOutcome("離脱");

      const ok = await distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      });

      expect(ok).toBe(false);
      expect(mockCall).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// GID 1216978660043409 (PR-17, R9 / D2) 補強:
// 「非成約終端2件」ヒューリスティックの境界と、テナントがconversion_typesを
// カスタマイズしたときの挙動を固定する。
//
// この判定は abResultsOutcomeSync.ts と共有の慣習(既定配列の並び「成約系…、離脱、不明」の
// 末尾2件が非成約)に依存しており、テナントが3件未満に縮めると前提が崩れる。
// 崩れ方を明示的にテストで固定し、仕様変更時に無言で通らないようにする。
// ---------------------------------------------------------------------------

describe("D2: conversion_types をカスタマイズしたテナントでの境界", () => {
  function enableTenant(tenant = "carnation") {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = tenant;
  }

  async function promoteWithOutcome(outcome: string): Promise<boolean> {
    mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: false, outcome }] });
    mockCall.mockResolvedValue('{"question":"q","answer":"a"}');
    return distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });
  }

  it("reliable=trueかつ非成約終端でないoutcomeなら昇格する(既定5件構成相当)", async () => {
    enableTenant();
    mockGetNonConvertingOutcomes.mockResolvedValue({
      nonConvertingOutcomes: ["離脱", "不明"],
      reliable: true,
    });

    await expect(promoteWithOutcome("問い合わせ送信")).resolves.toBe(true);
  });

  it("reliable=trueでも非成約終端に含まれるoutcomeなら昇格しない", async () => {
    enableTenant();
    mockGetNonConvertingOutcomes.mockResolvedValue({
      nonConvertingOutcomes: ["離脱", "不明"],
      reliable: true,
    });

    await expect(promoteWithOutcome("離脱")).resolves.toBe(false);
  });

  it("回帰: reliable=false(conversion_types 3件未満)なら、成約系に見えるoutcomeでも昇格しない", async () => {
    // conversion_types が2件("成約","キャンセル")だと slice(-2) が配列全体を返し、
    // "成約" まで非成約扱いになる(getNonConvertingOutcomes.test.ts が導出ロジック自体を検証する)。
    // ここでは distillAndPromote が reliable=false を「わからない」として安全側に倒す
    // (成約と断定して昇格しない)ことだけを確認する。
    enableTenant();
    mockGetNonConvertingOutcomes.mockResolvedValue({
      nonConvertingOutcomes: ["成約", "キャンセル"],
      reliable: false,
    });

    const promoted = await promoteWithOutcome("成約");

    expect(promoted).toBe(false); // 本来は成約かもしれないが、断定できないため昇格しない
    expect(mockCall).not.toHaveBeenCalled(); // Groq課金も発生しない
  });

  it("outcome が空文字なら昇格しない(未記録と同じ扱い)", async () => {
    enableTenant();
    mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: false, outcome: "" }] });

    const promoted = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    expect(promoted).toBe(false);
    expect(mockGetNonConvertingOutcomes).not.toHaveBeenCalled(); // 判定まで進まない
  });

  it("conversion_attributions がある場合は conversion_types を参照せず昇格する(順序保証)", async () => {
    // CV イベントが構造化されて存在するなら outcome ラベルの解釈は不要。
    // 余計なDB往復を増やしていないことも同時に固定する。
    enableTenant();
    mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: true, outcome: "離脱" }] });
    mockCall.mockResolvedValue('{"question":"q","answer":"a"}');

    const promoted = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    expect(promoted).toBe(true);
    expect(mockGetNonConvertingOutcomes).not.toHaveBeenCalled();
  });

  it("セッションがDBに存在しない場合は昇格せず、Groqも呼ばない", async () => {
    enableTenant();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const promoted = await distillAndPromote({
      tenantId: "carnation",
      sessionId: "missing",
      judgeScore: 95,
      messages: MESSAGES,
    });

    expect(promoted).toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("CV判定のDBクエリが失敗しても例外を伝播させず false(本番フローを止めない)", async () => {
    enableTenant();
    mockQuery.mockRejectedValueOnce(new Error("db down"));

    await expect(
      distillAndPromote({
        tenantId: "carnation",
        sessionId: "s1",
        judgeScore: 90,
        messages: MESSAGES,
      }),
    ).resolves.toBe(false);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("CV判定は必ず (tenant_id, session_id) の複合で行う(session_id単独で他テナントを拾わない)", async () => {
    enableTenant();
    mockQuery.mockResolvedValueOnce({ rows: [{ has_attribution: true, outcome: null }] });
    mockCall.mockResolvedValue('{"question":"q","answer":"a"}');

    await distillAndPromote({
      tenantId: "carnation",
      sessionId: "s1",
      judgeScore: 90,
      messages: MESSAGES,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("cs.tenant_id = $1");
    expect(sql).toContain("cs.session_id = $2");
    expect(params).toEqual(["carnation", "s1"]);
  });
});
