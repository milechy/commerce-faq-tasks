// src/types/contracts.ts
// types/contracts.ts の内容を src/ 以下に取り込んだもの。
// tsconfig の rootDir: src に合わせるため、ここで再定義する。

export interface TenantConfig {
  tenantId: string;
  name: string;
  plan: "starter" | "growth" | "enterprise";
  features: { avatar: boolean; voice: boolean; rag: boolean };
  security: {
    apiKeyHash: string;
    hashAlgorithm: "sha256";
    allowedOrigins: string[];
    rateLimit: number;
    rateLimitWindowMs: number;
  };
  enabled: boolean;
  sla?: TenantSla;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
  modelUsed?: GroqModel;
  timestamp: number;
  tenantId: string;
}

export interface ChatAction {
  type: "booking" | "link";
  label: string;
  url: string;
}

export type GroqModel =
  | "llama-3.1-8b-instant"
  | "llama-3.3-70b-versatile";

export interface RagContextItem {
  score: number;
  source: string;
}

export interface RAGResult {
  excerpts: string[];
  totalTokens: number;
  searchLatencyMs: number;
  modelRouting: "fast" | "quality";
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  requestId: string;
  tenantId: string;
}

export interface TenantSla {
  /** 最低完了率 (%) — デフォルト 70 */
  completionRateMin: number;
  /** 最大ループ率 (%) — デフォルト 10 */
  loopRateMax: number;
  /** 最大フォールバック率 (%) — デフォルト 30 */
  fallbackRateMax: number;
  /** 検索 p95 上限 (ms) — デフォルト 1500 */
  searchP95Max: number;
  /** 最大エラー率 (%) — デフォルト 1 */
  errorRateMax: number;
}
