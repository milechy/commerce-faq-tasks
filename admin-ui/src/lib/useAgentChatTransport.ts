// admin-ui/src/lib/useAgentChatTransport.ts
// POST /v1/admin/agent/chat の transport 層(sessionId / 直近履歴ウィンドウ /
// targetTenantId 導出 / エラー文言)を、チャットUI 2面で共有するフック。
//
// なぜ共有するのか: パネル(components/AdminAgent/)と全画面(pages/copilot-preview/)は
// 同じエンドポイントを叩きながら、この4点をそれぞれ独立に手書きしていた。同じ構造の重複が
// 既に一度ユーザー影響のあるバグ(IME確定Enterの誤送信が片面だけ約13日間壊れていた)を
// 産んでおり、transport 層も同じ再発条件を持っていた(docs/CHAT_SURFACE_DECISION.md §2.1 #1〜#4,#9)。
//
// この層が持たないもの: メッセージ列そのもの(型が面ごとに違う)、演出、カード描画、
// 永続化(lib/chatSessionStore.ts)。会話履歴の保持は面側に残し、送信時のウィンドウ整形だけを
// ここで一本化する。

import { useCallback, useRef, useState } from "react";
import { authFetch, API_BASE } from "./api";
import { useAuth } from "../auth/useAuth";
import type { ChatHistoryEntry } from "./chatSessionStore";

// どちらの面から来たリクエストかの識別子。リクエストボディに載せて送り、サーバ側が
// 挙動メトリクスの surface ラベルとして記録する(docs/AGENT_METRICS.md)。
// この値だけが「全画面UIが実際に主たる面になりつつあるのか」を面ごとに数える手段になる。
export type AgentChatSurface = "panel" | "fullscreen";

export type AnsweredFrom = "faq_list" | "tool_action" | "general";

// バックエンド(actionExecutor.ts の各 *CardPayload)が自然文に添えて返す構造化カード。
// card を返すのは get_legacy_ui_link / get_tuning_rules / get_weekly_briefing /
// get_chat_sessions / get_chat_session_messages / get_conversation_evaluation /
// get_knowledge_gaps / get_tuning_rule_effect のみで、他のツールは従来どおり
// result の自然文のみ。フィールド形はサーバ側の型と1:1で対応させる
// (型定義箇所はサーバ/ここの2箇所に限る)。
export type ConversationEvaluationAgentActionCard = {
  kind: "conversation_evaluation";
  shortId: string;
  overallScore: number;
  axes: Array<{ label: string; score: number | null }>;
  notes: string | null;
};

export type LegacyLinkAgentActionCard = {
  kind: "legacy_link";
  label: string;
  url: string;
  description: string;
};

export type ChatSessionListAgentActionCard = {
  kind: "chat_session_list";
  total: number;
  sessions: Array<{
    shortId: string;
    startedAt: string;
    messageCount: number;
    preview: string;
    outcome: string | null;
  }>;
};

export type ChatSessionMessagesAgentActionCard = {
  kind: "chat_session_messages";
  shortId: string;
  totalMessages: number;
  messages: Array<{ role: string; roleLabel: string; content: string }>;
};

// P5-1: 知識ギャップ一覧(get_knowledge_gaps)。各行から「このギャップから
// ルールを作る」チップに繋げる。
export type KnowledgeGapsListAgentActionCard = {
  kind: "knowledge_gaps_list";
  gaps: Array<{ id: number; userQuestion: string; ragHitCount: number }>;
  totalCount: number;
};

// GID 1217972976609524 (H-5): suggest_faq_import_from_text / suggest_faq_import_from_urls
// が返す、DB未登録のFAQ案一覧カード。フィールド形状はactionExecutor.tsの
// FaqImportPreviewCardPayloadと1対1に保つ。
export type FaqImportPreviewAgentActionCard = {
  kind: "faq_import_preview";
  source: "text" | "urls";
  total: number;
  truncated: boolean;
  faqs: Array<{
    question: string;
    answer: string;
    category: string | null;
    duplicate: boolean;
    sourceUrl: string | null;
  }>;
  errorUrls: Array<{ url: string; error: string }>;
};

export type AvatarPresetAgentActionCard = {
  kind: "avatar_preset";
  presetId: string;
  name: string;
  imageUrl: string | null;
  description: string;
};

// adopt_avatar_preset / create_avatar_config の採用・作成直後カード。configId は
// 自テナント側の avatar_configs.id。avatarType以下はcreate_avatar_config由来のときのみ
// 埋まる(W3-4)。フィールド形状はactionExecutor.tsのAvatarAdoptedCardPayloadと1対1に保つ。
export type AvatarAdoptedAgentActionCard = {
  kind: "avatar_adopted";
  configId: string;
  name: string;
  imageUrl: string | null;
  description: string;
  avatarType?: "human" | "anime" | "3d" | "animal" | "robot";
  gender?: "male" | "female";
  age?: "20s" | "30s" | "40s" | "50s+";
  outfit?: "business_suit" | "casual" | "white_coat" | "uniform";
  animalKind?: "dog" | "cat" | "bird" | "bear" | "fox" | "other";
  animalVibe?: "cute" | "cool" | "silly";
  robotDesign?: "simple" | "mecha" | "scifi" | "cute";
};

export type TuningRuleEvidence = {
  evaluationIds?: number[];
  effectivePrinciples?: string[];
  failedPrinciples?: string[];
  avgScore?: number;
};

export type TuningRulesListAgentActionCard = {
  kind: "tuning_rules_list";
  rules: Array<{
    id: number;
    triggerPattern: string;
    expectedBehavior: string;
    priority: number;
    isActive: boolean;
    // P4-1: 古い(このフィールドが無い)キャッシュ済み会話との後方互換のため任意。
    source?: string | null;
    status?: string | null;
    evidence?: TuningRuleEvidence | null;
  }>;
  totalCount: number;
};

// suggest_tuning_rule の下書き提案(D6)。truncateされない生の提案値を運び、
// save_tuning_rule に渡される内容とカードの表示内容を一致させる。
export type TuningRuleDraftAgentActionCard = {
  kind: "tuning_rule_draft";
  triggerPattern: string;
  expectedBehavior: string;
  priority: number;
};

// フィールド形状は src/api/admin/agent/actionExecutor.ts の WeeklySummaryCardPayload と
// 1対1に保つ(サーバ/フロントの境界を跨ぐため型は共有できず、手動同期が必要)。
// pages/copilot-preview/index.tsx の Card union はこの型を Omit<..., "kind"> で再利用して
// いるため、ここを直せば同ファイル内の二重定義は発生しない。
export type WeeklySummaryAgentActionCard = {
  kind: "weekly_summary";
  asOf: string;
  sessions: { total: number; changePct: number | null; prevTotal: number } | null;
  avgScore: number | null;
  conversions: { count: number; total: number } | null;
  faq: { total: number; published: number; lastUpdated: string | null } | null;
  pendingTuningRules: number | null;
  gaps: { total: number; top: Array<{ id: number; question: string }> } | null;
  /** 今週AIが覚えたこと。0 は「動きが無かった」なので取得失敗(null)と区別する。 */
  learned: { faqAdded: number; memorized: number } | null;
};

// GID 1217752900578379 (R4): ルール効果(DiD推定)カード。フィールド形状は
// src/api/admin/agent/actionExecutor.ts の RuleEffectCardPayload と1対1に保つ。
// comparison/progress は互いに排他(母数充足時はcomparisonのみ非null)。
export type RuleEffectAgentActionCard = {
  kind: "rule_effect";
  ruleId: number;
  approvedAt: string;
  truncated: boolean;
  analyzedSessions: number;
  comparison: {
    didEstimate: number;
    ci95Low: number;
    ci95High: number;
    naiveTreatmentDelta: number;
  } | null;
  progress: Array<{
    group: string;
    groupLabel: string;
    currentN: number;
    requiredN: number;
    etaDays: number | null;
  }> | null;
};

// W2-4: 会話数の日次推移+低評価セッション。フィールド形状は
// src/api/admin/agent/actionExecutor.ts の AnalyticsTrendCardPayload と1対1に保つ。
export type AnalyticsTrendAgentActionCard = {
  kind: "analytics_trend";
  period: string;
  daily: Array<{ date: string; sessions: number; avgScore: number | null }>;
  lowScoreSessions: Array<{
    shortId: string;
    score: number;
    evaluatedAt: string;
    messageCount: number;
  }>;
};

// W2-5: A/Bテスト結果+改善提案。フィールド形状は
// src/api/admin/agent/actionExecutor.ts の AbTestResultsCardPayload と1対1に保つ。
export type AbTestResultsAgentActionCard = {
  kind: "ab_test_results";
  experiments: Array<{
    id: number;
    name: string;
    status: string;
    minSampleSize: number;
    results: {
      totalExposed: number;
      reliable: boolean;
      warning?: string;
      variants: Record<string, {
        exposed: number;
        reachedTwoPlusRate: number;
        conversionRate: number;
        avgJudgeScore: number | null;
      }>;
    } | null;
  }>;
  suggestions: Array<{
    id: number;
    description: string;
    suggestedAction: string;
  }>;
};

// W2-6: ナレッジ別の成約貢献度。フィールド形状は
// src/api/admin/agent/actionExecutor.ts の KnowledgeAttributionCardPayload と1対1に保つ。
export type KnowledgeAttributionAgentActionCard = {
  kind: "knowledge_attribution";
  period: string;
  sourceType: "all" | "faq" | "book";
  totalChunksUsed: number;
  avgConversionRate: number;
  topItems: Array<{
    chunkId: string;
    source: "faq" | "book";
    title: string;
    principle?: string;
    usageCount: number;
    conversationCount: number;
    conversionRate: number;
    avgJudgeScore: number | null;
    trend: "up" | "down" | "stable" | "insufficient_data";
  }>;
  worstPerformer: {
    chunkId: string;
    source: "faq" | "book";
    title: string;
    conversionRate: number;
  } | null;
};

// W2-7: ご利用状況・お支払い(閲覧専用)。フィールド形状は
// src/api/admin/agent/actionExecutor.ts の BillingSummaryCardPayload と1対1に保つ。
export type BillingSummaryAgentActionCard = {
  kind: "billing_summary";
  period: string;
  plan: string;
  /** Stripe実単価ベースの見積り(円)。算出不可ならnull(0円=無料と誤読させないため区別)。 */
  billingEstimateJpy: number | null;
  /** 機能別の原価構成比(USD)。Stripeは機能別に請求を分けないため実単価ベースにはできない。 */
  breakdown: Array<{ feature: string; label: string; costUsd: number; percentage: number }>;
  invoicesAvailable: boolean;
  invoices: Array<{
    id: string;
    statusLabel: string;
    amountDue: number;
    currency: string;
    created: number;
    hostedInvoiceUrl: string | null;
  }>;
  portalUrl: string | null;
  /** UX-C(2026-08-26): 今月(JST暦月)の込み枠・無料枠消費。取得不可ならnull。 */
  quota: {
    plan: string | null;
    text: { used: number; included: number | null; overage: number };
    avatar: { usedMinutes: number; includedMinutes: number | null; overageMinutes: number };
    /** 管理AIへの相談(Copilot UI)。単位は相談件数((session_id, JST暦日)のDISTINCT)。 */
    admin: { used: number; included: number | null; overage: number };
    freeAd: {
      used: number;
      limit: number;
      remaining: number;
      /** free_ad の管理AI月次上限の当月消費件数。 */
      adminUsed: number;
      /** free_ad の管理AI月次上限。 */
      adminLimit: number;
      /** 上限までの残数。 */
      adminRemaining: number;
    } | null;
  } | null;
};

// CP-3(GID 1218086647623729): change_my_plan の実行後カード。フィールド形状は
// サーバ側 PlanChangedCardPayload(actionExecutor.ts)と一致させること。
export type PlanChangedAgentActionCard = {
  kind: "plan_changed";
  previousPlan: string;
  previousPlanLabel: string;
  plan: string;
  planLabel: string;
  billingSyncNeedsAttention: boolean;
};

export type AgentActionCard =
  | LegacyLinkAgentActionCard
  | AvatarPresetAgentActionCard
  | AvatarAdoptedAgentActionCard
  | TuningRulesListAgentActionCard
  | TuningRuleDraftAgentActionCard
  | WeeklySummaryAgentActionCard
  | ChatSessionListAgentActionCard
  | ChatSessionMessagesAgentActionCard
  | ConversationEvaluationAgentActionCard
  | KnowledgeGapsListAgentActionCard
  | FaqImportPreviewAgentActionCard
  | RuleEffectAgentActionCard
  | AnalyticsTrendAgentActionCard
  | AbTestResultsAgentActionCard
  | KnowledgeAttributionAgentActionCard
  | BillingSummaryAgentActionCard
  | PlanChangedAgentActionCard;

export type AgentAction = { tool: string; result: string; card?: AgentActionCard };

export interface AgentChatReply {
  reply: string;
  actions: AgentAction[];
  answered_from?: AnsweredFrom;
}

// 送信失敗時に画面へ出す文言。技術的な詳細は出さず、次の行動(時間をおく / ログインする)だけ伝える。
export const AGENT_CHAT_ERROR_MESSAGE = "うまく送信できませんでした。少し時間をおいてお試しください。";
export const AGENT_CHAT_AUTH_REQUIRED_MESSAGE =
  "ログインが必要です。別タブで管理画面にログインしてから、もう一度お試しください。";

// サーバはステートレスなので、直近の会話履歴を毎回送ってマルチターンの文脈を持たせる。
// 件数・1件あたりの文字数の両方に上限を置く(プロンプトの肥大とコストの上限を固定するため)。
export const AGENT_CHAT_HISTORY_MAX_ENTRIES = 20;
export const AGENT_CHAT_HISTORY_MAX_CHARS = 4000;

export function buildAgentChatHistoryWindow(entries: ChatHistoryEntry[]): ChatHistoryEntry[] {
  return entries
    .filter((e) => e.content.trim())
    .slice(-AGENT_CHAT_HISTORY_MAX_ENTRIES)
    .map((e) => ({ role: e.role, content: e.content.slice(0, AGENT_CHAT_HISTORY_MAX_CHARS) }));
}

export type AgentChatResult =
  | { ok: true; data: AgentChatReply }
  // kind は面側が経路ごとに出し分けたい場合のためで、message はどの経路でもそのまま表示できる。
  | { ok: false; kind: "http" | "network" | "auth"; message: string };

export interface UseAgentChatTransportOptions {
  surface: AgentChatSurface;
  /** 復元した会話の続きとして始める場合の sessionId(未指定なら新規発行) */
  initialSessionId?: string;
}

export interface AgentChatSendOptions {
  /** 面側が保持している会話履歴。ウィンドウ整形はこのフックが行う */
  history?: ChatHistoryEntry[];
  /**
   * 導出結果を上書きする対象テナントID。パネル側が既存の外部APIを保つためだけに使う経路で、
   * 未指定(通常)なら previewMode から導出した値が使われる。
   */
  targetTenantId?: string;
}

export interface UseAgentChatTransportResult {
  surface: AgentChatSurface;
  sessionId: string;
  /** previewMode から導出した対象テナントID(送らない場合は undefined) */
  targetTenantId: string | undefined;
  /** マウント後に復元した会話の sessionId を引き継ぐ(全画面UIの復元経路用) */
  adoptSessionId: (sessionId: string) => void;
  send: (message: string, opts?: AgentChatSendOptions) => Promise<AgentChatResult>;
}

export function useAgentChatTransport({
  surface,
  initialSessionId,
}: UseAgentChatTransportOptions): UseAgentChatTransportResult {
  // sessionId はコンポーネントのライフタイム中で安定させる。送信時は再レンダーを待たずに
  // 最新値を読む必要があるため ref を真の値とし、state は描画用に同期させる。
  const sessionIdRef = useRef<string | null>(null);
  if (sessionIdRef.current === null) {
    sessionIdRef.current = initialSessionId ?? crypto.randomUUID();
  }
  const [sessionId, setSessionId] = useState<string>(sessionIdRef.current);

  const adoptSessionId = useCallback((next: string) => {
    sessionIdRef.current = next;
    setSessionId(next);
  }, []);

  // super_admin がテナントプレビュー中の場合だけ、対象テナントIDを渡す。client_admin は
  // 自身のJWT由来の tenantId がサーバ側で使われるため送らない。サーバは
  // `isSuperAdmin ? (targetTenantId ?? tenantId) : tenantId` (agentRoutes.ts) で
  // 実効テナントを決めるため、client_admin が送っても無視される(認可の主役はサーバ側)。
  const { previewMode, previewTenantId } = useAuth();
  const derivedTargetTenantId = previewMode && previewTenantId ? previewTenantId : undefined;

  const send = useCallback(
    async (message: string, opts?: AgentChatSendOptions): Promise<AgentChatResult> => {
      const history = buildAgentChatHistoryWindow(opts?.history ?? []);
      const targetTenantId = opts?.targetTenantId ?? derivedTargetTenantId;

      const body: {
        message: string;
        sessionId: string;
        surface: AgentChatSurface;
        targetTenantId?: string;
        history?: ChatHistoryEntry[];
      } = { message, sessionId: sessionIdRef.current as string, surface };
      if (targetTenantId) body.targetTenantId = targetTenantId;
      if (history.length > 0) body.history = history;

      try {
        const res = await authFetch(`${API_BASE}/v1/admin/agent/chat`, {
          method: "POST",
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          return {
            ok: false,
            kind: "http",
            message: errBody.error ? `エラー: ${errBody.error}` : AGENT_CHAT_ERROR_MESSAGE,
          };
        }

        return { ok: true, data: (await res.json()) as AgentChatReply };
      } catch (err) {
        // authFetch はトークンが取れない時に Error("__AUTH_REQUIRED__") を投げる
        if ((err as { message?: string } | null)?.message === "__AUTH_REQUIRED__") {
          return { ok: false, kind: "auth", message: AGENT_CHAT_AUTH_REQUIRED_MESSAGE };
        }
        return { ok: false, kind: "network", message: AGENT_CHAT_ERROR_MESSAGE };
      }
    },
    [derivedTargetTenantId, surface],
  );

  return { surface, sessionId, targetTenantId: derivedTargetTenantId, adoptSessionId, send };
}
