// src/agent/tools/searchTool.ts

import { hybridSearch, type Hit } from '../../search/hybrid';

export interface SearchToolInput {
  query: string;
}

export interface SearchToolOutput {
  items: Hit[];
  ms: number;
  note?: string;
}

export async function searchTool(
  input: SearchToolInput,
): Promise<SearchToolOutput> {
  const { query } = input;
  const result = await hybridSearch(query);
  return result;
}