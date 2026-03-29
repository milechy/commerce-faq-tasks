// src/agent/knowledge/bookStructurizer.ts
// Phase47 Stream A: 心理学書籍テキストを構造化原則としてfaq_embeddingsに保存する

import { readFile } from 'fs/promises';
import { join } from 'path';
import pino from 'pino';
import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';
import { embedText } from '../llm/openaiEmbeddingClient';
import { splitIntoChunks } from './bookChunker';

const logger = pino();

const BOOK_STRUCTURIZE_BATCH_SIZE = 10;
const MAX_CONSECUTIVE_FAILURES = 5;
const BATCH_WAIT_MS = 1000;
const FIELD_MAX_CHARS = 200;
const ES_INDEX = process.env['ES_FAQ_INDEX'] ?? 'faqs';

export interface StructuredPrinciple {
  situation: string;
  resistance: string;
  principle: string;
  contraindication: string;
  example: string;
  failure_example: string;
}

export interface StructurizeResult {
  totalChunks: number;
  structuredCount: number;
  skippedCount: number;
  failedCount: number;
  principles: StructuredPrinciple[];
}

async function upsertToEs(docId: string, doc: Record<string, unknown>): Promise<void> {
  const esUrl = process.env['ES_URL'];
  if (!esUrl) return;
  const url = `${esUrl.replace(/\/$/, '')}/${ES_INDEX}/_doc/${encodeURIComponent(docId)}`;
  try {
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
  } catch {
    // best-effort ES sync failure should not block pipeline
  }
}

function truncateField(value: unknown): string {
  return String(value ?? '').slice(0, FIELD_MAX_CHARS);
}

function buildSearchText(p: StructuredPrinciple): string {
  // Combine fields for embedding — each already truncated to FIELD_MAX_CHARS
  return [
    `【原則】${p.principle}`,
    `【状況】${p.situation}`,
    `【抵抗】${p.resistance}`,
    `【例文】${p.example}`,
  ]
    .join('\n')
    .slice(0, 800); // 800字以内でベクトル化
}

/**
 * 書籍フルテキストを心理原則として構造化しfaq_embeddingsに保存する。
 *
 * - BOOK_STRUCTURIZE_ENABLED=true が必要
 * - チャンク単位でGeminiを呼び出し、BATCH_SIZE=10チャンクごとに1秒待機
 * - 5回連続でGemini失敗した場合は早期終了
 * - Anti-Slop: 各フィールドは200字以内、書籍内容をログに出力しない
 * - Never throws
 */
export async function structurizeBook(
  tenantId: string,
  bookId: number,
  fullText: string,
): Promise<StructurizeResult> {
  const result: StructurizeResult = {
    totalChunks: 0,
    structuredCount: 0,
    skippedCount: 0,
    failedCount: 0,
    principles: [],
  };

  if (process.env['BOOK_STRUCTURIZE_ENABLED'] !== 'true') {
    logger.info('bookStructurizer: BOOK_STRUCTURIZE_ENABLED is not true, skipping');
    return result;
  }

  // プロンプトテンプレートを読み込む
  let promptTemplate: string;
  try {
    const promptPath = join(process.cwd(), 'config', 'bookStructurizerPrompt.md');
    promptTemplate = await readFile(promptPath, 'utf-8');
  } catch (err) {
    logger.error({ err }, 'bookStructurizer: failed to load prompt template');
    return result;
  }

  const chunks = splitIntoChunks(fullText);
  result.totalChunks = chunks.length;

  if (chunks.length === 0) return result;

  const pool = getPool();
  let consecutiveFailures = 0;

  for (let i = 0; i < chunks.length; i++) {
    // バッチ間の待機（最初のチャンク以外、BATCH_SIZE の倍数ごと）
    if (i > 0 && i % BOOK_STRUCTURIZE_BATCH_SIZE === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, BATCH_WAIT_MS));
    }

    const chunk = chunks[i]!;
    const prompt = promptTemplate.replace('{{CHUNK_TEXT}}', chunk.text);

    let raw: string;
    try {
      raw = await callGeminiJudge(prompt);
      consecutiveFailures = 0;
    } catch (err) {
      logger.warn({ err, chunkIndex: chunk.chunkIndex }, 'bookStructurizer: Gemini call failed');
      consecutiveFailures++;
      result.failedCount++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          { consecutiveFailures, chunkIndex: chunk.chunkIndex },
          'bookStructurizer: too many consecutive Gemini failures, aborting',
        );
        break;
      }
      continue;
    }

    // JSON配列を抽出
    let principles: StructuredPrinciple[];
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // 心理原則なし（目次・参考文献等）— スキップ
        result.skippedCount++;
        continue;
      }
      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      if (!Array.isArray(parsed) || parsed.length === 0) {
        result.skippedCount++;
        continue;
      }
      principles = parsed.map((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return {
          situation: truncateField(obj['situation']),
          resistance: truncateField(obj['resistance']),
          principle: truncateField(obj['principle']),
          contraindication: truncateField(obj['contraindication']),
          example: truncateField(obj['example']),
          failure_example: truncateField(obj['failure_example']),
        };
      });
    } catch (err) {
      logger.warn({ err, chunkIndex: chunk.chunkIndex }, 'bookStructurizer: JSON parse failed');
      result.failedCount++;
      continue;
    }

    // 各原則をfaq_embeddingsに保存
    for (const principle of principles) {
      const searchText = buildSearchText(principle);

      let vector: number[];
      try {
        vector = await embedText(searchText);
      } catch (err) {
        logger.warn({ err, principle: principle.principle }, 'bookStructurizer: embedText failed');
        result.failedCount++;
        continue;
      }

      const metadata = {
        source: 'book',
        book_id: bookId,
        chunk_index: chunk.chunkIndex,
        page_hint: chunk.pageHint ?? null,
        principle: principle.principle,
        situation: principle.situation,
        contraindication: principle.contraindication,
        failure_example: principle.failure_example,
      };

      try {
        const dbResult = await pool.query<{ id: number }>(
          `INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata)
           VALUES ($1, $2, $3::vector, $4::jsonb)
           RETURNING id`,
          [
            tenantId,
            // faq_embeddingsのtextは検索用テキスト（書籍原文は含めない）
            searchText,
            `[${vector.join(',')}]`,
            JSON.stringify(metadata),
          ],
        );

        const embeddingId = dbResult.rows[0]?.id;

        // ES 同期（fire-and-forget、Anti-Slop: 書籍原文は含めない）
        if (embeddingId != null) {
          const docId = `book_${bookId}_chunk_${chunk.chunkIndex}_${principle.principle.slice(0, 30)}`;
          void upsertToEs(docId, {
            tenant_id: tenantId,
            question: principle.situation.slice(0, 200),
            answer: principle.example.slice(0, 200),
            source: 'book',
            book_id: bookId,
            chunk_index: chunk.chunkIndex,
            principle: principle.principle,
            is_published: true,
          });
        }

        result.structuredCount++;
        result.principles.push(principle);
      } catch (err) {
        logger.warn(
          { err, principle: principle.principle },
          'bookStructurizer: DB insert failed',
        );
        result.failedCount++;
      }
    }
  }

  logger.info(
    {
      tenantId,
      bookId,
      totalChunks: result.totalChunks,
      structuredCount: result.structuredCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
    },
    'bookStructurizer: complete',
  );

  return result;
}
