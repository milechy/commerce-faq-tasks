// src/agent/tools/rerankTool.ts

import type { Hit } from '../../search/hybrid';
import { rerank, type Item as RerankItem, type RerankResult } from '../../search/rerank';

export interface RerankToolInput {
  query: string;
  items: Hit[];
  topK: number;
}

export interface RerankToolOutput extends RerankResult {}

export async function rerankTool(
  input: RerankToolInput,
): Promise<RerankToolOutput> {
  const { query, items, topK } = input;

  const ceItems: RerankItem[] = items.map((hit) => ({
    id: hit.id,
    text: hit.text,
    score: hit.score,
    source: hit.source,
  }));

  const result = await rerank(query, ceItems, topK);
  return result;
}