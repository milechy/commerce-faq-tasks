// src/lib/hermesConsent.test.ts
// Phase75 / S2(共有学習プール参加モデル: 同意の2軸化) hermesConsent テスト

import {
  getCachedShareConsent,
  isHermesDataConsentGranted,
  listHermesConsentingTenantIds,
  resolveLearningConsent,
  shareConsentCache,
} from "./hermesConsent";

jest.mock("./db", () => ({
  getPool: jest.fn(),
}));

import { getPool } from "./db";
const mockGetPool = getPool as jest.Mock;

function mockQuery(impl: jest.Mock) {
  mockGetPool.mockReturnValue({ query: impl });
}

beforeEach(() => {
  mockGetPool.mockReset();
});

describe("resolveLearningConsent", () => {
  it("a) features.learning未設定 + hermes_raw_data_consent=true → {learn:true, share:true}", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { hermes_raw_data_consent: true } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: true });
  });

  it("b) features.learning未設定 + hermes_raw_data_consent=false → {learn:true, share:false}", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { hermes_raw_data_consent: false } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
  });

  it("b') features.learning・hermes_raw_data_consentともに未設定 → {learn:true, share:false}", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { avatar: true } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
  });

  it("c) features自体がnull → {learn:true, share:false}", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: null }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
  });

  it("該当テナントが存在しない場合 → {learn:true, share:false}", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [] }));
    expect(await resolveLearningConsent("nonexistent")).toEqual({ learn: true, share: false });
  });

  it("d) features.learningが文字列(壊れた形) → {learn:true, share:false} かつ warnログ", async () => {
    const { logger } = await import("./logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { learning: "broken" } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("d) features.learningが配列(壊れた形) → {learn:true, share:false} かつ warnログ", async () => {
    const { logger } = await import("./logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { learning: [1, 2] } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("d) features.learningがnull(壊れた形) → {learn:true, share:false} かつ warnログ", async () => {
    const { logger } = await import("./logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { learning: null } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("d) features.learningのlearn/shareが型不正(壊れた形) → {learn:true, share:false} かつ warnログ", async () => {
    const { logger } = await import("./logger");
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { learning: { learn: "yes", share: 1 } } }] }));
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: false });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("e) features.learning={learn:false,share:false} → そのまま返す", async () => {
    mockQuery(
      jest.fn().mockResolvedValue({ rows: [{ features: { learning: { learn: false, share: false } } }] }),
    );
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: false, share: false });
  });

  it("e') features.learning={learn:true,share:true} → そのまま返す(新形式優先、旧フラグは無視)", async () => {
    mockQuery(
      jest.fn().mockResolvedValue({
        rows: [{ features: { learning: { learn: true, share: true }, hermes_raw_data_consent: false } }],
      }),
    );
    expect(await resolveLearningConsent("carnation")).toEqual({ learn: true, share: true });
  });

  it("f) DBクエリがreject → {learn:true, share:false}", async () => {
    mockQuery(jest.fn().mockRejectedValue(new Error("db down")));
    await expect(resolveLearningConsent("carnation")).resolves.toEqual({ learn: true, share: false });
  });
});

describe("isHermesDataConsentGranted (resolveLearningConsent().share を返す)", () => {
  it("features.hermes_raw_data_consent === true のときのみ true", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { hermes_raw_data_consent: true } }] }));
    expect(await isHermesDataConsentGranted("carnation")).toBe(true);
  });

  it("キーが存在しない場合はfalse(fail-safe)", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { avatar: true } }] }));
    expect(await isHermesDataConsentGranted("carnation")).toBe(false);
  });

  it("features自体がnullの場合はfalse", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: null }] }));
    expect(await isHermesDataConsentGranted("carnation")).toBe(false);
  });

  it("該当テナントが存在しない場合はfalse", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [] }));
    expect(await isHermesDataConsentGranted("nonexistent")).toBe(false);
  });

  it("DB障害時はfalse(fail-safe、例外を投げない)", async () => {
    mockQuery(jest.fn().mockRejectedValue(new Error("db down")));
    await expect(isHermesDataConsentGranted("carnation")).resolves.toBe(false);
  });

  it("false明示のテナントはfalse", async () => {
    mockQuery(jest.fn().mockResolvedValue({ rows: [{ features: { hermes_raw_data_consent: false } }] }));
    expect(await isHermesDataConsentGranted("carnation")).toBe(false);
  });

  it("新形式 features.learning.share=true のときはtrue", async () => {
    mockQuery(
      jest.fn().mockResolvedValue({ rows: [{ features: { learning: { learn: true, share: true } } }] }),
    );
    expect(await isHermesDataConsentGranted("carnation")).toBe(true);
  });
});

describe("listHermesConsentingTenantIds", () => {
  it("旧形式(hermes_raw_data_consent=true)のテナントIDを拾う", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "carnation" }] });
    mockQuery(query);
    const ids = await listHermesConsentingTenantIds();
    expect(ids).toEqual(["carnation"]);
  });

  it("g) 新形式(features.learning.share=true)と旧形式(hermes_raw_data_consent=true)の両方を拾うSQLになっている", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "new_format" }, { id: "old_format" }] });
    mockQuery(query);
    const ids = await listHermesConsentingTenantIds();
    expect(ids).toEqual(["new_format", "old_format"]);
    const sql = query.mock.calls[0][0] as string;
    // 新形式(features->'learning'->>'share')・旧形式(features->>'hermes_raw_data_consent')
    // の両方をSQLが参照していること。片方だけだとexport対象が黙って欠ける。
    expect(sql).toContain("learning");
    expect(sql).toContain("hermes_raw_data_consent");
  });

  it("DB障害時は空配列", async () => {
    mockQuery(jest.fn().mockRejectedValue(new Error("db down")));
    expect(await listHermesConsentingTenantIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S6(共有学習プールの参加モデル・fail-open是正): getCachedShareConsent
// ---------------------------------------------------------------------------
//
// /api/chat はメッセージ毎に呼ばれるため、resolveLearningConsent を毎回叩くと
// チャット1往復ごとにDBラウンドトリップが増える。getTenantPlan(planFeatures.ts)
// と同じ60秒TTLキャッシュを適用しているが、この「キャッシュしている」という
// 挙動自体が2つの相反する要求を持つ:
//   - 生きている: 同意フラグを変更してから最大60秒、古い値が使われうる
//     (影響範囲は開示バナーの表示タイミングのみ。実際のexport可否や
//     globalルール読み取り権にはこのキャッシュは使われていないため、
//     「共有される/されない」という実挙動そのものは遅延しない)
//   - 死んでいる: 高頻度呼び出しでDBに負荷をかけない
// この境界(TTL内は再クエリしない・TTL超過後は再クエリする)を固定する。
describe("getCachedShareConsent(S6: /api/chatバックストップ用キャッシュ)", () => {
  const REAL_NOW = Date.now;

  afterEach(() => {
    Date.now = REAL_NOW;
    shareConsentCache.clear();
  });

  it("TTL内(60秒未満)は2回目の呼び出しでDBを再クエリしない", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ features: { learning: { learn: true, share: true } } }] });
    mockQuery(query);

    const first = await getCachedShareConsent("carnation");
    const second = await getCachedShareConsent("carnation");

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("TTL直前(59999ms)まではキャッシュを使い、ちょうど60000msで再クエリする(実装は expiresAt > now の厳密不等号)", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ features: { learning: { learn: true, share: false } } }] })
      .mockResolvedValueOnce({ rows: [{ features: { learning: { learn: true, share: true } } }] });
    mockQuery(query);

    const base = 1_000_000;
    Date.now = () => base;
    const first = await getCachedShareConsent("carnation");

    // TTL直前: まだキャッシュ内(59999 < 60000)。
    Date.now = () => base + 59_999;
    const justBeforeTtl = await getCachedShareConsent("carnation");

    // ちょうど60000ms: expiresAt(=base+60000) > now(=base+60000) は false なので期限切れ扱い。
    // ここが実装のTTLの実際の境界(切り上げではなく、ちょうどで既に失効する)。
    Date.now = () => base + 60_000;
    const atTtl = await getCachedShareConsent("carnation");

    expect(first).toBe(false);
    expect(justBeforeTtl).toBe(false); // キャッシュヒット。まだ古い値のまま
    expect(atTtl).toBe(true); // 再クエリされ、新しい値に切り替わる
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("テナントごとに別々にキャッシュする(他テナントの結果を混同しない)", async () => {
    const query = jest.fn((_sql: string, params: unknown[]) => {
      const tenantId = (params as [string])[0];
      const share = tenantId === "carnation";
      return Promise.resolve({ rows: [{ features: { learning: { learn: true, share } } }] });
    });
    mockQuery(query);

    const carnation = await getCachedShareConsent("carnation");
    const rDefault = await getCachedShareConsent("r2c_default");

    expect(carnation).toBe(true);
    expect(rDefault).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("DB障害時はresolveLearningConsentのfail-safe(false)を返し、キャッシュにも書き込む(次回も同じfalseが返る)", async () => {
    const query = jest.fn().mockRejectedValue(new Error("connection refused"));
    mockQuery(query);

    const first = await getCachedShareConsent("carnation");
    const second = await getCachedShareConsent("carnation");

    expect(first).toBe(false);
    expect(second).toBe(false);
    // fail-safe結果もキャッシュされるため、障害中は毎回DBを叩き直さない
    // (障害時にリトライが集中してDBをさらに痛めることを避ける設計)。
    expect(query).toHaveBeenCalledTimes(1);
  });
});
