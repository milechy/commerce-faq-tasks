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
}

export type TuningRuleInput = Omit<TuningRule, "id" | "created_by" | "created_at">;

export interface SourceConversation {
  userMsg: string;
  assistantMsg: string;
}
