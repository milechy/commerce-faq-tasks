// admin-ui/src/lib/tenantOriginWarning.test.ts
//
// P0-5 (GID 1217808301788163): buildOriginWarning のユニットテスト。

import { describe, it, expect } from "vitest";
import { hasEmptyOrigins, isR2cOwnDomainOnly, buildOriginWarning } from "./tenantOriginWarning";

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

  it("テナントの実ドメインが1つでもある → 検出されない", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz", "https://shop.example.com"])).toBe(false);
  });

  it("空配列 → 検出されない", () => {
    expect(isR2cOwnDomainOnly([])).toBe(false);
  });
});

describe("buildOriginWarning", () => {
  it("空配列 → 警告文言を返す", () => {
    expect(buildOriginWarning([])).toMatch(/許可ドメインが空です/);
  });

  it("R2C自身のドメインのみ → 警告文言を返す", () => {
    expect(buildOriginWarning(["https://admin.r2c.biz"])).toMatch(/管理画面のURLしか入っていません/);
  });

  it("テナントの実ドメインが入っていれば null", () => {
    expect(buildOriginWarning(["https://shop.example.com"])).toBeNull();
  });
});
