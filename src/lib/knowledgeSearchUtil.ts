// src/lib/knowledgeSearchUtil.ts
// Phase60-A: 共通ナレッジ検索ユーティリティ
// LLM提案機能（チューニング/Judge/ギャップ/AIアシスタント）が使う共通RAGラッパー。
// Anti-Slop: ragExcerpt ≤ 200文字。書籍内容をログ出力禁止。エラー時は空配列を返す。

import { embedText } from '../agent/llm/openaiEmbeddingClient';
import { pool } from './db';
import { decryptText } from './crypto/textEncrypt';
import { logger } from './logger';

export interface KnowledgeSearchOpts {
  limit?: number;
  maxCharsPerResult?: number;
}

export interface KnowledgeItem {
  text: string;
  score: number;
  source: string; // metadata->>'source' の値 ('faq' | 'book' | etc.)
}

export interface KnowledgeContext {
  results: KnowledgeItem[];
}

/**
 * faq_embeddings テーブルを pgvector で検索し、ナレッジコンテキストを返す。
 * tenant_id + global の両方を対象とする。
 * エラー時は空配列を返す（提案機能のフォールバック用）。
 */
export async function searchKnowledgeForSuggestion(
  tenantId: string,
  query: string,
  opts: KnowledgeSearchOpts = {},
): Promise<KnowledgeContext> {
  const { limit = 5, maxCharsPerResult = 200 } = opts;

  if (!tenantId || !query.trim()) return { results: [] };
  if (!pool) return { results: [] };

  try {
    const embedding = await embedText(query);
    const embeddingLiteral = `[${embedding.join(',')}]`;

    const result = await pool.query(
      `SELECT
         text,
         1 - (embedding <-> $1::vector) / 2 AS score,
         COALESCE(metadata->>'source', 'faq') AS source
       FROM faq_embeddings
       WHERE tenant_id = $2 OR tenant_id = 'global'
       ORDER BY embedding <-> $1::vector
       LIMIT $3`,
      [embeddingLiteral, tenantId, limit],
    );

    return {
      results: (result.rows as any[]).map((row) => ({
        // Anti-Slop: ragExcerpt.slice(0, maxCharsPerResult) 必須
        text: decryptText(row.text ?? '').slice(0, maxCharsPerResult),
        score: Math.max(
          0,
          Math.min(
            1,
            typeof row.score === 'number' ? row.score : Number(row.score) || 0,
          ),
        ),
        source: String(row.source ?? 'faq'),
      })),
    };
  } catch (err) {
    // 書籍内容をログに含めない（Anti-Slop）
    logger.warn({ err, tenantId }, '[knowledgeSearchUtil] search failed, returning empty');
    return { results: [] };
  }
}

/**
 * KnowledgeContext を LLM プロンプトに注入できる形にフォーマットする。
 * 結果が0件の場合は空文字列を返す。
 */
export function formatKnowledgeContext(ctx: KnowledgeContext): string {
  if (!ctx.results.length) return '';
  return ctx.results
    .map((item, i) => `${i + 1}. [${item.source}] ${item.text} (score: ${item.score.toFixed(2)})`)
    .join('\n');
}
