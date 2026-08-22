import type { SalesStage } from "../orchestrator/sales/salesStageMachine";
import { buildTenantSessionKey } from "./sessionKey";

export interface SalesSessionMeta {
  currentStage: SalesStage;
  lastIntent?: string;
  personaTags?: string[];
  lastUpdatedAt: string;
}

export interface SalesSessionKey {
  tenantId: string;
  sessionId: string;
}

/**
 * TTL 掃き出し用の最終アクセス時刻を内部だけで持つ。
 * `lastUpdatedAt`(ISO文字列, 業務上の更新時刻) とは別物で、公開型
 * SalesSessionMeta の形は変えない（呼び出し側の toEqual 等を壊さないため）。
 */
interface SalesSessionEntry {
  meta: SalesSessionMeta;
  lastAccessedAt: number;
}

const toInternalKey = (key: SalesSessionKey): string =>
  buildTenantSessionKey(key.tenantId, key.sessionId);

const sessionStore = new Map<string, SalesSessionEntry>();

// contextStore.ts と同じ理由・同じ値。middleware 側の既存スイープとも揃える。
const SESSION_ENTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function getSalesSessionMeta(
  key: SalesSessionKey
): SalesSessionMeta | undefined {
  const entry = sessionStore.get(toInternalKey(key));
  if (!entry) return undefined;
  // 継続中の会話が TTL で消えないよう、読み取りでも最終アクセス時刻を更新する。
  entry.lastAccessedAt = Date.now();
  return entry.meta;
}

export function setSalesSessionMeta(
  key: SalesSessionKey,
  meta: Omit<SalesSessionMeta, "lastUpdatedAt"> & { lastUpdatedAt?: string }
): SalesSessionMeta {
  const now = meta.lastUpdatedAt ?? new Date().toISOString();
  const record: SalesSessionMeta = {
    currentStage: meta.currentStage,
    lastIntent: meta.lastIntent,
    personaTags: meta.personaTags,
    lastUpdatedAt: now,
  };
  sessionStore.set(toInternalKey(key), {
    meta: record,
    lastAccessedAt: Date.now(),
  });
  return record;
}

export function updateSalesSessionMeta(
  key: SalesSessionKey,
  patch: Partial<Omit<SalesSessionMeta, "lastUpdatedAt">>
): SalesSessionMeta {
  const internalKey = toInternalKey(key);
  const existing = sessionStore.get(internalKey)?.meta;

  const currentStage: SalesStage =
    patch.currentStage ?? existing?.currentStage ?? ("clarify" as SalesStage);

  const record: SalesSessionMeta = {
    currentStage,
    lastIntent: patch.lastIntent ?? existing?.lastIntent,
    personaTags: patch.personaTags ?? existing?.personaTags,
    lastUpdatedAt: new Date().toISOString(),
  };

  sessionStore.set(internalKey, { meta: record, lastAccessedAt: Date.now() });
  return record;
}

export function clearSalesSessionMeta(key: SalesSessionKey): void {
  sessionStore.delete(toInternalKey(key));
}

export function clearAllSalesSessionMeta(): void {
  sessionStore.clear();
}

/**
 * TTL を超過したエントリを掃き出す。戻り値は削除件数（監視・テスト用）。
 * 明示的な clear* は本番の呼び出し元が無く、実質この掃き出しが唯一の回収経路。
 */
export function evictExpiredSalesSessionMetas(): number {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of sessionStore.entries()) {
    if (now - entry.lastAccessedAt > SESSION_ENTRY_TTL_MS) {
      sessionStore.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/** 現在保持しているセッション数（メモリ蓄積の観測用）。 */
export function salesSessionMetaCount(): number {
  return sessionStore.size;
}

// .unref() は必須（プロセス終了 / jest をブロックしないため）
setInterval(evictExpiredSalesSessionMetas, SESSION_ENTRY_TTL_MS).unref?.();
