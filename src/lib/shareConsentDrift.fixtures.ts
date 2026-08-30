// src/lib/shareConsentDrift.fixtures.ts
//
// shareConsentDrift.test.ts の「share=ON か」判定ケース表を、実 Postgres に対する
// 挙動検証(src/api/hermes-mcp/hermesConsentSqlIntegration.test.ts)からも再利用
// できるよう切り出したもの。
//
// 元々 shareConsentDrift.test.ts はこのケース表を JS(resolveLearningConsentFromFeatures)
// と SQL 文字列の正規表現照合の両方に使っていたが、後者は「本番 Postgres で
// 2026-08-25 に手動実測した結果を expected として書き写しただけ」で、CI 上で
// 実際に Postgres に対して実行して確認したことは一度も無かった(同ファイルの
// コメント参照)。ケース表を二重管理せず両方の検証で同じ表を使うため、ここに
// 独立させる(このファイル自体は it/describe を持たないため jest の
// testMatch には引っかからない)。
export interface ShareConsentCase {
  label: string;
  features: unknown;
  expectedShare: boolean;
  note: string;
}

export const CASES: ShareConsentCase[] = [
  {
    label: "A",
    features: { learning: { learn: true, share: true } },
    expectedShare: true,
    note: "正常: 新形式で share=true",
  },
  {
    label: "B",
    features: { learning: { learn: true, share: false } },
    expectedShare: false,
    note: "正常: 新形式で share=false",
  },
  {
    label: "C",
    features: { hermes_raw_data_consent: true },
    expectedShare: true,
    note: "後方互換: learning 未設定 + 旧フラグ true",
  },
  {
    label: "D",
    features: { hermes_raw_data_consent: false },
    expectedShare: false,
    note: "後方互換: learning 未設定 + 旧フラグ false",
  },
  {
    label: "E",
    features: { learning: { learn: true, share: "true" } },
    expectedShare: false,
    note: 'share が boolean ではなく文字列 "true"。緩い ->> 比較だと true に化けた実績あり',
  },
  {
    label: "F",
    features: { learning: { share: true } },
    expectedShare: false,
    note: "learn 欠落で形が不正。緩い比較だと true に化けた実績あり",
  },
  {
    label: "G",
    features: { learning: null, hermes_raw_data_consent: true },
    expectedShare: false,
    note: "learning が JSON null。旧フラグへはフォールバックしない(SQL の IS NULL も false)",
  },
  {
    label: "H",
    features: { learning: {} },
    expectedShare: false,
    note: "learning が空オブジェクト",
  },
  {
    label: "I",
    features: { learning: "x" },
    expectedShare: false,
    note: "learning が文字列",
  },
  {
    label: "J",
    features: { learning: [1, 2] },
    expectedShare: false,
    note: "learning が配列",
  },
  {
    label: "K",
    features: {},
    expectedShare: false,
    note: "features が空(新規テナント相当)",
  },
];
