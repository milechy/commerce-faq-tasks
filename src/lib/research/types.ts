// src/lib/research/types.ts
// Phase60-C: 外部リサーチプロバイダー型定義

export interface ResearchResult {
  summary: string;       // リサーチ結果のサマリー（最大500文字）
  citations: string[];   // 参照元URL（最大5件）
  query: string;         // 使用したクエリ
  provider: string;      // 'perplexity'
  cachedAt?: string;     // キャッシュ日時（ISO）
}

export interface ExternalResearchProvider {
  search(query: string, locale: string): Promise<ResearchResult | null>;
  name: string;
  costPerQuery: number; // USD概算
}
