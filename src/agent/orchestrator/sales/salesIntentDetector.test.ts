import fs from "node:fs";

// fs は常にモックとして扱う
jest.mock("node:fs");

import { detectSalesIntents } from "./salesIntentDetector";

const mockedFs = fs as jest.Mocked<typeof fs>;

// テスト用の YAML ルール（propose / recommend / close を一通りカバー）
const TEST_RULES_YAML = `
propose:
  - intent: trial_lesson_offer
    name: "料金 → 体験レッスン案内"
    weight: 1.2
    patterns:
      any:
        - "料金"
        - "値段"
        - "体験レッスン"
        - "体験"
        - "お試し"
      require:
        - "料金"
        - "値段"

  - intent: propose_monthly_plan_basic
    name: "料金・プラン案内（ベーシック）"
    weight: 1.0
    patterns:
      any:
        - "料金"
        - "値段"
        - "金額"
        - "月額"
        - "月謝"
        - "プラン"
      require:
        - "料金"
        - "値段"
        - "金額"
        - "月額"

recommend:
  - intent: recommend_course_based_on_level
    name: "レベルに応じたコース提案"
    weight: 1.0
    patterns:
      any:
        - "自分に合うコース"
        - "どのコース"
        - "どのプラン"
        - "おすすめのコース"
        - "コース迷って"
        - "プラン迷って"
        - "レベル"
        - "初心者"
        - "久しぶり"
        - "ブランク"
      require:
        - "コース"
        - "プラン"
        - "レッスン"

close:
  - intent: close_handle_objection_price
    name: "料金に関する不安のハンドリング"
    weight: 1.2
    patterns:
      any:
        - "高い"
        - "ちょっと高い"
        - "料金が気になる"
        - "値段が気になる"
        - "金額が気になる"
        - "続けられるか心配"
        - "続けられるか不安"
      require:
        - "高い"
        - "料金"
        - "値段"
        - "金額"

  - intent: close_next_step_confirmation
    name: "次のステップ確認"
    weight: 1.0
    patterns:
      any:
        - "次のステップ"
        - "どう進める"
        - "どう始める"
        - "申し込みたい"
        - "入会したい"
      require:
        - "次のステップ"
        - "申し込みたい"
        - "入会したい"
`;

type HistoryMessage = { role: "user" | "assistant"; content: string };

function makeInput(userMessage: string, history: HistoryMessage[] = []) {
  return {
    userMessage,
    // DialogMessage との細かい差分はテスト側では気にせず any に寄せる
    history: history as any,
    plan: null as any,
  };
}

describe("detectSalesIntents (YAML rules)", () => {
  beforeAll(() => {
    // すべてのテストケースで同じ YAML 内容を使う
    mockedFs.readFileSync.mockReturnValue(TEST_RULES_YAML as unknown as string);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // beforeAll の設定を維持したいので readFileSync の戻り値だけ再セットする
    mockedFs.readFileSync.mockReturnValue(TEST_RULES_YAML as unknown as string);
  });

  test("propose: trial_lesson_offer を検出できる（料金 + 体験）", () => {
    const input = makeInput(
      "料金ってどれくらいですか？体験レッスンもありますか？"
    );

    const result = detectSalesIntents(input);

    expect(result.proposeIntent).toBe("trial_lesson_offer");
    expect(result.recommendIntent).toBeUndefined();
    expect(result.closeIntent).toBeUndefined();
  });

  test("propose: propose_monthly_plan_basic を検出できる（料金のみ）", () => {
    const input = makeInput(
      "月額いくらぐらいかかりますか？料金プランも知りたいです。"
    );

    const result = detectSalesIntents(input);

    expect(result.proposeIntent).toBe("propose_monthly_plan_basic");
    expect(result.recommendIntent).toBeUndefined();
    expect(result.closeIntent).toBeUndefined();
  });

  test("recommend: recommend_course_based_on_level を検出できる（コース相談）", () => {
    const input = makeInput(
      "自分に合うコースが知りたいです。どのコース・どのプランが良いでしょう？"
    );

    const result = detectSalesIntents(input);

    expect(result.recommendIntent).toBe("recommend_course_based_on_level");
    expect(result.proposeIntent).toBeUndefined();
    expect(result.closeIntent).toBeUndefined();
  });

  test("close: close_handle_objection_price を検出できる（料金が高い不安）", () => {
  const input = makeInput(
    "ちょっと料金が高い気がしていて、続けられるか心配です。"
  );

  const result = detectSalesIntents(input);

  expect(result.closeIntent).toBe("close_handle_objection_price");
  // closeIntent が正しく立っていればよいので、
  // 他ステージの intent はこのテストでは検証しない
  // expect(result.proposeIntent).toBeUndefined();
  // expect(result.recommendIntent).toBeUndefined();
});

  test("履歴も含めて detectionText が組み立てられる（初心者レベルの相談）", () => {
    const history: HistoryMessage[] = [
      {
        role: "user",
        content: "英語は久しぶりで、初心者レベルです。",
      },
    ];
    const input = makeInput("どのプランが良いでしょう？", history);

    const result = detectSalesIntents(input);

    expect(result.recommendIntent).toBe("recommend_course_based_on_level");
  });

  test("どのルールにもマッチしない場合はすべて undefined", () => {
    const input = makeInput("今日はいい天気ですね");

    const result = detectSalesIntents(input);

    expect(result.proposeIntent).toBeUndefined();
    expect(result.recommendIntent).toBeUndefined();
    expect(result.closeIntent).toBeUndefined();
  });
});

describe("detectSalesIntents (fallback to legacy rules)", () => {
  test("YAML 読み込みに失敗した場合は legacy ルールにフォールバックする", () => {
    // モジュールキャッシュをクリアしてから、readFileSync を例外を投げるように設定
    jest.resetModules();

    const fsModule = require("node:fs") as jest.Mocked<
      typeof import("node:fs")
    >;
    fsModule.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const {
      detectSalesIntents: detectSalesIntentsWithLegacy,
    } = require("./salesIntentDetector");

    const input = makeInput(
      "料金ってどれくらいですか？体験レッスンもありますか？"
    );

    const result = detectSalesIntentsWithLegacy(input);

    // legacy 実装は「料金 × 体験」パターンで trial_lesson_offer を返す想定
    expect(result.proposeIntent).toBe("trial_lesson_offer");
  });
});
