// src/agent/dialog/salesContextStore.ts
// Phase14: In-memory store for SalesMeta per dialog session

import type { ExtendedSalesMeta } from '../orchestrator/sales/salesOrchestrator'

/**
 * sessionId ごとの SalesMeta を保持する簡易ストア。
 * - Phase14 ではインメモリのみを想定（プロセス再起動でリセット）
 * - 永続化が必要になった場合は、呼び出し元で適宜拡張する。
 */
const salesMetaStore = new Map<string, ExtendedSalesMeta>()

export function getSalesSessionMeta(
  sessionId: string,
): ExtendedSalesMeta | undefined {
  return salesMetaStore.get(sessionId)
}

export function setSalesSessionMeta(
  sessionId: string,
  meta: ExtendedSalesMeta,
): void {
  salesMetaStore.set(sessionId, meta)
}
