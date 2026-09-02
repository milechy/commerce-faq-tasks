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

// ───────────────────────────────────────────────────────────────────────────
// A2A-0hj テスト強化(2026-09-02): R2C自身のドメイン判定を現実の入力バリエーションで
// 固定する。isR2cOwnHost 相当は非公開関数のため、公開関数(isR2cOwnDomainOnly /
// isR2cOwnDomainMixed / buildOriginWarningLevel)経由で挙動を確定させる。
// 誤検出(似せた別ドメインをR2C自身と誤認)は絶対に避けるべき失敗モードなので、
// そちらを重点的に固定する。検出漏れ(現状の実装で拾えていないケース)は
// あえて「現状の挙動」としてテストで固定し、報告する。
// ───────────────────────────────────────────────────────────────────────────
describe("R2C自身のドメイン判定 — 誤検出を避ける(紛らわしい別ドメイン)", () => {
  it.each([
    ["evil.comにr2c.bizが前置", "https://r2c.biz.evil.com"],
    ["myr2c.biz(接頭辞違い)", "https://myr2c.biz"],
    ["notr2c.biz(接頭辞違い)", "https://notr2c.biz"],
    ["admin.r2c.bizのサブドメイン扱い別ホスト", "https://foo.admin.r2c.biz"],
  ])("%s は R2C自身のドメインとして検出しない(誤検出でユーザーを止めない)", (_name, origin) => {
    expect(isR2cOwnDomainOnly([origin])).toBe(false);
    expect(isR2cOwnDomainMixed([origin, "https://shop.example.com"])).toBe(false);
    expect(buildOriginWarningLevel([origin])).toBeNull();
  });
});

describe("R2C自身のドメイン判定 — 現状の実装が拾えない形(検出漏れ、報告目的で固定)", () => {
  // 実運用では SettingsTab.tsx の handleSave が https:// 始まりでない値を保存前に
  // 拒否するため、この画面経由では発生しない。ただし tenantConfigAudit.ts(バックエンド
  // の監査CLI)は DB の値をそのまま読むため、手動INSERT/UPDATE等で紛れ込んだ
  // スキームなし・http:// の値はこの経路で無警告になる。
  it("スキーム無し(admin.r2c.biz)はR2C自身のドメインとして検出されない", () => {
    expect(isR2cOwnDomainOnly(["admin.r2c.biz"])).toBe(false);
    expect(buildOriginWarningLevel(["admin.r2c.biz"])).toBeNull();
  });

  it("http://(非https)はR2C自身のドメインとして検出されない", () => {
    expect(isR2cOwnDomainOnly(["http://admin.r2c.biz"])).toBe(false);
    expect(buildOriginWarningLevel(["http://admin.r2c.biz"])).toBeNull();
  });

  it("ワイルドカード(https://*.r2c.biz)はR2C自身のドメインとして検出されない", () => {
    // R2C自身の全サブドメインを指すワイルドカードだが、ホスト文字列の完全一致でしか
    // 判定していないため "*.r2c.biz" は R2C_OWN_HOSTS のどれとも一致しない。
    expect(isR2cOwnDomainOnly(["https://*.r2c.biz"])).toBe(false);
    expect(buildOriginWarningLevel(["https://*.r2c.biz"])).toBeNull();
  });

  it("既定でないポート(:8080)はR2C自身のドメインとして検出されない", () => {
    // ブラウザのOriginには本番運用でこのポートは現れないため実害は薄いが、
    // 「既定ポートのみ剥がす」実装上、非既定ポートは別ホスト扱いになる。
    expect(isR2cOwnDomainOnly(["https://admin.r2c.biz:8080"])).toBe(false);
  });
});

describe("R2C自身のドメイン判定 — 重複エントリ", () => {
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

describe("buildOriginWarningLevel — 4状態(empty/r2c_own_only/r2c_own_mixed/null)は排他的", () => {
  it.each<[string, string[], "empty" | "r2c_own_only" | "r2c_own_mixed" | null]>([
    ["空配列", [], "empty"],
    ["空白のみ", ["  "], "empty"],
    ["R2C自身のみ複数", ["https://admin.r2c.biz", "https://api.r2c.biz"], "r2c_own_only"],
    ["R2C自身1件+実ドメイン1件", ["https://admin.r2c.biz", "https://shop.example.com"], "r2c_own_mixed"],
    ["実ドメインのみ", ["https://shop.example.com"], null],
    ["似せた別ドメインのみ", ["https://myr2c.biz"], null],
  ])("%s → 対応する1状態のみが返る(他の3状態にはならない)", (_name, origins, expected) => {
    expect(buildOriginWarningLevel(origins)).toBe(expected);
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
