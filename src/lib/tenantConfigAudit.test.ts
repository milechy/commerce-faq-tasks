// src/lib/tenantConfigAudit.test.ts
//
// P0-5 (GID 1217808301788163): SCRIPTS/audit-tenant-config.ts が使う判定関数のユニットテスト。

import {
  findUnmatchableOrigins,
  hasEmptyOrigins,
  isR2cOwnDomainOnly,
  isR2cOwnDomainMixed,
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
      r2cOwnDomainMixed: false,
      invalidOriginPattern: false,
      unmatchableOrigins: [],
      emptySystemPrompt: true,
    });
    expect(hasAnyIssue(issues)).toBe(true);
  });

  it("Accept相当(実ドメイン+R2C自身のドメインが混在) → r2cOwnDomainMixed のみ検出される", () => {
    const issues = auditTenantConfig({
      allowedOrigins: [
        "https://www.accept-eigyou.com",
        "https://accept-eigyou.com",
        "https://admin.r2c.biz",
        "https://api.r2c.biz",
      ],
      systemPrompt: "接客ルール",
    });
    expect(issues.r2cOwnDomainOnly).toBe(false);
    expect(issues.r2cOwnDomainMixed).toBe(true);
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

// ───────────────────────────────────────────────────────────────────────────
// 壊れやすい点を突くテスト（2026-08-25 テスト強化）
//
// この監査が守りたい失敗モードは「値は入っているのに、実サイトでウィジェットが
// 無言で止まる」こと。originCheck.ts の matchesPattern は完全一致で照合するため、
// 表記揺れの登録は一件も一致しない = 全ページで止まる。ここを重点的に突く。
// ───────────────────────────────────────────────────────────────────────────
describe("isR2cOwnDomainOnly — 表記揺れで検出を取りこぼさない", () => {
  it.each([
    ["末尾スラッシュ", "https://admin.r2c.biz/"],
    ["大文字混じり", "HTTPS://ADMIN.R2C.BIZ"],
    ["既定ポート明記", "https://admin.r2c.biz:443"],
    ["前後空白", "  https://admin.r2c.biz  "],
    ["末尾スラッシュ+大文字", "HTTPS://Admin.R2C.Biz/"],
  ])("%s でも R2C 自身のドメインとして検出する", (_name, origin) => {
    expect(isR2cOwnDomainOnly([origin])).toBe(true);
  });

  it("R2C自身のドメインに似せた別ホストは検出しない（部分一致で誤検出しない）", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz.evil.com"])).toBe(false);
    expect(isR2cOwnDomainOnly(["https://notr2c.biz"])).toBe(false);
  });

  it("R2C自身のドメインとテナントの実ドメインが混在していれば検出しない", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz", "https://shop.example.com"])).toBe(false);
  });

  it("パス付きは R2C 自身のドメインとみなさない（照合には使えない別問題として扱う）", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz/widget"])).toBe(false);
  });
});

describe("hasEmptyOrigins — 実質空を空として扱う", () => {
  it("空白のみの行だけなら空とみなす（1件登録済みと数えるとfail-openに気付けない）", () => {
    expect(hasEmptyOrigins([""])).toBe(true);
    expect(hasEmptyOrigins(["   "])).toBe(true);
    expect(hasEmptyOrigins(["", "  ", "\t"])).toBe(true);
  });

  it("実値が1つでもあれば空ではない", () => {
    expect(hasEmptyOrigins(["", "https://shop.example.com"])).toBe(false);
  });
});

describe("findUnmatchableOrigins — ブラウザOriginと決して一致しない登録", () => {
  // originCheck.ts の matchesPattern は `pattern === origin` の完全一致。
  // ブラウザが送る Origin は 小文字・末尾スラッシュ無し・パス無し・既定ポート省略。
  // ここに挙げた形は「登録されているのに全ページで弾かれる」= 無言の全滅になる。
  it.each([
    ["末尾スラッシュ", "https://shop.example.com/"],
    ["パス付き", "https://shop.example.com/widget"],
    ["大文字混じり", "https://Shop.Example.com"],
    ["前後空白", " https://shop.example.com "],
    ["既定ポート明記", "https://shop.example.com:443"],
    ["空行", ""],
    ["空白のみ", "   "],
  ])("%s は一致し得ない登録として検出する", (_name, origin) => {
    expect(findUnmatchableOrigins([origin])).toEqual([origin]);
  });

  it.each([
    ["通常のhttps", "https://shop.example.com"],
    ["サブドメインワイルドカード", "https://*.example.com"],
    ["既定でないポート", "https://shop.example.com:8443"],
  ])("%s は正常な登録として検出しない", (_name, origin) => {
    expect(findUnmatchableOrigins([origin])).toEqual([]);
  });

  it("複数登録のうち壊れているものだけを返す", () => {
    const list = ["https://ok.example.com", "https://bad.example.com/", "https://also-ok.example.com"];
    expect(findUnmatchableOrigins(list)).toEqual(["https://bad.example.com/"]);
  });

  it("carnation の実測値(R2C自身のドメインのみ)は一致し得ない登録ではない", () => {
    // 形としては正しいので findUnmatchableOrigins では出ない。
    // 「テナントの実サイトが無い」ことは isR2cOwnDomainOnly が担当する。
    const carnation = ["https://admin.r2c.biz", "https://api.r2c.biz"];
    expect(findUnmatchableOrigins(carnation)).toEqual([]);
    expect(isR2cOwnDomainOnly(carnation)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A2A-0hj テスト強化(2026-09-02): admin-ui/src/lib/tenantOriginWarning.test.ts と
// 同じ入力バリエーションで、判定基準が両実装で揃っていることを固定する。
// ───────────────────────────────────────────────────────────────────────────
describe("isR2cOwnDomainOnly / isR2cOwnDomainMixed — 誤検出を避ける(紛らわしい別ドメイン)", () => {
  it.each([
    ["evil.comにr2c.bizが前置", "https://r2c.biz.evil.com"],
    ["myr2c.biz(接頭辞違い)", "https://myr2c.biz"],
    ["admin.r2c.bizのサブドメイン扱い別ホスト", "https://foo.admin.r2c.biz"],
  ])("%s は R2C自身のドメインとして検出しない(誤検出でユーザーを止めない)", (_name, origin) => {
    expect(isR2cOwnDomainOnly([origin])).toBe(false);
    expect(isR2cOwnDomainMixed([origin, "https://shop.example.com"])).toBe(false);
  });
});

describe("isR2cOwnDomainOnly — 現状の実装が拾えない形(検出漏れ、報告目的で固定)", () => {
  // このスクリプト(SCRIPTS/audit-tenant-config.ts)はDBの値をそのまま読むため、
  // admin-ui のhttps://始まりバリデーションを経由しない手動投入データが対象になりうる。
  it("スキーム無し(admin.r2c.biz)はR2C自身のドメインとして検出されない", () => {
    expect(isR2cOwnDomainOnly(["admin.r2c.biz"])).toBe(false);
  });

  it("http://(非https)はR2C自身のドメインとして検出されない", () => {
    expect(isR2cOwnDomainOnly(["http://admin.r2c.biz"])).toBe(false);
  });

  it("ワイルドカード(https://*.r2c.biz)はR2C自身のドメインとして検出されない", () => {
    expect(isR2cOwnDomainOnly(["https://*.r2c.biz"])).toBe(false);
  });
});

describe("isR2cOwnDomainOnly / isR2cOwnDomainMixed — 重複エントリ", () => {
  it("R2C自身のドメインが重複していても、実ドメインが1件でもあればmixedとして検出する", () => {
    expect(
      isR2cOwnDomainMixed([
        "https://admin.r2c.biz",
        "https://admin.r2c.biz",
        "https://api.r2c.biz",
        "https://shop.example.com",
      ])
    ).toBe(true);
  });

  it("R2C自身のドメインの重複のみ(実ドメイン無し)はonlyとして検出する(mixedではない)", () => {
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz", "https://admin.r2c.biz"])).toBe(true);
    expect(isR2cOwnDomainMixed(["https://admin.r2c.biz", "https://admin.r2c.biz"])).toBe(false);
  });
});

describe("auditTenantConfig — 4状態(emptyOrigins/r2cOwnDomainOnly/r2cOwnDomainMixed/問題なし)は排他的", () => {
  it.each<[string, string[], "empty" | "only" | "mixed" | "none"]>([
    ["空配列", [], "empty"],
    ["R2C自身のみ複数", ["https://admin.r2c.biz", "https://api.r2c.biz"], "only"],
    ["R2C自身1件+実ドメイン1件", ["https://admin.r2c.biz", "https://shop.example.com"], "mixed"],
    ["実ドメインのみ", ["https://shop.example.com"], "none"],
  ])("%s → 対応する1状態のみが true になる", (_name, allowedOrigins, expected) => {
    const issues = auditTenantConfig({ allowedOrigins, systemPrompt: "x" });
    expect(issues.emptyOrigins).toBe(expected === "empty");
    expect(issues.r2cOwnDomainOnly).toBe(expected === "only");
    expect(issues.r2cOwnDomainMixed).toBe(expected === "mixed");
  });
});

describe("auditTenantConfig / hasAnyIssue — 一致し得ない登録の配線", () => {
  it("表記揺れの登録が unmatchableOrigins に出て、hasAnyIssue が true になる", () => {
    const issues = auditTenantConfig({
      allowedOrigins: ["https://shop.example.com/"],
      systemPrompt: "接客ルール",
    });
    expect(issues.unmatchableOrigins).toEqual(["https://shop.example.com/"]);
    expect(hasAnyIssue(issues)).toBe(true);
  });

  it("正常なテナントでは unmatchableOrigins が空で hasAnyIssue が false", () => {
    const issues = auditTenantConfig({
      allowedOrigins: ["https://shop.example.com"],
      systemPrompt: "接客ルール",
    });
    expect(issues.unmatchableOrigins).toEqual([]);
    expect(hasAnyIssue(issues)).toBe(false);
  });

  it("空行だけの登録は emptyOrigins と unmatchableOrigins の両方で拾う(fail-openの見逃し防止)", () => {
    const issues = auditTenantConfig({ allowedOrigins: [""], systemPrompt: "x" });
    expect(issues.emptyOrigins).toBe(true);
    expect(issues.unmatchableOrigins).toEqual([""]);
    expect(hasAnyIssue(issues)).toBe(true);
  });
});
