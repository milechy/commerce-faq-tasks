// src/search/globalKnowledgeFlag.test.ts
// P1: global / r2c_docs 知識のテナント別オプトイン制御のユニットテスト。
import {
  shouldIncludeGlobalKnowledge,
  shouldIncludeR2cDocs,
} from "./globalKnowledgeFlag";

const ENV_KEYS = [
  "GLOBAL_KNOWLEDGE_ENFORCE_OPTIN",
  "GLOBAL_KNOWLEDGE_TENANTS",
  "R2C_DOCS_ENFORCE_OPTIN",
  "R2C_DOCS_TENANTS",
] as const;

describe("globalKnowledgeFlag", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  describe("既定(env 未設定)は後方互換 = 引く", () => {
    it("global は全テナントで引ける", () => {
      expect(shouldIncludeGlobalKnowledge("anyTenant")).toBe(true);
    });
    it("r2c_docs は全テナントで引ける", () => {
      expect(shouldIncludeR2cDocs("anyTenant")).toBe(true);
    });
  });

  describe("ENFORCE_OPTIN が true 以外なら引く(後方互換)", () => {
    it("空文字/false/1 は enforce 扱いしない", () => {
      for (const v of ["", "false", "1", "yes", "TRUE"]) {
        process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = v;
        expect(shouldIncludeGlobalKnowledge("t1")).toBe(true);
      }
    });
  });

  describe("opt-in 有効時は allowlist で判定", () => {
    it("global: allowlist に載るテナントだけ引ける", () => {
      process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
      process.env.GLOBAL_KNOWLEDGE_TENANTS = "accept, carnation";
      expect(shouldIncludeGlobalKnowledge("accept")).toBe(true);
      expect(shouldIncludeGlobalKnowledge("carnation")).toBe(true);
      expect(shouldIncludeGlobalKnowledge("other")).toBe(false);
    });

    it("global: allowlist 空なら誰も引けない", () => {
      process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
      process.env.GLOBAL_KNOWLEDGE_TENANTS = "";
      expect(shouldIncludeGlobalKnowledge("accept")).toBe(false);
    });

    it("global: '*' なら全テナント引ける", () => {
      process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
      process.env.GLOBAL_KNOWLEDGE_TENANTS = "*";
      expect(shouldIncludeGlobalKnowledge("whoever")).toBe(true);
    });

    it("r2c_docs: 独立に制御される(global が許可でも r2c_docs は拒否できる)", () => {
      process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
      process.env.GLOBAL_KNOWLEDGE_TENANTS = "*";
      process.env.R2C_DOCS_ENFORCE_OPTIN = "true";
      process.env.R2C_DOCS_TENANTS = ""; // 誰にも引かせない
      expect(shouldIncludeGlobalKnowledge("t1")).toBe(true);
      expect(shouldIncludeR2cDocs("t1")).toBe(false);
    });

    it("r2c_docs: allowlist に載るテナントだけ引ける", () => {
      process.env.R2C_DOCS_ENFORCE_OPTIN = "true";
      process.env.R2C_DOCS_TENANTS = "internalTenant";
      expect(shouldIncludeR2cDocs("internalTenant")).toBe(true);
      expect(shouldIncludeR2cDocs("publicTenant")).toBe(false);
    });

    it("global enforce のみ有効なら r2c_docs は既定(引く)のまま", () => {
      process.env.GLOBAL_KNOWLEDGE_ENFORCE_OPTIN = "true";
      process.env.GLOBAL_KNOWLEDGE_TENANTS = "accept";
      expect(shouldIncludeGlobalKnowledge("other")).toBe(false);
      expect(shouldIncludeR2cDocs("other")).toBe(true); // r2c_docs は未 enforce
    });
  });
});
