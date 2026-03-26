// src/search/openviking/openVikingAdapter.ts
// Phase47: principleSearch.ts 互換インタフェース
// 既存の PrincipleChunk 型を返すことで、呼び出し元の変更を最小化する

import { ovProgressiveLoad } from './openVikingClient';
import type { PrincipleChunk } from '../../agent/psychology/principleSearch';

/**
 * OpenViking 経由で心理学原則チャンクを取得する。
 * principleSearch.searchPrincipleChunks() と同一インタフェース。
 *
 * L1（状況・例・禁忌の概要）で80-90%のクエリを完結させ、
 * トークン消費を現行比50%以上削減することを目指す。
 */
export async function searchPrincipleChunksViaOpenViking(
  tenantId: string,
  principles: string[],
): Promise<PrincipleChunk[]> {
  if (!principles || principles.length === 0) return [];

  const results: PrincipleChunk[] = [];

  for (const principle of principles.slice(0, 3)) {
    const hits = await ovProgressiveLoad(
      principle,
      `book_${tenantId}`,
      'L1',  // デフォルトはL1（~1,000-2,000トークン）で完結
    );

    for (const hit of hits.slice(0, 1)) {
      // OpenViking レスポンスを PrincipleChunk 形式にマッピング
      // content は "situation: ...\nexample: ...\ncontraindication: ..." 形式を想定
      const lines = hit.content.split('\n');
      const get = (prefix: string) =>
        (lines.find((l) => l.startsWith(prefix + ':'))?.slice(prefix.length + 1).trim() ?? '')
          .slice(0, 200); // ragExcerpt.slice(0,200) ルール遵守

      results.push({
        principle: principle.slice(0, 200),
        situation: get('situation'),
        example: get('example'),
        contraindication: get('contraindication'),
      });
    }
  }

  return results;
}
