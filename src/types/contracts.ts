// src/types/contracts.ts
// types/contracts.ts の内容を src/ 以下に取り込んだもの。
// tsconfig の rootDir: src に合わせるため、ここで再定義する。

import type { GROQ_INSTANT_8B, GROQ_VERSATILE_70B } from '../config/groqModels';

export interface TenantConfig {
  tenantId: string;
  name: string;
  plan: "starter" | "growth" | "enterprise";
  features: { avatar: boolean; voice: boolean; rag: boolean; event_tracking?: boolean };
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
  /** LemonSlice I-4: 会話フロー状態（アバター表情連動用、Phase22 + SalesFlow） */
  flowState?:
    | "clarify"
    | "answer"
    | "confirm"
    | "terminal"
    | "propose"
    | "recommend"
    | "close";
  /** Phase73: recommend ステージ時に設定される商品カード情報 */
  productCard?: {
    product_id: string;
    name: string;
    price: string;
    image_url: string;
    cta_url: string;
  };
}

export interface ChatAction {
  type: "booking" | "link";
  label: string;
  url: string;
}

// Groq モデル ID は src/config/groqModels.ts が単一の正典。型もそこから導出する。
export type GroqModel = typeof GROQ_INSTANT_8B | typeof GROQ_VERSATILE_70B;

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
  /** Phase33: レスポンス言語 */
  lang?: string;
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
