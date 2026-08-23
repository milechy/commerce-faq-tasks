// src/integrations/notion/salesLogNotionSink.test.ts
// GID 1216970103691946 (PR-11): SalesLogWriter の Notion sink 実装のテスト。

const mockPagesCreate = jest.fn();
jest.mock("@notionhq/client", () => ({
  Client: jest.fn().mockImplementation(() => ({
    pages: { create: (...args: unknown[]) => mockPagesCreate(...args) },
  })),
  isNotionClientError: () => false,
}));

import { createSalesLogNotionSink } from "./salesLogNotionSink";
import type { SalesLogRecord } from "../../agent/orchestrator/sales/salesLogWriter";

const RECORD: SalesLogRecord = {
  tenantId: "tenant:demo",
  sessionId: "session:123",
  phase: "propose",
  prevStage: "clarify",
  nextStage: "propose",
  stageTransitionReason: "auto_progress_by_intent",
  intent: "trial_lesson_offer",
  personaTags: ["beginner"],
  userMessage: "体験レッスンはありますか",
  templateSource: "notion",
  templateId: "page-abc",
  templateText: "体験レッスンをご案内します。",
  promptPreview: "体験レッスンをご案内します。",
  timestamp: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  mockPagesCreate.mockReset().mockResolvedValue({});
});

describe("createSalesLogNotionSink", () => {
  it("apiKey/databaseIdが無い場合はエラーを投げる", () => {
    expect(() => createSalesLogNotionSink({ apiKey: undefined, databaseId: "db-1" })).toThrow(
      /NOTION_API_KEY/,
    );
    expect(() => createSalesLogNotionSink({ apiKey: "key-1", databaseId: undefined })).toThrow(
      /NOTION_DB_SALES_LOG_ID/,
    );
  });

  it("SalesLogRecordの各フィールドをNotionプロパティにマッピングしてpages.createを呼ぶ", async () => {
    const sink = createSalesLogNotionSink({ apiKey: "key-1", databaseId: "db-1" });
    await sink.write(RECORD);

    expect(mockPagesCreate).toHaveBeenCalledTimes(1);
    const [args] = mockPagesCreate.mock.calls[0] as [any];
    expect(args.parent).toEqual({ database_id: "db-1" });
    expect(args.properties.TenantId.title[0].text.content).toBe("tenant:demo");
    expect(args.properties.SessionId.rich_text[0].text.content).toBe("session:123");
    expect(args.properties.Phase.select.name).toBe("propose");
    expect(args.properties.PrevStage.select.name).toBe("clarify");
    expect(args.properties.NextStage.select.name).toBe("propose");
    expect(args.properties.TemplateId.rich_text[0].text.content).toBe("page-abc");
  });

  it("prevStageがnullのときはPrevStageをNotionのselect:nullとして送る(空文字にしない)", async () => {
    const sink = createSalesLogNotionSink({ apiKey: "key-1", databaseId: "db-1" });
    await sink.write({ ...RECORD, prevStage: null });

    const [args] = mockPagesCreate.mock.calls[0] as [any];
    expect(args.properties.PrevStage).toEqual({ select: null });
  });

  it("templateIdがnull(fallback)のときはTemplateIdプロパティ自体を含めない", async () => {
    const sink = createSalesLogNotionSink({ apiKey: "key-1", databaseId: "db-1" });
    await sink.write({ ...RECORD, templateSource: "fallback", templateId: null });

    const [args] = mockPagesCreate.mock.calls[0] as [any];
    expect(args.properties.TemplateId).toBeUndefined();
  });

  it("Notion API呼び出しが失敗しても例外を投げない(best-effort)", async () => {
    mockPagesCreate.mockRejectedValueOnce(new Error("network error"));
    const sink = createSalesLogNotionSink({ apiKey: "key-1", databaseId: "db-1" });

    await expect(sink.write(RECORD)).resolves.toBeUndefined();
  });
});
