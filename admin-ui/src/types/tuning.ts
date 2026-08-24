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
  /** 提案の根拠。出所を示さずに承認させないため(要件 F2)。 */
  evidence?: string | null;
}

export type TuningRuleInput = Omit<TuningRule, "id" | "created_by" | "created_at">;

export interface SourceConversation {
  userMsg: string;
  assistantMsg: string;
}
