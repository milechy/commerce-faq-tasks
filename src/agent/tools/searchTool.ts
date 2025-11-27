// src/agent/tools/searchTool.ts

import { hybridSearch, type Hit } from '../../search/hybrid';
import { searchPgVector } from '../../search/pgvector';
const { embedText } = require("../llm/groqClient") as any;

export interface SearchToolInput {
  query: string;
  tenantId?: string;
}

export interface SearchToolOutput {
  items: Hit[];
  ms: number;
  note?: string;
}

export async function searchTool(
  input: SearchToolInput,
): Promise<SearchToolOutput> {
  const { query, tenantId } = input;
  const effectiveTenantId = tenantId ?? 'default';

  // 1) Try pgvector (Groq embeddings + pgvector)
  try {
    const embedding = await embedText(query, { fast: true });
    const vecResult = await searchPgVector({
      tenantId: effectiveTenantId,
      embedding,
    });

    if (vecResult.items.length > 0) {
      const items: Hit[] = vecResult.items.map((hit: any) => ({
        id: hit.id,
        text: hit.text,
        score: hit.score,
        // pgvector だが、既存の 'pg' ソース種別に合わせておく
        source: 'pg',
      }));

      return {
        items,
        ms: vecResult.ms,
        note: vecResult.note ?? 'pgvector',
      };
    }
  } catch (err) {
    // pgvector 経路での失敗時は、従来の hybridSearch にフォールバック
    // ログは上位層の pino に任せるため、ここでは握りつぶす
  }

  // 2) Fallback: 既存の hybridSearch（ES + PG FTS 等）
  const result = await hybridSearch(query, tenantId);
  return result;
}