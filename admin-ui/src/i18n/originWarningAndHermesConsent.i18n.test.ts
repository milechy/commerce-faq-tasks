// admin-ui/src/i18n/originWarningAndHermesConsent.i18n.test.ts
//
// A2A-0hj テスト強化(2026-09-02): hermes_consent.* と tenant_detail.origin_warning_*
// のキーが ja.ts / en.ts の両方に揃っていることを機械的に検証する。
//
// ja.ts の `const ja = {...} as const` / en.ts の `const en: Record<TranslationKey, string> = {...}`
// という型定義自体が「en が ja の全キーを持つこと」を pnpm typecheck の時点で強制しては
// いるが、この型はファイル全体のキー集合に対する保証であり、「hermes_consent.* /
// tenant_detail.origin_warning_* という特定の機能範囲のキーが両方に存在する」ことを
// 名指しで固定するテストはこれまで無かった。片方だけキーを追加してtypecheckを
// すり抜けるケースは無いはずだが、型定義自体が将来変わった場合の回帰検知として
// ここに実行時の検証を残す。
//
// 既存の同種の仕組み(admin-ui側の i18n キー網羅テスト)は見当たらなかったため、
// この範囲(2機能ぶん)に限定して新規に追加する。

import { describe, it, expect } from "vitest";
import ja from "./ja";
import en from "./en";

const TARGET_PREFIXES = ["hermes_consent.", "tenant_detail.origin_warning_"] as const;

function keysWithPrefix(dict: Record<string, string>, prefix: string): string[] {
  return Object.keys(dict)
    .filter((k) => k.startsWith(prefix))
    .sort();
}

// 日本語(ひらがな・カタカナ・CJK統合漢字・CJK記号/句読点)の混入検出。
// 絵文字(⏸️✅❌🔒⚠️🧠等)は対象外 — 意図的にja/en共通で使っているため誤検出しない。
const JAPANESE_CHAR_PATTERN = /[　-ヿ㐀-鿿豈-﫿]/;

describe("i18n キー網羅性 — hermes_consent.* / tenant_detail.origin_warning_*", () => {
  for (const prefix of TARGET_PREFIXES) {
    it(`"${prefix}" で始まるキーが1つ以上存在する(対象範囲の取り違え防止)`, () => {
      expect(keysWithPrefix(ja as Record<string, string>, prefix).length).toBeGreaterThan(0);
    });

    it(`"${prefix}" で始まるキーが ja と en の両方に同じ集合で存在する(片方だけの追加漏れを検出)`, () => {
      const jaKeys = keysWithPrefix(ja as Record<string, string>, prefix);
      const enKeys = keysWithPrefix(en as Record<string, string>, prefix);
      expect(enKeys).toEqual(jaKeys);
    });
  }

  it("en辞書の対象キーに日本語が混入していない(コピペ放置の検出)", () => {
    const offenders: string[] = [];
    for (const prefix of TARGET_PREFIXES) {
      for (const key of keysWithPrefix(en as Record<string, string>, prefix)) {
        const text = (en as Record<string, string>)[key];
        if (JAPANESE_CHAR_PATTERN.test(text)) {
          offenders.push(`${key}: ${text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ja辞書の対象キーの文言は空でない(キーだけ追加して文言を空にする事故の防止)", () => {
    for (const prefix of TARGET_PREFIXES) {
      for (const key of keysWithPrefix(ja as Record<string, string>, prefix)) {
        expect((ja as Record<string, string>)[key].trim().length, `ja["${key}"] が空`).toBeGreaterThan(0);
      }
    }
  });

  it("en辞書の対象キーの文言は空でない(キーだけ追加して文言を空にする事故の防止)", () => {
    for (const prefix of TARGET_PREFIXES) {
      for (const key of keysWithPrefix(en as Record<string, string>, prefix)) {
        expect((en as Record<string, string>)[key].trim().length, `en["${key}"] が空`).toBeGreaterThan(0);
      }
    }
  });
});
