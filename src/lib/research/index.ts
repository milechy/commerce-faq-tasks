// src/lib/research/index.ts
// Phase60-C: 外部リサーチプロバイダー公開エントリーポイント

export { PerplexityProvider } from './perplexityProvider';
export type { ExternalResearchProvider, ResearchResult } from './types';

import { PerplexityProvider } from './perplexityProvider';
import type { ExternalResearchProvider } from './types';

/** 環境変数に基づいてリサーチプロバイダーを返す。未設定時は null。 */
export function getResearchProvider(): ExternalResearchProvider | null {
  if (!process.env['PERPLEXITY_API_KEY']) return null;
  return new PerplexityProvider();
}
