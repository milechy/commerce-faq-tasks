// src/lib/knowledge/faqCategories.ts
//
// FAQカテゴリ語彙の単一情報源。以前は下記3箇所で語彙が個別に維持され、実際に3重化していた:
//   - src/lib/knowledge/faqImport.ts のAIへのカテゴリ判定プロンプト(9種)
//   - src/api/admin/agent/toolDefinitions.ts の add_faq の category enum(旧: 4種のみ)
//   - admin-ui側の表示ラベル(admin-ui/src/i18n/ja.ts の category.*、
//     admin-ui/src/components/knowledge/TextInputTab.tsx・UrlScrapeTab.tsx の CATEGORIES)
// このファイルが src/lib/knowledge/ と src/api/admin/agent/ 側の正であり、
// faqImport.ts / toolDefinitions.ts はここを参照する。admin-ui は別パッケージのため
// import できず、上記3ファイルへの手動複製が残る(既知の非対称。増やさない)。

export interface FaqCategory {
  id: string;
  /** admin-ui の選択肢・表示用の短い日本語ラベル */
  label: string;
  /** AIへのカテゴリ自動判定プロンプトに使う判定基準文 */
  criteria: string;
}

export const FAQ_CATEGORIES: readonly FaqCategory[] = [
  { id: "product_info", label: "商品・サービス情報", criteria: "商品・サービスの詳細情報" },
  { id: "pricing", label: "料金・価格", criteria: "料金・価格・支払い方法" },
  { id: "store_info", label: "店舗情報・アクセス", criteria: "店舗・アクセス・営業時間" },
  { id: "campaign", label: "キャンペーン・セール", criteria: "キャンペーン・セール・割引" },
  { id: "inventory", label: "在庫・車両情報", criteria: "在庫・車両情報" },
  { id: "coupon", label: "クーポン・割引", criteria: "クーポン・割引コード" },
  { id: "booking", label: "予約・申し込み", criteria: "予約・申し込み方法" },
  { id: "warranty", label: "保証・アフターサービス", criteria: "保証・アフターサービス" },
  { id: "general", label: "よくある質問・一般", criteria: "よくある質問・一般" },
];

/** id だけを取り出した読み取り専用配列。toolDefinitions.ts の enum・検証に使う。 */
export const FAQ_CATEGORY_IDS: readonly string[] = FAQ_CATEGORIES.map((c) => c.id);

/**
 * faqImport.ts のプロンプトに差し込む「カテゴリの判定基準」箇条書きを組み立てる。
 * 出力は `* {判定基準文} → "{id}"` を改行で連結した文字列(末尾に改行は付けない)。
 */
export function buildFaqCategoryPromptSection(): string {
  return FAQ_CATEGORIES.map((c) => `* ${c.criteria} → "${c.id}"`).join("\n");
}
