// admin-ui/src/pages/admin/billing/upsellTypes.ts
//
// GET /v1/admin/my-tenant/upsell-suggestion のレスポンス契約。
//
// ★このファイルの型は client_admin に描画される★
// 原価(cost_*)、マージン倍率(margin_multiplier / plan_multiplier)、
// 粗利(gross_profit / gross_margin)を1フィールドも足してはいけない。
// 原価と請求額が同じ画面に並ぶと倍率が逆算される
// (src/lib/billing/costCalculator.ts の H-10 方針)。
//
// ★margin/types.ts とは別ファイル・別型にする(extends しない)★
// margin/ 配下は super_admin 専用ディレクトリとして扱う。共通の親型を作ると、
// 親に足したフィールドが自動でテナント側へ流れ込む経路ができてしまう。
//
// サーバ(src/lib/billing/upsellRenderer.ts の renderUpsellForTenant)が
// 既にテキストへ組み立て済みのものを返す設計にしてある。フロント側で
// 個別の数値フィールド(金額・込み枠等)からレンダリングし直さない。
// 「どのフィールドが原価由来か」をフロントが判断する余地自体を無くすため。

export interface TenantUpsellSuggestion {
  available: true;
  /** サーバが組み立てた見出し。テンプレート文字列のみ(LLMを通していない)。 */
  headline: string;
  /** サーバが組み立てた本文の各行。 */
  lines: string[];
}

/** 訴求すべき状況が無い場合。404/204 ではなくこの形で返す(未取得と対象外を区別する)。 */
export interface TenantUpsellUnavailable {
  available: false;
}

export type TenantUpsellResponse = TenantUpsellSuggestion | TenantUpsellUnavailable;
