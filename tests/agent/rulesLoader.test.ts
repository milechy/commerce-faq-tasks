// tests/agent/rulesLoader.test.ts

import {
  DefaultSalesRulesLoader,
  initDefaultSalesRulesProvider,
  initSalesRulesProviderFromLoader,
  type SalesRulesLoader,
  type SalesRulesLoadOptions,
} from "../../src/agent/orchestrator/sales/rulesLoader";
import {
  getSalesRules,
  setSalesRulesProvider,
  defaultSalesRules,
  type SalesRules,
} from "../../src/agent/orchestrator/sales/salesRules";

// NOTE:
// - テストランナーは jest / vitest いずれでも動くよう、describe / it / expect は
//   グローバルに存在する前提で利用しています。

class FakeSalesRulesLoader implements SalesRulesLoader {
  public lastOptions: SalesRulesLoadOptions | undefined;

  constructor(private readonly rules: SalesRules) {}

  async load(options?: SalesRulesLoadOptions): Promise<SalesRules> {
    this.lastOptions = options;
    return this.rules;
  }
}

// Provider のグローバル状態がテスト間で汚染されないよう、各テスト後に初期化する
afterEach(() => {
  setSalesRulesProvider(() => defaultSalesRules);
});

describe("DefaultSalesRulesLoader", () => {
  it("returns defaultSalesRules", async () => {
    const loader = new DefaultSalesRulesLoader();

    const rules = await loader.load();

    expect(rules).toEqual(defaultSalesRules);
  });
});

describe("initDefaultSalesRulesProvider", () => {
  it("initializes provider so that getSalesRules returns defaultSalesRules", async () => {
    await initDefaultSalesRulesProvider();

    const rulesFromProvider = getSalesRules();

    expect(rulesFromProvider).toEqual(defaultSalesRules);
  });
});

describe("initSalesRulesProviderFromLoader", () => {
  it("uses loader's rules and wires them into getSalesRules", async () => {
    const customRules: SalesRules = {
      premiumHints: ["enterprise", "large plan"],
      upsellKeywords: ["bigger", "scale"],
      ctaKeywords: ["signup", "contact sales"],
    };

    const loader = new FakeSalesRulesLoader(customRules);

    const loadedRules = await initSalesRulesProviderFromLoader(loader);

    expect(loadedRules).toEqual(customRules);

    const rulesFromProvider = getSalesRules();
    expect(rulesFromProvider).toEqual(customRules);
  });

  it("passes options (e.g. tenantId) through to the loader", async () => {
    const customRules: SalesRules = {
      premiumHints: ["pro"],
      upsellKeywords: ["upgrade"],
      ctaKeywords: ["buy now"],
    };

    const loader = new FakeSalesRulesLoader(customRules);

    await initSalesRulesProviderFromLoader(loader, { tenantId: "tenant-001" });

    expect(loader.lastOptions).toEqual({ tenantId: "tenant-001" });

    // provider 側では options は使わず、事前にロード済みの rules を返すことを確認
    const rulesFromProvider = getSalesRules({ tenantId: "another-tenant" });
    expect(rulesFromProvider).toEqual(customRules);
  });
});
