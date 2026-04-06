// src/lib/book-pipeline/contentAnalyzer.ts

// Phase50: PDF コンテンツ種類判定 — Gemini 2.5 Flash で種類・スキーマを自動提案
// CLAUDE.md: 書籍内容をログに出力しない（サンプルテキストはログに出さない）

import { callGeminiJudge } from "../gemini/client";
import { logger } from '../logger';

export interface SchemaField {
  key: string;
  label: string;
  description: string;
}

export interface ContentAnalysis {
  content_type: string;
  content_type_label: string;
  suggested_schema: SchemaField[];
  confidence: number;
  reasoning: string;
}

export const KNOWN_SCHEMAS: Record<string, SchemaField[]> = {
  psychology_book: [
    { key: "situation", label: "状況", description: "この知識が適用される状況" },
    { key: "resistance", label: "抵抗", description: "顧客の心理的抵抗" },
    { key: "principle", label: "原則", description: "適用すべき心理学原則" },
    { key: "contraindication", label: "禁忌", description: "使ってはいけない状況" },
    { key: "example", label: "例", description: "具体的な成功例" },
    { key: "failure_example", label: "失敗例", description: "失敗するケース" },
  ],
  sales_manual: [
    { key: "target_customer", label: "対象顧客", description: "ターゲット顧客の特徴" },
    { key: "problem", label: "課題", description: "顧客が抱える課題" },
    { key: "solution", label: "解決策", description: "提案する解決策" },
    { key: "benefit", label: "メリット", description: "顧客にとってのメリット" },
    { key: "objection_handling", label: "反論対応", description: "予想される反論と対処法" },
  ],
  product_catalog: [
    { key: "product_name", label: "商品名", description: "商品・サービス名" },
    { key: "spec", label: "仕様", description: "主な仕様・特徴" },
    { key: "price_range", label: "価格帯", description: "価格情報" },
    { key: "target", label: "対象", description: "ターゲット層" },
    { key: "comparison", label: "比較優位", description: "競合との差別化ポイント" },
  ],
  business_document: [
    { key: "topic", label: "テーマ", description: "主なテーマ・論点" },
    { key: "key_finding", label: "要点", description: "重要な発見・結論" },
    { key: "data_point", label: "データ", description: "根拠となるデータ・数値" },
    { key: "implication", label: "示唆", description: "ビジネスへの示唆" },
  ],
  general_report: [
    { key: "topic", label: "テーマ", description: "主なテーマ" },
    { key: "key_finding", label: "要点", description: "主要な発見" },
    { key: "data_point", label: "データ", description: "関連データ" },
    { key: "implication", label: "示唆", description: "結論・示唆" },
  ],
};

const VALID_TYPES = new Set(Object.keys(KNOWN_SCHEMAS));

const FALLBACK: ContentAnalysis = {
  content_type: "general_report",
  content_type_label: "一般レポート",
  suggested_schema: KNOWN_SCHEMAS.general_report,
  confidence: 0.0,
  reasoning: "自動判定に失敗しました。デフォルトの構造化を適用します。",
};

/**
 * PDF の冒頭テキストから Gemini 2.5 Flash でコンテンツ種類を判定する。
 * 失敗時は general_report にフォールバック（例外は throw しない）。
 *
 * Anti-Slop: sampleText をログに出力しない。文字数のみ記録可。
 */
export async function analyzeContentType(
  pages: { pageNumber: number; text: string }[],
  title: string
): Promise<ContentAnalysis> {
  // 最初の3ページの先頭200文字ずつ（最大600文字）
  const sampleText = pages
    .slice(0, 3)
    .map((p) => p.text.slice(0, 200))
    .join("\n---\n");

  const prompt = `あなたはドキュメント分類の専門家です。
以下のPDFのタイトルと冒頭テキストから、コンテンツの種類を判定してください。

タイトル: ${title}

冒頭テキスト（各ページの抜粋）:
${sampleText}

以下のJSON形式のみで回答してください（JSON以外は出力しないでください）:
{
  "content_type": "psychology_book" | "sales_manual" | "product_catalog" | "business_document" | "general_report" | "other",
  "content_type_label": "日本語ラベル",
  "confidence": 0.0〜1.0,
  "reasoning": "判定理由を日本語で1-2文"
}

判定基準:
- psychology_book: 心理学、行動科学、営業心理、説得術に関する書籍
- sales_manual: 営業マニュアル、セールスガイド、商談テクニック
- product_catalog: 商品カタログ、サービス一覧、スペック表
- business_document: ビジネス文書、企画書、分析レポート、財務資料
- general_report: 上記に該当しない一般的なレポート・資料
- other: 分類不能`;

  try {
    const response = await callGeminiJudge(prompt);
    const cleaned = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const parsed = JSON.parse(cleaned) as {
      content_type?: unknown;
      content_type_label?: unknown;
      confidence?: unknown;
      reasoning?: unknown;
    };

    const rawType = typeof parsed.content_type === "string" ? parsed.content_type : "";
    const contentType = VALID_TYPES.has(rawType) ? rawType : "general_report";

    return {
      content_type: contentType,
      content_type_label:
        typeof parsed.content_type_label === "string"
          ? parsed.content_type_label
          : contentType,
      suggested_schema: KNOWN_SCHEMAS[contentType] ?? KNOWN_SCHEMAS.general_report,
      confidence:
        typeof parsed.confidence === "number"
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0.5,
      reasoning:
        typeof parsed.reasoning === "string" ? parsed.reasoning : "自動判定",
    };
  } catch (err) {
    logger.error(
      "[contentAnalyzer] Gemini error:",
      err instanceof Error ? err.message : String(err)
    );
    return FALLBACK;
  }
}
