// src/api/admin/analytics/componentSelfcheck.test.ts

import { getComponentSelfcheckResults } from "./componentSelfcheck";

describe("getComponentSelfcheckResults", () => {
  it("hermes-dojo と hermes-vault を両方とも not_installed として返す(配線が無いため)", () => {
    const results = getComponentSelfcheckResults();
    expect(results).toEqual([
      { id: "hermes-dojo", status: "not_installed" },
      { id: "hermes-vault", status: "not_installed" },
    ]);
  });

  it("呼び出すたびに同じ形状を返す(副作用の無い純関数)", () => {
    expect(getComponentSelfcheckResults()).toEqual(getComponentSelfcheckResults());
  });
});
