import {
  buildSalesLogRecord,
  setGlobalSalesLogWriter,
  writeSalesLogViaGlobal,
  SalesLogWriter,
  type SalesLogRecord,
  type SalesLogSink,
} from "./salesLogWriter";

describe("buildSalesLogRecord", () => {
  it("ステージ遷移メタとテンプレ情報を正しくマージしてレコードを生成できる", () => {
    const timestamp = new Date("2025-01-02T03:04:05.000Z");

    const record = buildSalesLogRecord({
      context: { tenantId: "tenant:demo", sessionId: "session:123" },
      phase: "propose",
      prevStage: "clarify",
      nextStage: "propose",
      stageTransitionReason: "auto_progress_by_intent",
      intent: "trial_lesson_offer",
      personaTags: ["beginner"],
      userMessage: "体験レッスンってありますか？",
      templateSource: "notion",
      templateId: "notion:page:123",
      templateText: "体験レッスンのご案内テンプレートです。",
      timestamp,
    });

    expect(record.tenantId).toBe("tenant:demo");
    expect(record.sessionId).toBe("session:123");
    expect(record.phase).toBe("propose");

    expect(record.prevStage).toBe("clarify");
    expect(record.nextStage).toBe("propose");
    expect(record.stageTransitionReason).toBe("auto_progress_by_intent");

    expect(record.intent).toBe("trial_lesson_offer");
    expect(record.personaTags).toEqual(["beginner"]);
    expect(record.userMessage).toBe("体験レッスンってありますか？");
    expect(record.templateSource).toBe("notion");
    expect(record.templateId).toBe("notion:page:123");
    expect(record.templateText).toBe("体験レッスンのご案内テンプレートです。");
    expect(record.promptPreview).toBe("体験レッスンのご案内テンプレートです。");

    expect(record.timestamp).toBe(timestamp.toISOString());
  });

  it("templateText が長い場合は promptPreview を 120 文字でトリムする", () => {
    const longText = "X".repeat(200);

    const record = buildSalesLogRecord({
      context: { tenantId: "tenant:demo", sessionId: "session:123" },
      phase: "propose",
      prevStage: null,
      nextStage: "propose",
      stageTransitionReason: "stay_in_stage",
      intent: "dummy_intent",
      personaTags: [],
      userMessage: "hi",
      templateSource: "fallback",
      templateId: null,
      templateText: longText,
    });

    expect(record.templateText).toBe(longText);
    expect(record.promptPreview.length).toBe(120);
    expect(record.promptPreview).toBe(longText.slice(0, 120));
  });
});

// GID 1216970103691946 (PR-11): globalWriter を設定する入口が無く、
// writeSalesLogViaGlobal が常に no-op だった不具合の回帰テスト。
describe("setGlobalSalesLogWriter / writeSalesLogViaGlobal", () => {
  const DUMMY_RECORD: SalesLogRecord = {
    tenantId: "tenant:demo",
    sessionId: "session:123",
    phase: "propose",
    prevStage: "clarify",
    nextStage: "propose",
    stageTransitionReason: "auto_progress_by_intent",
    intent: "trial_lesson_offer",
    personaTags: ["beginner"],
    userMessage: "hi",
    templateSource: "fallback",
    templateId: null,
    templateText: "template",
    promptPreview: "template",
    timestamp: "2026-08-01T00:00:00.000Z",
  };

  afterEach(() => {
    setGlobalSalesLogWriter(undefined); // 他テストへ副作用を残さない
  });

  it("setGlobalSalesLogWriter を呼ばない場合、writeSalesLogViaGlobal は何もせず解決する(従来のno-op挙動)", async () => {
    await expect(writeSalesLogViaGlobal(DUMMY_RECORD)).resolves.toBeUndefined();
  });

  it("setGlobalSalesLogWriter で設定した writer の sink に実際に書き込まれる", async () => {
    const mockSink: SalesLogSink = { write: jest.fn().mockResolvedValue(undefined) };
    setGlobalSalesLogWriter(new SalesLogWriter(mockSink));

    await writeSalesLogViaGlobal(DUMMY_RECORD);

    expect(mockSink.write).toHaveBeenCalledWith(DUMMY_RECORD);
  });

  it("setGlobalSalesLogWriter(undefined) で再びno-opに戻せる", async () => {
    const mockSink: SalesLogSink = { write: jest.fn().mockResolvedValue(undefined) };
    setGlobalSalesLogWriter(new SalesLogWriter(mockSink));
    setGlobalSalesLogWriter(undefined);

    await writeSalesLogViaGlobal(DUMMY_RECORD);

    expect(mockSink.write).not.toHaveBeenCalled();
  });
});
