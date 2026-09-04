// admin-ui/src/pages/admin/billing/margin/upsellProposals.schema.ts
//
// GET /v1/admin/upsell-proposals のレスポンス契約。★super_admin 専用★
// margin/ 配下(粗利ダッシュボードと同じディレクトリ)に置く。運営向けの
// 粗利付き文面がここに含まれるため、テナント向けの型・画面から import しない。
//
// flowTransitions.schema.ts / marginSummary.schema.ts と同じ理由で、
// `as Response` のキャストは tsc をすり抜けて本番でクラッシュしうる。

export interface UpsellProposalRenderable {
  proposal_id: string;
  tenant_id: string;
  renderable: true;
  headline: string;
  lines: string[];
  created_at: string;
  /** 提案投稿時点(evidence.upsell.period_yyyymm)。evidence が壊れていれば undefined。 */
  period_yyyymm?: string;
  /** true なら period_yyyymm が今月と異なる(長期pendingで数字が古い可能性)。黙って隠さない。 */
  stale?: boolean;
}

/** evidence が壊れている、または figures 計算が失敗した行。文面は出せない。 */
export interface UpsellProposalUnrenderable {
  proposal_id: string;
  tenant_id: string;
  renderable: false;
  created_at: string;
  period_yyyymm?: string;
  stale?: boolean;
}

export type UpsellProposal = UpsellProposalRenderable | UpsellProposalUnrenderable;

export interface UpsellProposalsResponse {
  proposals: UpsellProposal[];
  /** true なら上限件数(MAX_UPSELL_PROPOSALS_PER_REQUEST)で切られている。黙って一部だけ返さない。 */
  truncated: boolean;
}

function isFiniteAndString(v: unknown): v is string {
  return typeof v === "string";
}

function parseOne(input: unknown, i: number): UpsellProposal {
  if (typeof input !== "object" || input === null) {
    throw new Error(`upsell-proposals: proposals[${i}] がオブジェクトではありません`);
  }
  const r = input as Record<string, unknown>;
  if (!isFiniteAndString(r["proposal_id"]) || !r["proposal_id"]) {
    throw new Error(`upsell-proposals: proposals[${i}].proposal_id が不正です`);
  }
  if (!isFiniteAndString(r["tenant_id"]) || !r["tenant_id"]) {
    throw new Error(`upsell-proposals: proposals[${i}].tenant_id が不正です`);
  }
  const createdAt = isFiniteAndString(r["created_at"]) ? r["created_at"] : "";
  // period_yyyymm/stale はどちらもサーバが確信を持てるときだけ有効値を返す。
  // 型が違えば「無い」ものとして扱う(黙って誤った日付を出すより非表示)。
  const periodYyyyMm = isFiniteAndString(r["period_yyyymm"]) ? r["period_yyyymm"] : undefined;
  const stale = typeof r["stale"] === "boolean" ? r["stale"] : undefined;

  if (r["renderable"] === false) {
    return {
      proposal_id: r["proposal_id"], tenant_id: r["tenant_id"],
      renderable: false, created_at: createdAt,
      period_yyyymm: periodYyyyMm, stale,
    };
  }
  if (r["renderable"] !== true) {
    throw new Error(`upsell-proposals: proposals[${i}].renderable が真偽値ではありません`);
  }
  if (!isFiniteAndString(r["headline"])) {
    throw new Error(`upsell-proposals: proposals[${i}].headline が文字列ではありません`);
  }
  if (!Array.isArray(r["lines"]) || r["lines"].some((l) => typeof l !== "string")) {
    throw new Error(`upsell-proposals: proposals[${i}].lines が文字列配列ではありません`);
  }
  return {
    proposal_id: r["proposal_id"], tenant_id: r["tenant_id"],
    renderable: true, headline: r["headline"], lines: r["lines"] as string[],
    created_at: createdAt,
    period_yyyymm: periodYyyyMm, stale,
  };
}

export function parseUpsellProposalsResponse(input: unknown): UpsellProposalsResponse {
  if (typeof input !== "object" || input === null) {
    throw new Error("upsell-proposals: レスポンスがオブジェクトではありません");
  }
  const d = input as Record<string, unknown>;
  if (!Array.isArray(d["proposals"])) {
    throw new Error("upsell-proposals: proposals が配列ではありません");
  }
  return {
    proposals: d["proposals"].map((p, i) => parseOne(p, i)),
    truncated: d["truncated"] === true,
  };
}
