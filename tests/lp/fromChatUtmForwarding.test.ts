// tests/lp/fromChatUtmForwarding.test.ts
// public/lp/from-chat/index.html の UTM等クエリ文字列転記ロジックのユニットテスト。
//
// 方針: tests/widget/freeAdBadgeLogic.test.ts と同様、実際のHTML/scriptを評価せず、
// 同一ロジックを抽出して検証する（public/lp/from-chat/index.html の該当箇所と完全同一に保つこと）。
// ロジックの乖離は tests/lp/fromChatSourceInvariants.test.ts が実ファイル側の
// 実装をこの契約から外れていないか正規表現で機械的にチェックする。

// public/lp/from-chat/index.html 171-178行目付近:
// バッジ経由の流入(utm_source等・r2c_ref)を、問い合わせ導線(#contact)まで引き継ぐ。
function buildCtaHref(search: string): string | null {
  if (!search) return null;
  return "/lp/index.html" + search + "#contact";
}

describe("from-chat LP buildCtaHref", () => {
  describe("正常系", () => {
    it("クエリ文字列なし(空文字) → hrefを書き換えない(null)", () => {
      expect(buildCtaHref("")).toBeNull();
    });

    it("単一パラメータ → #contactを維持したままクエリを差し込む", () => {
      expect(buildCtaHref("?utm_source=badge")).toBe(
        "/lp/index.html?utm_source=badge#contact"
      );
    });

    it("複数パラメータ → そのまま連結される", () => {
      expect(buildCtaHref("?utm_source=badge&utm_medium=chat&r2c_ref=t1")).toBe(
        "/lp/index.html?utm_source=badge&utm_medium=chat&r2c_ref=t1#contact"
      );
    });
  });

  describe("境界値・異常系", () => {
    it("'?'のみ(値なしクエリ) → そのまま連結される(falsyではないため)", () => {
      expect(buildCtaHref("?")).toBe("/lp/index.html?#contact");
    });

    it("'#'を含む異常なsearch値(URLエンコード済み等) → そのまま連結される(サニタイズはしない)", () => {
      expect(buildCtaHref("?redirect=%23top")).toBe(
        "/lp/index.html?redirect=%23top#contact"
      );
    });

    it("生の'#'を含む異常なsearch値でも例外を投げず連結する", () => {
      expect(buildCtaHref("?a=1#b")).toBe("/lp/index.html?a=1#b#contact");
    });

    it("日本語等マルチバイト値を含んでいても連結する", () => {
      expect(buildCtaHref("?utm_campaign=%E5%A4%8F%E3%82%BB%E3%83%BC%E3%83%AB")).toBe(
        "/lp/index.html?utm_campaign=%E5%A4%8F%E3%82%BB%E3%83%BC%E3%83%AB#contact"
      );
    });
  });
});
