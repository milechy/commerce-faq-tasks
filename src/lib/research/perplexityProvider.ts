// src/lib/research/perplexityProvider.ts
// Phase60-C: Perplexity sonar-pro クライアント（24時間TTLキャッシュ付き）

import { logger } from '../logger';
import type { ExternalResearchProvider, ResearchResult } from './types';

// ─── キャッシュ ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

interface CacheEntry {
  result: ResearchResult;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

/** テスト用キャッシュクリア */
export function _clearCacheForTesting(): void {
  _cache.clear();
}

// ─── PerplexityProvider ───────────────────────────────────────────────────────

export class PerplexityProvider implements ExternalResearchProvider {
  readonly name = 'perplexity';
  readonly costPerQuery = 0.005; // $0.005 / query (sonar-pro)

  async search(query: string, locale: string): Promise<ResearchResult | null> {
    const apiKey = process.env['PERPLEXITY_API_KEY']?.trim();
    if (!apiKey) {
      logger.warn('[perplexityProvider] PERPLEXITY_API_KEY is not set');
      return null;
    }
    if (!query.trim()) return null;

    // キャッシュチェック
    const cacheKey = `${locale}:${query}`;
    const cached = _cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            {
              role: 'system',
              content: `You are a research assistant. Provide concise, factual summaries about business trends, consumer psychology, and academic research. Respond in ${locale === 'ja' ? 'Japanese' : 'English'}. Keep responses under 500 characters.`,
            },
            {
              role: 'user',
              content: query,
            },
          ],
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        logger.warn({ status: res.status }, '[perplexityProvider] API error');
        return null;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const choices = data['choices'] as Array<Record<string, unknown>> | undefined;
      const rawSummary: string = (choices?.[0]?.['message'] as Record<string, unknown>)?.['content'] as string ?? '';
      const rawCitations = (data['citations'] as string[] | undefined) ?? [];

      const result: ResearchResult = {
        summary: rawSummary.slice(0, 500),
        citations: rawCitations.slice(0, 5),
        query,
        provider: 'perplexity',
        cachedAt: new Date().toISOString(),
      };

      _cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } catch (err) {
      logger.warn({ err }, '[perplexityProvider] search failed (silent fail)');
      return null;
    }
  }
}
