// src/types/contracts.ts
// types/contracts.ts の内容を src/ 以下に取り込んだもの。
// tsconfig の rootDir: src に合わせるため、ここで再定義する。

import type { GPT_OSS_120B } from '../config/groqModels';

export interface TenantConfig {
  tenantId: string;
  name: string;
  plan: "free_ad" | "starter" | "standard" | "growth" | "enterprise";
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
  /** LemonSliceペルソナスワップ: queryPlanner が推定した質問カテゴリ（アバター見た目・人格切替用） */
  ragCategory?: string;
  /** Phase73: recommend ステージ時に設定される商品カード情報 */
  productCard?: {
    product_id: string;
    name: string;
    price: string;
    image_url: string;
    cta_url: string;
  };
  /** 資料オファー機能: 低関心/閲覧中と判定された会話に一度だけ提示する資料カード */
  resourceCard?: {
    title: string;
    url: string;
  };
  /**
   * S6(共有学習プールの参加モデル・fail-open是正): 開示バナーのバックストップ。
   * /api/widget/features の取得が失敗した場合でも、会話が成立する限り
   * 必ず届く /api/chat の応答経由でウィジェットが開示バナーを出せるようにする。
   * assistant ロールのメッセージにのみ載せる(userメッセージには不要)。
   */
  data_shared_externally?: boolean;
  /**
   * 是正4-2(GID 1218086286324510): この回答の chat_messages.id(実DBの主キー)。
   * answer_feedback の message_ref にこの値をそのまま使うことで、👎 が対応する
   * 回答に厳密に紐づく(従来は requestId ベースの近似で、無関係の質問がギャップに
   * 起票されることがあった)。保存に失敗した場合は省略される(追加フィールドのみ、
   * 既存クライアントへの破壊的変更なし)。assistant ロールのみに載る。
   */
  message_id?: string;
}

export interface ChatAction {
  type: "booking" | "link";
  label: string;
  url: string;
}

// Groq モデル ID は src/config/groqModels.ts が単一の正典。型もそこから導出する。
export type GroqModel = typeof GPT_OSS_120B;

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
