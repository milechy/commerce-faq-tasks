// admin-ui/src/pages/admin/analytics/flowTransitions.schema.ts
//
// GET /v1/admin/analytics/flow-transitions のレスポンス契約の唯一の出所。
//
// なぜこのファイルが要るか(P0-1, GID 1217808384631918):
// FlowFunnelSection.tsx が独自に定義した型が実サーバーのレスポンス形と
// 1フィールドも一致しないまま `r.json() as Promise<FlowTransitionsResponse>` で
// キャストしていたため、tsc がすり抜け、本番で `data.total_sessions` が
// undefined になり `TypeError: Cannot read properties of undefined` で
// 管理ダッシュボード全体がクラッシュした(index.html のグローバル error
// ハンドラが #root を "起動エラー" 画面に丸ごと差し替える)。
// 兄弟の FlowAnalyticsPage.tsx は正しいフィールド名(total_transitions等)を
// 読んでいたため気付かれなかった。
//
// 2つの消費者(FlowFunnelSection / FlowAnalyticsPage)が同じ1ファイルから
// 型とパーサを取り、同じフィクスチャで固定すれば次のドリフトは実行時 throw
// か契約テストの失敗で必ず捕まる。

export type FlowTransitionsPeriod = "7d" | "30d" | "90d";

export interface FlowTransitionRow {
  from_state: string | null;
  to_state: string;
  transition_count: number;
}

export interface FlowTransitionsFunnel {
  to_answer_count: number;
  to_confirm_count: number;
  to_terminal_count: number;
  completed_count: number;
  confirm_rate_pct: number;
  completion_rate_pct: number;
}

export interface FlowTransitionsResponse {
  period: FlowTransitionsPeriod;
  tenant_id: string | null;
  total_transitions: number;
  funnel: FlowTransitionsFunnel;
  transitions: FlowTransitionRow[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * サーバーの実レスポンスかどうかを実行時に検証する。
 * 必須フィールドが1つでも欠けていれば throw する(黙って undefined を通さない)。
 * これが無かったために `data.total_sessions.toLocaleString()` が
 * 本番でノーガードのまま実行されていた。
 */
export function parseFlowTransitionsResponse(input: unknown): FlowTransitionsResponse {
  if (typeof input !== "object" || input === null) {
    throw new Error("flow-transitions: レスポンスがオブジェクトではありません");
  }
  const d = input as Record<string, unknown>;

  if (!isFiniteNumber(d["total_transitions"])) {
    throw new Error("flow-transitions: total_transitions が数値ではありません");
  }
  const funnel = d["funnel"];
  if (typeof funnel !== "object" || funnel === null) {
    throw new Error("flow-transitions: funnel が欠落しています");
  }
  const f = funnel as Record<string, unknown>;
  const funnelKeys: (keyof FlowTransitionsFunnel)[] = [
    "to_answer_count",
    "to_confirm_count",
    "to_terminal_count",
    "completed_count",
    "confirm_rate_pct",
    "completion_rate_pct",
  ];
  for (const key of funnelKeys) {
    if (!isFiniteNumber(f[key])) {
      throw new Error(`flow-transitions: funnel.${key} が数値ではありません`);
    }
  }
  if (!Array.isArray(d["transitions"])) {
    throw new Error("flow-transitions: transitions が配列ではありません");
  }

  return {
    period: (d["period"] as FlowTransitionsPeriod) ?? "30d",
    tenant_id: (d["tenant_id"] as string | null) ?? null,
    total_transitions: d["total_transitions"] as number,
    funnel: f as unknown as FlowTransitionsFunnel,
    transitions: d["transitions"] as FlowTransitionRow[],
  };
}
