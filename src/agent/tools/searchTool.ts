// src/agent/tools/searchTool.ts

import { hybridSearch, type Hit } from '../../search/hybrid';
import { searchPgVector } from '../../search/pgvector';
import { embedTextWithUsage } from '../llm/openaiEmbeddingClient';

export interface SearchToolInput {
  query: string;
  tenantId?: string;
  /** Phase69-2: 検索結果から除外するエントリID一覧 */
  excludedIds?: string[];
}

export interface SearchToolOutput {
  items: Hit[];
  ms: number;
  note?: string;
  /** embedding呼び出しで消費したトークン数（課金合算用） */
  embeddingTokens?: number;
}

export async function searchTool(
  input: SearchToolInput,
): Promise<SearchToolOutput> {
  const { query, tenantId, excludedIds } = input;
  const effectiveTenantId = tenantId ?? 'default';

  // 1) Try pgvector (Groq embeddings + pgvector)
  try {
    const { embedding, totalTokens } = await embedTextWithUsage(query);
    const vecResult = await searchPgVector({
      tenantId: effectiveTenantId,
      embedding,
      excludedIds,
    });

    if (vecResult.items.length > 0) {
      const items: Hit[] = vecResult.items.map((hit) => ({
        id: hit.id,
        text: hit.text,
        score: hit.score,
        // pgvector だが、既存の 'pg' ソース種別に合わせておく
        source: 'pg',
        // Phase68: faq_embeddings.metadata を引き継ぐ (source/principle/book_id)
        metadata: hit.metadata,
      }));

      return {
        items,
        ms: vecResult.ms,
        note: vecResult.note ?? 'pgvector',
        embeddingTokens: totalTokens,
      };
    }
  } catch (err) {
    // pgvector 経路での失敗時は、従来の hybridSearch にフォールバック
    // ログは上位層の pino に任せるため、ここでは握りつぶす
  }

  // 2) Fallback: 既存の hybridSearch（ES + PG FTS 等）
  const result = await hybridSearch(query, tenantId, undefined, excludedIds);
  return result;
}