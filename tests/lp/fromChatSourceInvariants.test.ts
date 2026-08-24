// tests/lp/fromChatSourceInvariants.test.ts
//
// tests/lp/fromChatUtmForwarding.test.ts は public/lp/from-chat/index.html の
// UTM等クエリ転送ロジックを"同一実装として抽出"してテストする方針（widgetSourceInvariants.test.ts
// と同じ慣習）を取っているため、実ファイル側だけがリファクタで変わり、テスト側の
// コピーが古いまま緑になり続ける"ドリフト"を検知できない弱点がある。
//
// このファイルは実際に配布される public/lp/from-chat/index.html のソーステキストを
// 直接読み込み、抽出ロジックとの契約(=同一の条件式・遷移先)が実ファイル側から
// 乖離していないことを機械的にロックする。

import fs from "fs";
import path from "path";

const LP_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../public/lp/from-chat/index.html"),
  "utf8"
);

describe("public/lp/from-chat/index.html ソース不変条件", () => {
  it("window.location.search を読み取っている", () => {
    expect(LP_SRC).toMatch(/window\.location\.search/);
  });

  it("空のクエリ文字列では早期returnし、href書き換えを行わない", () => {
    expect(LP_SRC).toMatch(/if\s*\(\s*!q\s*\)\s*return;/);
  });

  it("#cta-primary 要素を取得している", () => {
    expect(LP_SRC).toMatch(/getElementById\(\s*['"]cta-primary['"]\s*\)/);
  });

  it("cta要素が存在するときだけ href を書き換えるガードがある", () => {
    expect(LP_SRC).toMatch(/if\s*\(\s*cta\s*\)\s*cta\.href\s*=/);
  });

  it("遷移先は /lp/index.html + クエリ文字列 + #contact の連結である(既存LPの問い合わせフォームへ引き継ぐ)", () => {
    expect(LP_SRC).toMatch(
      /cta\.href\s*=\s*['"]\/lp\/index\.html['"]\s*\+\s*q\s*\+\s*['"]#contact['"]/
    );
  });

  it("#cta-primary のデフォルトhrefは /lp/index.html#contact である(クエリなし時のフォールバック)", () => {
    expect(LP_SRC).toMatch(
      /id="cta-primary"[^>]*href="\/lp\/index\.html#contact"|href="\/lp\/index\.html#contact"[^>]*id="cta-primary"/
    );
  });
});
