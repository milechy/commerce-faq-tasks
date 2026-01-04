import type { SalesPhase, SalesTemplate } from "./salesRules";
import { getSalesTemplate, setSalesTemplateProvider } from "./salesRules";

describe("getSalesTemplate (Phase15 fallback)", () => {
  afterEach(() => {
    // 各テスト後に Provider をデフォルト状態（null を返す）に戻す
    setSalesTemplateProvider(() => null);
  });

  it("Provider がテンプレートを返す場合は、その結果をそのまま返す", () => {
    const phase: SalesPhase = "propose";

    const providerTemplate: SalesTemplate = {
      id: "notion:123",
      phase,
      intent: "trial_lesson_offer",
      personaTags: ["beginner"],
      template: "NOTION_TEMPLATE",
    };

    setSalesTemplateProvider(() => providerTemplate);

    const result = getSalesTemplate({
      phase,
      intent: "trial_lesson_offer",
      personaTags: ["beginner"],
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("notion:123");
    expect(result!.template).toBe("NOTION_TEMPLATE");
    expect(result!.phase).toBe(phase);
    expect(result!.personaTags).toEqual(["beginner"]);
  });

  it("Provider が null を返す場合は、phase ごとのフォールバックテンプレートを返す（non-beginner）", () => {
    const phase: SalesPhase = "propose";

    // Provider は何も返さない
    setSalesTemplateProvider(() => null);

    const result = getSalesTemplate({
      phase,
      intent: "trial_lesson_offer",
      personaTags: ["business"],
    });

    expect(result).not.toBeNull();
    if (!result) return;

    // ID は fallback:phase 形式
    expect(result.id).toBe("fallback:propose");
    expect(result.phase).toBe(phase);

    // personaTags はそのまま引き継がれる
    expect(result.personaTags).toEqual(["business"]);

    // fallback テンプレートであること
    expect(result.source).toBe("fallback");
    // matrixKey は phase|intent|personaTag (ANY) 形式
    expect(result.matrixKey).toBe("propose|trial_lesson_offer|ANY");

    // non-beginner 用の propose fallback 文面が入っていることを軽く確認
    expect(result.template).toContain(
      "具体的なプラン案と料金の目安を提案してください"
    );
  });

  it("Provider が null を返し、personaTags に beginner が含まれる場合は beginner 向けフォールバックを返す", () => {
    const phase: SalesPhase = "propose";

    setSalesTemplateProvider(() => null);

    const result = getSalesTemplate({
      phase,
      intent: "trial_lesson_offer",
      personaTags: ["beginner"],
    });

    expect(result).not.toBeNull();
    if (!result) return;

    // beginner 向けの ID が振られる
    expect(result.id).toBe("fallback:propose:beginner");
    expect(result.phase).toBe(phase);
    expect(result.personaTags).toEqual(["beginner"]);

    // fallback テンプレートであること
    expect(result.source).toBe("fallback");
    // matrixKey は phase|intent|personaTag (beginner) 形式
    expect(result.matrixKey).toBe("propose|trial_lesson_offer|beginner");

    // beginner 用文面であることを確認
    expect(result.template).toContain("ユーザーは初心者想定です。");
  });

  it("clarify / recommend / close もフォールバックテンプレートが返る", () => {
    setSalesTemplateProvider(() => null);

    const clarify = getSalesTemplate({ phase: "clarify", personaTags: [] });
    const recommend = getSalesTemplate({ phase: "recommend", personaTags: [] });
    const close = getSalesTemplate({ phase: "close", personaTags: [] });

    expect(clarify).not.toBeNull();
    expect(recommend).not.toBeNull();
    expect(close).not.toBeNull();

    if (!clarify || !recommend || !close) return;

    expect(clarify.id).toBe("fallback:clarify");
    expect(recommend.id).toBe("fallback:recommend");
    expect(close.id).toBe("fallback:close");

    // いずれも fallback テンプレートであること
    expect(clarify.source).toBe("fallback");
    expect(recommend.source).toBe("fallback");
    expect(close.source).toBe("fallback");

    // intent 未指定の場合は intent=ANY, personaTag=ANY として matrixKey が付与される
    expect(clarify.matrixKey).toBe("clarify|ANY|ANY");
    expect(recommend.matrixKey).toBe("recommend|ANY|ANY");
    expect(close.matrixKey).toBe("close|ANY|ANY");

    expect(clarify.template).toContain("ヒアリング担当");
    expect(recommend.template).toContain("最も合いそうな選択肢を 1 つ推薦");
    expect(close.template).toContain("次の具体的なステップ");
  });
});
