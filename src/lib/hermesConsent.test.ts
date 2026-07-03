// src/lib/hermesConsent.test.ts
// Phase75: hermesConsent テスト

import { isHermesDataConsentGranted, listHermesConsentingTenantIds } from "./hermesConsent";

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

describe("isHermesDataConsentGranted", () => {
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
});

describe("listHermesConsentingTenantIds", () => {
  it("同意済みテナントのIDのみ返す", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "carnation" }, { id: "other" }] });
    mockQuery(query);
    const ids = await listHermesConsentingTenantIds();
    expect(ids).toEqual(["carnation", "other"]);
    expect(query.mock.calls[0][0]).toContain("hermes_raw_data_consent");
  });

  it("DB障害時は空配列", async () => {
    mockQuery(jest.fn().mockRejectedValue(new Error("db down")));
    expect(await listHermesConsentingTenantIds()).toEqual([]);
  });
});
