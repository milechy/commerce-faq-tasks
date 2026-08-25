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

// ───────────────────────────────────────────────────────────────────────────
// バックエンド(src/lib/tenantConfigAudit.ts)と判定を揃えるための回帰テスト。
// 片方だけ直すと、CLIは警告するのに画面は無言、という食い違いが起きる。
// ───────────────────────────────────────────────────────────────────────────
describe("tenantOriginWarning — 表記揺れ（バックエンド判定と同一基準）", () => {
  it.each([
    ["末尾スラッシュ", "https://admin.r2c.biz/"],
    ["大文字混じり", "HTTPS://ADMIN.R2C.BIZ"],
    ["既定ポート明記", "https://admin.r2c.biz:443"],
    ["前後空白", "  https://admin.r2c.biz  "],
  ])("%s でも R2C 自身のドメインのみとして警告する", (_name, origin) => {
    expect(isR2cOwnDomainOnly([origin])).toBe(true);
    expect(buildOriginWarning([origin])).not.toBeNull();
  });

  it("空白のみの行だけなら「空」として警告する（1件登録済みと数えない）", () => {
    expect(hasEmptyOrigins([""])).toBe(true);
    expect(hasEmptyOrigins(["  ", "\t"])).toBe(true);
    expect(buildOriginWarning([""])).not.toBeNull();
  });

  it("似せた別ホストは警告しない（誤検出でユーザーを止めない）", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz.evil.com"])).toBe(false);
    expect(buildOriginWarning(["https://admin.r2c.biz.evil.com"])).toBeNull();
  });

  it("R2C自身と実ドメインが混在していれば警告しない", () => {
    expect(buildOriginWarning(["https://admin.r2c.biz", "https://shop.example.com"])).toBeNull();
  });

  it("警告文言は専門用語を使わず、何が起きるかを書いている", () => {
    const w = buildOriginWarning(["https://admin.r2c.biz"])!;
    expect(w).toContain("表示されません");
    expect(w).not.toMatch(/CORS|Origin ヘッダ|allowed_origins/);
  });
});
