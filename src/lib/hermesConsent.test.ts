// src/lib/hermesConsent.test.ts
// Phase75 / S2(共有学習プール参加モデル: 同意の2軸化) hermesConsent テスト

import {
  isHermesDataConsentGranted,
  listHermesConsentingTenantIds,
  resolveLearningConsent,
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
