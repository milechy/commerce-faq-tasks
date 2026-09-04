// admin-ui/src/pages/admin/billing/upsellSuggestion.schema.ts
//
// GET /v1/admin/my-tenant/upsell-suggestion を実行時に検証する。
// flowTransitions.schema.ts / margin/marginSummary.schema.ts と同じ理由で、
// `as Response` のキャストは tsc をすり抜けて本番でクラッシュを起こしうる。
//
// ★ホワイトリスト方式(margin 側の「欠けていたら throw」とは狙いが違う)★
// このパーサは列挙した既知のキーだけを新しいオブジェクトへコピーする。
// `{...raw}` や `as TenantUpsellSuggestion` は絶対に使わない。
// サーバが誤って cost_total_cents 等を返しても、この関数の戻り値には
// 一切載らない = React props にも DevTools にも現れない。
// これがテナント向け面での「原価が漏れない」最後の砦になる。
import type { TenantUpsellResponse } from "./upsellTypes";

export function parseTenantUpsellResponse(input: unknown): TenantUpsellResponse {
  if (typeof input !== "object" || input === null) {
    throw new Error("upsell-suggestion: レスポンスがオブジェクトではありません");
  }
  const d = input as Record<string, unknown>;

  if (d["available"] === false) {
    // ★列挙した1キーだけを新オブジェクトへ。他のキーが混ざっていても無視する★
    return { available: false };
  }
  if (d["available"] !== true) {
    throw new Error("upsell-suggestion: available が真偽値ではありません");
  }
  if (typeof d["headline"] !== "string") {
    throw new Error("upsell-suggestion: headline が文字列ではありません");
  }
  if (!Array.isArray(d["lines"]) || d["lines"].some((l) => typeof l !== "string")) {
    throw new Error("upsell-suggestion: lines が文字列配列ではありません");
  }

  // ★ここが唯一のコピー箇所★ headline と lines 以外のキーは
  // 何が来ても戻り値に絶対に載らない(スプレッドを使わない)。
  return {
    available: true,
    headline: d["headline"],
    lines: d["lines"] as string[],
  };
}
