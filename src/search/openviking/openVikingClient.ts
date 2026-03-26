// src/search/openviking/openVikingClient.ts
// Phase47: OpenViking HTTP API クライアント
// Feature Flag: OPENVIKING_ENABLED=1 かつ OPENVIKING_URL 設定時のみ有効

const OPENVIKING_URL = process.env.OPENVIKING_URL ?? 'http://localhost:18789';
const OPENVIKING_TIMEOUT_MS = Number(process.env.OPENVIKING_TIMEOUT_MS ?? 500);

export type ContextLevel = 'L0' | 'L1' | 'L2';

export interface OVSearchResult {
  path: string;      // viking://book/{principle}/...
  content: string;   // コンテキスト本文
  level: ContextLevel;
  score: number;     // 類似度
}

export interface OVSearchParams {
  query: string;
  namespace: string; // 例: 'book'
  level: ContextLevel;
  topK?: number;
}

/**
 * OpenViking HTTP API 経由で階層コンテキストを検索する。
 * タイムアウト時は空配列を返し、呼び出し元がフォールバックを担う。
 */
export async function ovSearch(params: OVSearchParams): Promise<OVSearchResult[]> {
  const { query, namespace, level, topK = 3 } = params;
  const url = `${OPENVIKING_URL}/v1/search`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENVIKING_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, namespace, level, top_k: topK }),
      signal: controller.signal,
    });

    if (!res.ok) return [];
    const data = (await res.json()) as { results?: OVSearchResult[] };
    return data.results ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * プログレッシブロード: L0 → L1 → L2
 * 必要なレベルのコンテキストを順番に取得し、十分なら上位レベルで停止する。
 */
export async function ovProgressiveLoad(
  query: string,
  namespace: string,
  minLevel: ContextLevel = 'L1',
): Promise<OVSearchResult[]> {
  const levels: ContextLevel[] = ['L0', 'L1', 'L2'];
  const minIndex = levels.indexOf(minLevel);

  let results: OVSearchResult[] = [];

  for (let i = 0; i <= minIndex; i++) {
    const level = levels[i];
    const hits = await ovSearch({ query, namespace, level, topK: 3 });
    if (hits.length > 0) {
      results = hits;
      // L0で候補が見つかり、minLevelがL0なら終了
      if (i >= minIndex) break;
    }
  }

  return results;
}
