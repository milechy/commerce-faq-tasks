// src/lib/ttlCache.test.ts
//
// tenantEconomics.ts / hermesConsent.ts が個別実装していたTTLキャッシュを
// 1本化した共通ヘルパー。ここで守りたいのは:
//  1. TTL内はキャッシュを返し、TTLを過ぎたら再取得扱い(undefined)になること
//  2. false/0/"" のような falsy な値でも「未キャッシュ」と混同しないこと
//  3. delete/clear が個別/全体に効くこと
//  4. キーの型が違えば別エントリとして扱われること(取り違えない)
import { createTtlCache } from "./ttlCache";

describe("createTtlCache", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("set した値を TTL 内は get で返す", () => {
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("未設定のキーは undefined", () => {
    const cache = createTtlCache<string, number>(60_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("★TTLを過ぎたら undefined になる(期限切れの値を返さない)★", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-04T00:00:00Z"));
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 1);
    jest.setSystemTime(new Date("2026-09-04T00:01:00.001Z")); // 60秒+1ms 経過
    expect(cache.get("a")).toBeUndefined();
  });

  it("TTLちょうど(境界)ではまだ有効", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-04T00:00:00Z"));
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 1);
    jest.setSystemTime(new Date("2026-09-04T00:00:59.999Z")); // 59.999秒経過
    expect(cache.get("a")).toBe(1);
  });

  it("★falsy な値(false)でも未キャッシュと混同しない★", () => {
    const cache = createTtlCache<string, boolean>(60_000);
    cache.set("a", false);
    expect(cache.get("a")).toBe(false);
    expect(cache.get("a")).not.toBeUndefined();
  });

  it("falsy な値(0)でも未キャッシュと混同しない", () => {
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 0);
    expect(cache.get("a")).toBe(0);
  });

  it("delete は指定キーだけを消す(他のキーに影響しない)", () => {
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("clear は全キーを消す", () => {
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("同じキーへの再setはTTLを延長する(最新のsetが有効)", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-04T00:00:00Z"));
    const cache = createTtlCache<string, number>(60_000);
    cache.set("a", 1);
    jest.setSystemTime(new Date("2026-09-04T00:00:50Z")); // 50秒後、まだ有効
    cache.set("a", 2); // ここで再度TTLが60秒延びる
    jest.setSystemTime(new Date("2026-09-04T00:01:30Z")); // 最初のsetから90秒後だが、再setから40秒後
    expect(cache.get("a")).toBe(2);
  });

  it("キーが違えば独立したエントリとして扱う(取り違えない)", () => {
    const cache = createTtlCache<string, string>(60_000);
    cache.set("tenant-a", "growth");
    cache.set("tenant-b", "starter");
    expect(cache.get("tenant-a")).toBe("growth");
    expect(cache.get("tenant-b")).toBe("starter");
  });
});
