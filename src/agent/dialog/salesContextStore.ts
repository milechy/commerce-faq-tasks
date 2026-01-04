import type { SalesStage } from "../orchestrator/sales/salesStageMachine";

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

const toInternalKey = (key: SalesSessionKey): string =>
  `${key.tenantId}::${key.sessionId}`;

const sessionStore = new Map<string, SalesSessionMeta>();

export function getSalesSessionMeta(
  key: SalesSessionKey
): SalesSessionMeta | undefined {
  return sessionStore.get(toInternalKey(key));
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
  sessionStore.set(toInternalKey(key), record);
  return record;
}

export function updateSalesSessionMeta(
  key: SalesSessionKey,
  patch: Partial<Omit<SalesSessionMeta, "lastUpdatedAt">>
): SalesSessionMeta {
  const internalKey = toInternalKey(key);
  const existing = sessionStore.get(internalKey);

  const currentStage: SalesStage =
    patch.currentStage ?? existing?.currentStage ?? ("clarify" as SalesStage);

  const record: SalesSessionMeta = {
    currentStage,
    lastIntent: patch.lastIntent ?? existing?.lastIntent,
    personaTags: patch.personaTags ?? existing?.personaTags,
    lastUpdatedAt: new Date().toISOString(),
  };

  sessionStore.set(internalKey, record);
  return record;
}

export function clearSalesSessionMeta(key: SalesSessionKey): void {
  sessionStore.delete(toInternalKey(key));
}

export function clearAllSalesSessionMeta(): void {
  sessionStore.clear();
}
