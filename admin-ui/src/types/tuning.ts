export interface ApprovedResponse {
  text: string;
  style: string;
  reason?: string;
  approved_at: string;
}

export interface TuningRule {
  id: number;
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority: number;
  is_active: boolean;
  created_by: string;
  created_at: string;
  approved_responses?: ApprovedResponse[];
  /** 'judge' | 'hermes' はAIの提案、'manual' は人が作ったルール。バックエンドは以前から返している。 */
  source?: string | null;
  /** 承認判断の記録。効力の真実は is_active(CLAUDE.md 禁止29)。
   *  'pending' はまだ承認されていない提案で、この画面から直接 is_active を立てさせない。 */
  status?: string | null;
  /** 提案の根拠。出所を示さずに承認させないため(要件 F2)。
   *  manual 由来は文字列、hermes 由来は JSONB オブジェクト(src/api/hermes-mcp/routes.ts が書き込み側の正典)。
   *  未知の形が来ても落ちないよう読む側でフォールバックする。 */
  evidence?: string | TuningEvidence | null;
}

/** Hermes 提案が書き込む evidence の形(src/api/hermes-mcp/routes.ts:210-217)。 */
export interface TuningEvidence {
  pattern?: string;
  rationale?: string;
  session_ids?: string[];
}

export type TuningRuleInput = Omit<TuningRule, "id" | "created_by" | "created_at">;

export interface SourceConversation {
  userMsg: string;
  assistantMsg: string;
}
