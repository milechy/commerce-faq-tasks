// src/api/contracts/agentDialog.ts （例：追記/調整）

export type AdapterProvider = "lemon_slice";

export type AdapterStatus =
  | "disabled"
  | "skipped_pii"
  | "requested"
  | "ready"
  | "fallback"
  | "failed";

export type AdapterMeta = {
  provider: AdapterProvider;
  status: AdapterStatus;

  /**
   * UI で説明文を出す/ログ相関したい場合の補助情報
   * (optional; PR2b 最小では status だけでも良い)
   */
  reason?: string;
  correlationId?: string;
};

export type AgentDialogResponse = {
  // ...既存フィールド...

  meta?: {
    // ...既存 meta...
    adapter?: AdapterMeta;
  };
};

export type DialogAgentMeta = {
  // ...
  adapter?: AdapterMeta;
};
