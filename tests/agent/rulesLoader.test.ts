// tests/agent/rulesLoader.test.ts

import {
  DefaultSalesRulesLoader,
  initDefaultSalesRulesProvider,
  initSalesRulesProviderFromLoader,
  type SalesRulesLoader,
  type SalesRulesLoadOptions,
} from "../../src/agent/orchestrator/sales/rulesLoader";
import {
  defaultSalesRules,
  getSalesRules,
  setSalesRulesProvider,
  type SalesRules,
} from "../../src/agent/orchestrator/sales/salesRules";

// NOTE:
// - テストランナーは jest / vitest いずれでも動くよう、describe / it / expect は
//   グローバルに存在する前提で利用しています。

class FakeSalesRulesLoader implements SalesRulesLoader {
  public lastOptions: SalesRulesLoadOptions | undefined;

  constructor(private readonly rules: SalesRules) {}

  async loadAll(
    options?: SalesRulesLoadOptions
  ): Promise<Record<string, SalesRules>> {
    this.lastOptions = options;
    // Phase15 のテスト用簡易実装:
    // - default: デフォルトテナント向け
    // - tenant-001 / another-tenant: 任意のテナント ID に対して同じ rules を返す
    return {
      default: this.rules,
      "tenant-001": this.rules,
      "another-tenant": this.rules,
    };
  }
}

// Provider のグローバル状態がテスト間で汚染されないよう、各テスト後に初期化する
afterEach(() => {
  setSalesRulesProvider(() => defaultSalesRules);
});

describe("DefaultSalesRulesLoader", () => {
  it("returns a map that includes defaultSalesRules", async () => {
    const loader = new DefaultSalesRulesLoader();

    const rulesMap = await loader.loadAll();

    // キー名には依存せず、どこかの値として defaultSalesRules が含まれていることだけを確認する
    expect(Object.values(rulesMap)).toContain(defaultSalesRules);
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

    await initSalesRulesProviderFromLoader(loader);

    const rulesFromProvider = getSalesRules();
    expect(rulesFromProvider).toEqual(customRules);
  });

  it("returns loader's rules regardless of tenantId", async () => {
    const customRules: SalesRules = {
      premiumHints: ["pro"],
      upsellKeywords: ["upgrade"],
      ctaKeywords: ["buy now"],
    };

    const loader = new FakeSalesRulesLoader(customRules);

    // Phase15 の実装では initSalesRulesProviderFromLoader は loader のみを受け取り、
    // 内部で loadAll した結果をテナントごとに切り替える。
    await initSalesRulesProviderFromLoader(loader);

    // tenantId を指定しても、FakeSalesRulesLoader はすべて customRules を返すようにしているので
    // getSalesRules の結果も customRules になることを確認する。
    const rulesFromProvider = getSalesRules({ tenantId: "another-tenant" });
    expect(rulesFromProvider).toEqual(customRules);
  });
});
