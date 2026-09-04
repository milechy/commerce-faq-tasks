// src/lib/ttlCache.ts
//
// キー付きの薄いインメモリTTLキャッシュ。単一プロセス前提・能動的な追い出しなし
// (期限切れエントリは次に同じキーで読まれるまでメモリに残る)。
//
// tenantEconomics.ts と hermesConsent.ts が同じ形
// (Map<K, {value, expiresAt}> + 読み取り時にTTL切れをチェック)を
// それぞれ個別実装していたため、ここへ集約する(レビュー指摘P3・純粋なリファクタ、
// 挙動は変えない)。
//
// ★planFeatures.ts の tenantPlanCache はここに含めない★
// 複数のテストが `tenantPlanCache.set(id, { plan, expiresAt })` のように
// エントリの内部形をそのまま触っている(src/api/admin/tenants/routes.test.ts 等)。
// ここへ寄せるとエントリ形が `{ value, expiresAt }` に変わり、それらのテストが
// 割れる。実害の無い低優先度リファクタでテスト結合の強い箇所まで広げない。
//
// ★プロセスローカル前提★ 将来スケールアウトする場合、他ワーカーが最大TTL分
// だけ古い値を見る(invalidateTenantPlanCacheのコメントと同じ制約)。

export interface TtlCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
}

export function createTtlCache<K, V>(ttlMs: number): TtlCache<K, V> {
  const store = new Map<K, { value: V; expiresAt: number }>();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}
