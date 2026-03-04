import {
  initDefaultSalesRulesProvider,
  initSalesRulesProviderFromLoader,
  type SalesRulesLoader,
} from "./rulesLoader";
import { getSalesRules } from "./salesRules";

describe("rulesLoader", () => {
  it("initDefaultSalesRulesProvider sets the global provider and returns the default rules", async () => {
    const rulesFromInit = await initDefaultSalesRulesProvider();

    const rulesFromGetter = getSalesRules();
    expect(rulesFromGetter).toBe(rulesFromInit);
  });

  it("initSalesRulesProviderFromLoader uses tenant-specific rules when available and falls back to default", async () => {
    const defaultRules = { name: "default-rules" } as any;
    const tenantRules = { name: "tenant-rules" } as any;

    const loader: SalesRulesLoader = {
      async loadAll() {
        return {
          default: defaultRules,
          "tenant:foo": tenantRules,
        };
      },
    };

    const returnedDefault = await initSalesRulesProviderFromLoader(loader);

    // initSalesRulesProviderFromLoader should return the default rules
    expect(returnedDefault).toBe(defaultRules);

    // getSalesRules without options should give the default rules
    expect(getSalesRules()).toBe(defaultRules);

    // tenantId が一致する場合はテナント専用ルールが返る
    expect(getSalesRules({ tenantId: "tenant:foo" } as any)).toBe(tenantRules);

    // 未知の tenantId の場合は default にフォールバック
    expect(getSalesRules({ tenantId: "unknown-tenant" } as any)).toBe(
      defaultRules
    );
  });
});
