// tests/agent/salesRulesLoader.test.ts
//
// SalesRulesLoader / initSalesRulesProviderFromLoader のマルチテナント挙動を検証するテスト。

import {
  initSalesRulesProviderFromLoader,
  initDefaultSalesRulesProvider,
  type SalesRulesLoader,
} from "../../src/agent/orchestrator/sales/rulesLoader";
import {
  getSalesRules,
  setSalesRulesProvider,
  defaultSalesRules,
  type SalesRules,
} from "../../src/agent/orchestrator/sales/salesRules";

class FakeMultiTenantLoader implements SalesRulesLoader {
  constructor(private readonly rulesByTenant: Record<string, SalesRules>) {}

  async loadAll(): Promise<Record<string, SalesRules>> {
    return this.rulesByTenant;
  }
}

describe("SalesRulesLoader / initSalesRulesProviderFromLoader", () => {
  beforeEach(() => {
    // 各テスト前に Provider をデフォルト実装に戻しておく
    setSalesRulesProvider(() => defaultSalesRules);
  });

  it("loads multi-tenant rules via loadAll and serves them through getSalesRules", async () => {
    const defaultTenantRules: SalesRules = {
      premiumHints: ["default-premium"],
      upsellKeywords: ["default-upsell"],
      ctaKeywords: ["default-cta"],
    };

    const fooTenantRules: SalesRules = {
      premiumHints: ["foo-premium"],
      upsellKeywords: ["foo-upsell"],
      ctaKeywords: ["foo-cta"],
    };

    const loader = new FakeMultiTenantLoader({
      default: defaultTenantRules,
      foo: fooTenantRules,
    });

    const returned = await initSalesRulesProviderFromLoader(loader);

    // init の戻り値は default tenant のルール
    expect(returned).toEqual(defaultTenantRules);

    // tenantId 未指定の場合は default
    expect(getSalesRules()).toEqual(defaultTenantRules);

    // 既知の tenantId はそのルール
    expect(getSalesRules({ tenantId: "foo" })).toEqual(fooTenantRules);

    // 未知の tenantId は default にフォールバック
    expect(getSalesRules({ tenantId: "unknown" })).toEqual(defaultTenantRules);
  });

  it("falls back to defaultSalesRules when no explicit default is provided", async () => {
    const barTenantRules: SalesRules = {
      premiumHints: ["bar-premium"],
      upsellKeywords: ["bar-upsell"],
      ctaKeywords: ["bar-cta"],
    };

    // default キーなし
    const loader = new FakeMultiTenantLoader({
      bar: barTenantRules,
    });

    const returned = await initSalesRulesProviderFromLoader(loader);

    // default キーが無い場合は defaultSalesRules を返す
    expect(returned).toEqual(defaultSalesRules);

    // 既知 tenant は取得できる
    expect(getSalesRules({ tenantId: "bar" })).toEqual(barTenantRules);

    // 未指定 / 未知 tenant は defaultSalesRules
    expect(getSalesRules()).toEqual(defaultSalesRules);
    expect(getSalesRules({ tenantId: "unknown" })).toEqual(defaultSalesRules);
  });

  it("initDefaultSalesRulesProvider wires DefaultSalesRulesLoader correctly", async () => {
    const rules = await initDefaultSalesRulesProvider();

    // 戻り値は defaultSalesRules
    expect(rules).toEqual(defaultSalesRules);

    // Provider 経由でも defaultSalesRules
    expect(getSalesRules()).toEqual(defaultSalesRules);
    expect(getSalesRules({ tenantId: "any" })).toEqual(defaultSalesRules);
  });
});