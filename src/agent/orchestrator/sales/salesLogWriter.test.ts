import { buildSalesLogRecord } from "./salesLogWriter";

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
