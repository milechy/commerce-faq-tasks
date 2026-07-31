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

// バックエンド(actionExecutor.ts の ActionCardPayload)が自然文に添えて返す構造化
// カード。card を返すのは get_legacy_ui_link / get_chat_sessions / get_chat_session_messages
// の3ツールで、他のツールは従来どおり result の自然文のみ。
// フィールド形はサーバ側の型と1:1で対応させる(型定義箇所はサーバ/ここの2箇所に限る)。
export type AgentActionCard =
  | { kind: "legacy_link"; label: string; url: string; description: string }
  | {
      kind: "chat_session_list";
      total: number;
      sessions: Array<{ shortId: string; startedAt: string; messageCount: number; preview: string }>;
    }
  | {
      kind: "chat_session_messages";
      shortId: string;
      totalMessages: number;
      messages: Array<{ roleLabel: string; content: string }>;
    };

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
