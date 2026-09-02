// admin-ui/src/lib/tenantOriginWarning.test.ts
//
// P0-5 (GID 1217808301788163) / A2A-0j: buildOriginWarningLevel のユニットテスト。

import { describe, it, expect } from "vitest";
import {
  hasEmptyOrigins,
  isR2cOwnDomainOnly,
  isR2cOwnDomainMixed,
  buildOriginWarningLevel,
} from "./tenantOriginWarning";
import ja from "../i18n/ja";

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

describe("isR2cOwnDomainMixed", () => {
  it("Accept相当(実ドメインにR2C自身のドメインが混在) → 検出される", () => {
    expect(
      isR2cOwnDomainMixed([
        "https://www.accept-eigyou.com",
        "https://accept-eigyou.com",
        "https://admin.r2c.biz",
        "https://api.r2c.biz",
      ])
    ).toBe(true);
  });

  it("全件がR2C自身のドメインのみ → 検出されない(致命的ケースは isR2cOwnDomainOnly の責務)", () => {
    expect(isR2cOwnDomainMixed(["https://admin.r2c.biz", "https://api.r2c.biz"])).toBe(false);
  });

  it("R2C自身のドメインが1件も無い → 検出されない", () => {
    expect(isR2cOwnDomainMixed(["https://shop.example.com"])).toBe(false);
  });

  it("空配列 → 検出されない", () => {
    expect(isR2cOwnDomainMixed([])).toBe(false);
  });
});

describe("buildOriginWarningLevel", () => {
  it("空配列 → empty", () => {
    expect(buildOriginWarningLevel([])).toBe("empty");
  });

  it("R2C自身のドメインのみ → r2c_own_only(致命的)", () => {
    expect(buildOriginWarningLevel(["https://admin.r2c.biz"])).toBe("r2c_own_only");
  });

  it("実ドメインにR2C自身のドメインが混在 → r2c_own_mixed(軽度)", () => {
    expect(
      buildOriginWarningLevel(["https://admin.r2c.biz", "https://shop.example.com"])
    ).toBe("r2c_own_mixed");
  });

  it("テナントの実ドメインのみ → null", () => {
    expect(buildOriginWarningLevel(["https://shop.example.com"])).toBeNull();
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
    expect(buildOriginWarningLevel([origin])).toBe("r2c_own_only");
  });

  it("空白のみの行だけなら「空」として警告する（1件登録済みと数えない）", () => {
    expect(hasEmptyOrigins([""])).toBe(true);
    expect(hasEmptyOrigins(["  ", "\t"])).toBe(true);
    expect(buildOriginWarningLevel([""])).toBe("empty");
  });

  it("似せた別ホストは警告しない（誤検出でユーザーを止めない）", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz.evil.com"])).toBe(false);
    expect(isR2cOwnDomainMixed(["https://admin.r2c.biz.evil.com"])).toBe(false);
    expect(buildOriginWarningLevel(["https://admin.r2c.biz.evil.com"])).toBeNull();
  });

  it("R2C自身と実ドメインが混在していれば r2c_own_mixed(致命的ではなく軽度)として警告する", () => {
    expect(
      buildOriginWarningLevel(["https://admin.r2c.biz", "https://shop.example.com"])
    ).toBe("r2c_own_mixed");
  });
});

describe("origin_warning i18n文言 — 専門用語を使わず、何が起きるか/なぜ消すべきかを書いている", () => {
  it("r2c_own_only は致命的な結果(表示されない)を書いている", () => {
    const text = ja["tenant_detail.origin_warning_r2c_own_only"];
    expect(text).toContain("表示されません");
    expect(text).not.toMatch(/CORS|Origin ヘッダ|allowed_origins/);
  });

  it("r2c_own_mixed は削除すべき理由(一致する場面が無い)を書いている", () => {
    const text = ja["tenant_detail.origin_warning_r2c_own_mixed"];
    expect(text).toContain("一致する場面は無い");
    expect(text).not.toMatch(/CORS|Origin ヘッダ|allowed_origins/);
  });
});
