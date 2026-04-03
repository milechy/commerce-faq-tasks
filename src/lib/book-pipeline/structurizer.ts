// src/lib/book-pipeline/structurizer.ts
// Phase44: Groq 8b を使った 6 フィールド構造化モジュール
// CLAUDE.md: 書籍内容をログに出力しない

import { groqClient } from "../../agent/llm/groqClient";
import type { TextChunk } from "./chunkSplitter";
import type { SchemaField } from "./contentAnalyzer";

export interface StructuredChunk {
  chunkIndex: number;
  pageNumber: number;
  originalText: string;
  category: string;
  summary: string;
  keywords: string[];
  question: string;
  answer: string;
  confidence: number;
  schemaFields?: Record<string, string>;
}

export interface StructurizerDeps {
  groq?: typeof groqClient;
  schema?: SchemaField[];
}

const MODEL = "llama-3.1-8b-instant";
const DELAY_MS = 200; // Groq レート制限対策

const BASE_SYSTEM_PROMPT = `あなたは書籍コンテンツのFAQ化アシスタントです。
与えられたテキストを分析し、必ず以下のJSON形式のみで回答してください。余計なテキストは不要です。

{
  "category": "カテゴリ名（製品/サービス/手順/概念/その他）",
  "summary": "内容の1〜2文の要約",
  "keywords": ["キーワード1", "キーワード2", "キーワード3"],
  "question": "このテキストに対応する典型的な質問",
  "answer": "質問への200文字以内の回答",
  "confidence": 0.0〜1.0の信頼度スコア
}`;

function buildSystemPrompt(schema?: SchemaField[]): string {
  if (!schema || schema.length === 0) return BASE_SYSTEM_PROMPT;

  const fieldLines = schema
    .map((f) => `  "${f.key}": "${f.label} — ${f.description}"`)
    .join(",\n");

  return `あなたは書籍コンテンツのFAQ化アシスタントです。
与えられたテキストを分析し、必ず以下のJSON形式のみで回答してください。余計なテキストは不要です。

{
  "category": "カテゴリ名（製品/サービス/手順/概念/その他）",
  "summary": "内容の1〜2文の要約",
  "keywords": ["キーワード1", "キーワード2", "キーワード3"],
  "question": "このテキストに対応する典型的な質問",
  "answer": "質問への200文字以内の回答",
  "confidence": 0.0〜1.0の信頼度スコア,
  "schema_fields": {
${fieldLines}
  }
}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStructuredResponse(
  raw: string,
  schema?: SchemaField[]
): Omit<StructuredChunk, "chunkIndex" | "pageNumber" | "originalText"> | null {
  // JSON ブロックを抽出
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const category = typeof parsed.category === "string" ? parsed.category.trim() : "その他";
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k: unknown) => typeof k === "string").slice(0, 10)
      : [];
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    const answer = typeof parsed.answer === "string"
      ? parsed.answer.trim().slice(0, 200)
      : "";
    const confidence = typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;

    let schemaFields: Record<string, string> | undefined;
    if (schema && schema.length > 0 && parsed.schema_fields && typeof parsed.schema_fields === "object") {
      schemaFields = {};
      for (const field of schema) {
        const val = (parsed.schema_fields as Record<string, unknown>)[field.key];
        if (typeof val === "string" && val.trim()) {
          schemaFields[field.key] = val.trim();
        }
      }
      if (Object.keys(schemaFields).length === 0) schemaFields = undefined;
    }

    return { category, summary, keywords, question, answer, confidence, schemaFields };
  } catch {
    return null;
  }
}

/**
 * TextChunk 配列を Groq 8b で構造化する。
 * deps.schema が指定された場合、そのスキーマのフィールドも schema_fields として取得する。
 * 各チャンク間に 200ms の遅延を挟む（レート制限対策）。
 * パース失敗時はフォールバック値を使用。
 */
export async function structurizeChunks(
  chunks: TextChunk[],
  deps: StructurizerDeps = {}
): Promise<StructuredChunk[]> {
  const client = deps.groq ?? groqClient;
  const schema = deps.schema;
  const systemPrompt = buildSystemPrompt(schema);
  const maxTokens = schema && schema.length > 0 ? 768 : 512;
  const results: StructuredChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (i > 0) {
      await sleep(DELAY_MS);
    }

    let structured: Omit<StructuredChunk, "chunkIndex" | "pageNumber" | "originalText">;

    try {
      const raw = await client.call({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: chunk.text },
        ],
        temperature: 0,
        maxTokens,
        tag: "book-structurize",
      });

      const parsed = parseStructuredResponse(raw, schema);
      if (parsed) {
        structured = parsed;
      } else {
        // パース失敗: フォールバック
        structured = {
          category: "その他",
          summary: "",
          keywords: [],
          question: "",
          answer: "",
          confidence: 0,
        };
      }
    } catch {
      // API エラー: フォールバック
      structured = {
        category: "その他",
        summary: "",
        keywords: [],
        question: "",
        answer: "",
        confidence: 0,
      };
    }

    results.push({
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber,
      originalText: chunk.text,
      ...structured,
    });
  }

  return results;
}
