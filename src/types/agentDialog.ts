// frontend/src/types/agentDialog.ts

export type AdapterStatus =
  | "ready"
  | "disabled"
  | "skipped_pii"
  | "failed"
  | "fallback";

export interface AdapterMeta {
  provider: "lemon_slice";
  status: AdapterStatus;
  reason?: string;
  readinessMs?: number;
}

export interface AgentDialogMeta {
  adapter?: AdapterMeta;
  // 他に route / ragStats / salesMeta 等があればここ
}

export interface AgentDialogResponse {
  sessionId?: string;
  answer: string | null;
  steps: unknown[];
  meta: AgentDialogMeta;
}
