// src/lib/tenantConfigAudit.test.ts
//
// P0-5 (GID 1217808301788163): SCRIPTS/audit-tenant-config.ts が使う判定関数のユニットテスト。

import {
  hasEmptyOrigins,
  isR2cOwnDomainOnly,
  hasInvalidOriginPattern,
  hasEmptySystemPrompt,
  auditTenantConfig,
  hasAnyIssue,
} from "./tenantConfigAudit";

describe("hasEmptyOrigins", () => {
  it("空配列 → 検出される", () => {
    expect(hasEmptyOrigins([])).toBe(true);
  });

  it("値が1つでもあれば検出されない", () => {
    expect(hasEmptyOrigins(["https://shop.example.com"])).toBe(false);
  });
});

describe("isR2cOwnDomainOnly", () => {
  it("R2C自身のドメインのみ → 検出される", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz", "https://api.r2c.biz"])).toBe(true);
  });

  it("R2C自身のドメイン1件だけでも検出される", () => {
    expect(isR2cOwnDomainOnly(["https://r2c.biz"])).toBe(true);
  });

  it("テナントの実ドメインが1つでもある → 検出されない", () => {
    expect(
      isR2cOwnDomainOnly(["https://admin.r2c.biz", "https://shop.example.com"])
    ).toBe(false);
  });

  it("空配列 → 検出されない(原因が異なるため hasEmptyOrigins 側の責務)", () => {
    expect(isR2cOwnDomainOnly([])).toBe(false);
  });
});

describe("hasInvalidOriginPattern", () => {
  it("https://*.com → 検出される(パブリックサフィックスに当たるワイルドカード)", () => {
    expect(hasInvalidOriginPattern(["https://*.com"])).toBe(true);
  });

  it("正常なワイルドカード https://*.example.com → 検出されない", () => {
    expect(hasInvalidOriginPattern(["https://*.example.com"])).toBe(false);
  });

  it("通常のhttps URL → 検出されない", () => {
    expect(hasInvalidOriginPattern(["https://shop.example.com"])).toBe(false);
  });

  it("空配列 → 検出されない", () => {
    expect(hasInvalidOriginPattern([])).toBe(false);
  });
});

describe("hasEmptySystemPrompt", () => {
  it("空文字 → 検出される", () => {
    expect(hasEmptySystemPrompt("")).toBe(true);
  });

  it("null → 検出される", () => {
    expect(hasEmptySystemPrompt(null)).toBe(true);
  });

  it("undefined → 検出される", () => {
    expect(hasEmptySystemPrompt(undefined)).toBe(true);
  });

  it("空白のみ → 検出される", () => {
    expect(hasEmptySystemPrompt("   \n  ")).toBe(true);
  });

  it("値がある → 検出されない", () => {
    expect(hasEmptySystemPrompt("あなたは心理学に詳しい接客担当です。")).toBe(false);
  });
});

describe("auditTenantConfig / hasAnyIssue", () => {
  it("carnation相当(R2C自身のドメインのみ + system_prompt空) → 両方検出される", () => {
    const issues = auditTenantConfig({
      allowedOrigins: ["https://admin.r2c.biz", "https://api.r2c.biz"],
      systemPrompt: "",
    });
    expect(issues).toEqual({
      emptyOrigins: false,
      r2cOwnDomainOnly: true,
      invalidOriginPattern: false,
      emptySystemPrompt: true,
    });
    expect(hasAnyIssue(issues)).toBe(true);
  });

  it("正常なテナント設定 → 何も検出されない", () => {
    const issues = auditTenantConfig({
      allowedOrigins: ["https://shop.example.com"],
      systemPrompt: "あなたは心理学に詳しい接客担当です。",
    });
    expect(hasAnyIssue(issues)).toBe(false);
  });
});
