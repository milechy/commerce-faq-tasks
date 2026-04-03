// src/lib/book-pipeline/contentAnalyzer.test.ts

import { analyzeContentType, KNOWN_SCHEMAS } from "./contentAnalyzer";

// Gemini クライアントをモック
jest.mock("../gemini/client", () => ({
  callGeminiJudge: jest.fn(),
}));
import { callGeminiJudge } from "../gemini/client";
const mockCallGemini = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;

const SAMPLE_PAGES = [
  { pageNumber: 1, text: "心理学的アプローチによる営業技術の解説。顧客の抵抗を乗り越える原則を学ぶ。" },
];

const BUSINESS_PAGES = [
  { pageNumber: 1, text: "2024年度第3四半期財務報告。売上高は前年比15%増加し、営業利益率が改善した。" },
];

describe("analyzeContentType", () => {
  afterEach(() => {
    mockCallGemini.mockReset();
  });

  test("1: 心理学書籍として正しく判定される", async () => {
    mockCallGemini.mockResolvedValue(
      JSON.stringify({
        content_type: "psychology_book",
        content_type_label: "心理学書籍",
        confidence: 0.9,
        reasoning: "心理学と営業技術に関する書籍です。",
      })
    );

    const result = await analyzeContentType(SAMPLE_PAGES, "営業心理学入門");
    expect(result.content_type).toBe("psychology_book");
    expect(result.content_type_label).toBe("心理学書籍");
    expect(result.confidence).toBe(0.9);
    expect(result.suggested_schema).toBe(KNOWN_SCHEMAS.psychology_book);
  });

  test("2: ビジネス文書として正しく判定される", async () => {
    mockCallGemini.mockResolvedValue(
      JSON.stringify({
        content_type: "business_document",
        content_type_label: "ビジネス文書",
        confidence: 0.85,
        reasoning: "財務報告書です。",
      })
    );

    const result = await analyzeContentType(BUSINESS_PAGES, "Q3財務報告");
    expect(result.content_type).toBe("business_document");
    expect(result.suggested_schema).toBe(KNOWN_SCHEMAS.business_document);
  });

  test("3: Gemini 失敗時は general_report にフォールバックする", async () => {
    mockCallGemini.mockRejectedValue(new Error("Gemini API error: 500"));

    const result = await analyzeContentType(SAMPLE_PAGES, "テスト");
    expect(result.content_type).toBe("general_report");
    expect(result.confidence).toBe(0.0);
    expect(result.suggested_schema).toBe(KNOWN_SCHEMAS.general_report);
  });

  test("4: 不明な content_type は general_report にフォールバックする", async () => {
    mockCallGemini.mockResolvedValue(
      JSON.stringify({
        content_type: "unknown_type",
        content_type_label: "不明",
        confidence: 0.3,
        reasoning: "分類不能",
      })
    );

    const result = await analyzeContentType(SAMPLE_PAGES, "謎のPDF");
    expect(result.content_type).toBe("general_report");
    expect(result.suggested_schema).toBe(KNOWN_SCHEMAS.general_report);
  });

  test("5: Gemini が不正な JSON を返した場合は general_report にフォールバックする", async () => {
    mockCallGemini.mockResolvedValue("これはJSONではありません");

    const result = await analyzeContentType(SAMPLE_PAGES, "テスト");
    expect(result.content_type).toBe("general_report");
    expect(result.confidence).toBe(0.0);
  });

  test("6: confidence が 0-1 の範囲にクランプされる", async () => {
    mockCallGemini.mockResolvedValue(
      JSON.stringify({
        content_type: "sales_manual",
        content_type_label: "営業マニュアル",
        confidence: 1.5, // 範囲外
        reasoning: "テスト",
      })
    );

    const result = await analyzeContentType(SAMPLE_PAGES, "テスト");
    expect(result.confidence).toBe(1.0);
  });

  test("7: Gemini レスポンスが ```json ``` ブロックに包まれていても正しくパースされる", async () => {
    mockCallGemini.mockResolvedValue(
      "```json\n" +
        JSON.stringify({
          content_type: "product_catalog",
          content_type_label: "商品カタログ",
          confidence: 0.7,
          reasoning: "商品一覧です。",
        }) +
        "\n```"
    );

    const result = await analyzeContentType(SAMPLE_PAGES, "製品カタログ2024");
    expect(result.content_type).toBe("product_catalog");
    expect(result.suggested_schema).toBe(KNOWN_SCHEMAS.product_catalog);
  });

  test("8: ページが空の場合でも例外なく処理される", async () => {
    mockCallGemini.mockResolvedValue(
      JSON.stringify({
        content_type: "general_report",
        content_type_label: "一般レポート",
        confidence: 0.5,
        reasoning: "テキストが少ないため判定困難。",
      })
    );

    const result = await analyzeContentType([], "空のPDF");
    expect(result.content_type).toBe("general_report");
  });
});
