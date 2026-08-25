// src/api/admin/agent/actionExecutorGapKnowledge.test.ts
//
// ナレッジ配線是正「チャット完結」(Asana GID 1217811043900566):
// approve_gap_recommendation / add_knowledge_from_gap の2ツールを追加し、
// ギャップ承認→知識追加までをチャットの中だけで完結できるようにした。
// 書き込みは knowledge-gaps/routes.ts の approveGapRecommendation /
// addKnowledgeFromGap を共有するため、その関数自体のDB/embedding/ES同期の
// 挙動は gapApiUnification.test.ts / addKnowledgeIndexSync.test.ts が既にカバーする。
// ここでは actionExecutor.ts の配線(確認ゲート・引数の受け渡し・
// エラー理由→応答文言のマッピング・出所と根拠の提示)だけを確認する。

jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockApproveGapRecommendation = jest.fn();
const mockAddKnowledgeFromGap = jest.fn();
jest.mock("../knowledge-gaps/routes", () => ({
  approveGapRecommendation: (...args: unknown[]) => mockApproveGapRecommendation(...args),
  addKnowledgeFromGap: (...args: unknown[]) => mockAddKnowledgeFromGap(...args),
}));

import type { Pool } from "pg";
import { executeToolCall } from "./actionExecutor";

const TENANT = "acme";
const ACTOR = { role: "owner", email: "owner@example.com" };

function makeMockPool(): Pool {
  return { query: jest.fn() } as unknown as Pool;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("executeToolCall: approve_gap_recommendation", () => {
  it("confirmed未指定なら承認処理を呼ばない(確認ゲート)", async () => {
    const result = await executeToolCall(
      "approve_gap_recommendation",
      { gap_id: 42 },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(result).toContain("確認が必要です");
    expect(mockApproveGapRecommendation).not.toHaveBeenCalled();
  });

  it("confirmed=trueなら承認し、応答に質問文・検出源・頻度(出所と根拠)を含める", async () => {
    mockApproveGapRecommendation.mockResolvedValue({
      ok: true,
      userQuestion: "保証期間はどのくらいですか",
      detectionSource: "no_rag",
      frequency: 5,
    });

    const result = await executeToolCall(
      "approve_gap_recommendation",
      { gap_id: 42, confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(mockApproveGapRecommendation).toHaveBeenCalledWith(42, TENANT, false);
    expect(result).toContain("保証期間はどのくらいですか");
    expect(result).toContain("no_rag");
    expect(result).toContain("5");
  });

  it("見つからないギャップIDならエラーメッセージを返す", async () => {
    mockApproveGapRecommendation.mockResolvedValue({ ok: false, reason: "not_found" });

    const result = await executeToolCall(
      "approve_gap_recommendation",
      { gap_id: 999, confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(result).toContain("見つかりません");
  });
});

describe("executeToolCall: add_knowledge_from_gap", () => {
  it("confirmed未指定ならFAQ作成処理を呼ばない(確認ゲート)", async () => {
    const result = await executeToolCall(
      "add_knowledge_from_gap",
      { gap_id: 42, answer_text: "3ヶ月保証です" },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(result).toContain("確認が必要です");
    expect(mockAddKnowledgeFromGap).not.toHaveBeenCalled();
  });

  it("承認済みでないギャップ(409相当)には「承認してください」という応答を返す", async () => {
    mockAddKnowledgeFromGap.mockResolvedValue({ ok: false, reason: "not_approved" });

    const result = await executeToolCall(
      "add_knowledge_from_gap",
      { gap_id: 42, answer_text: "3ヶ月保証です", confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(result).toContain("承認されていません");
    expect(result).toContain("approve_gap_recommendation");
  });

  it("テナント越境のgap_id(403相当)は「他のテナント」という応答を返す", async () => {
    mockAddKnowledgeFromGap.mockResolvedValue({ ok: false, reason: "forbidden" });

    const result = await executeToolCall(
      "add_knowledge_from_gap",
      { gap_id: 42, answer_text: "3ヶ月保証です", confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(result).toContain("他のテナント");
  });

  it("存在しないgap_id(404相当)には「見つかりません」を返す", async () => {
    mockAddKnowledgeFromGap.mockResolvedValue({ ok: false, reason: "not_found" });

    const result = await executeToolCall(
      "add_knowledge_from_gap",
      { gap_id: 999, answer_text: "3ヶ月保証です", confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(result).toContain("見つかりません");
  });

  it("成功時はFAQ IDと、出所・根拠(質問文・検出源・頻度)を応答に含める", async () => {
    mockAddKnowledgeFromGap.mockResolvedValue({
      ok: true,
      faqDocId: 555,
      gapQuestion: "保証期間はどのくらいですか",
      detectionSource: "low_confidence",
      frequency: 3,
    });

    const result = await executeToolCall(
      "add_knowledge_from_gap",
      { gap_id: 42, answer_text: "3ヶ月保証です", category: "warranty", confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      false,
      ACTOR,
    );

    expect(mockAddKnowledgeFromGap).toHaveBeenCalledWith(42, "3ヶ月保証です", "warranty", TENANT, false);
    expect(result).toContain("555");
    expect(result).toContain("保証期間はどのくらいですか");
    expect(result).toContain("low_confidence");
    expect(result).toContain("解決済み");
  });

  it("super_adminフラグをそのまま渡す(テナント越境チェックの免除はaddKnowledgeFromGap側の責務)", async () => {
    mockAddKnowledgeFromGap.mockResolvedValue({
      ok: true,
      faqDocId: 1,
      gapQuestion: "q",
      detectionSource: null,
      frequency: null,
    });

    await executeToolCall(
      "add_knowledge_from_gap",
      { gap_id: 1, answer_text: "a", confirmed: true },
      TENANT,
      makeMockPool(),
      "session-1",
      true,
      ACTOR,
    );

    expect(mockAddKnowledgeFromGap).toHaveBeenCalledWith(1, "a", null, TENANT, true);
  });
});
