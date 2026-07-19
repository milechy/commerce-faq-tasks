// admin-ui/src/pages/copilot-preview/index.tsx
//
// 【プロトタイプ / 追加専用】テナント向けチャット・ファースト管理画面のUX検証用ページ。
// 既存の管理画面(App.tsx の認証ルート群)には一切影響しない、認証ゲート外の隔離ルート。
//   URL: /copilot-preview
// サイドバー・自由入力欄とも、全て実際の R2Cエージェント API
// (POST /v1/admin/agent/chat)に接続されている。モックの固定シナリオは廃止済み。
// ログイン済みセッション(同一ブラウザの Supabase セッション)が必要。未ログインならその旨を案内する。
// テーマは既存の CSS 変数に追従(light/dark両対応)。

import { useState, useRef, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { isChatFirstDefaultEnabled, setChatFirstDefaultEnabled } from "../../lib/chatFirstDefault";

// ─── モデル ──────────────────────────────────────────────────────────────────

type Category =
  | { key: string; label: string; icon: string; dim?: boolean };

type Card =
  | { kind: "faq"; question: string; answer: string; category: string }
  | { kind: "rule"; trigger: string; behavior: string }
  | { kind: "engagement"; when: string; message: string }
  | { kind: "success"; text: string }
  | { kind: "link"; label: string; url: string; description: string }
  | { kind: "agentAction"; tool: string; result: string };

// 自由入力欄からの実API呼び出しで使うツール名 → 日本語ラベル
const REAL_TOOL_LABEL: Record<string, string> = {
  get_weekly_briefing: "週次ブリーフィングの取得",
  suggest_tuning_rule: "指示ルールの下書き提案",
  save_tuning_rule: "指示ルールの保存",
  suggest_faq: "FAQの下書き提案",
  save_faq: "FAQの保存",
  suggest_engagement_rule: "声がけの下書き提案",
  save_engagement_rule: "声がけの保存",
  get_tenant_settings: "テナント設定の取得",
  set_ga4_id: "GA4設定の変更",
  set_posthog: "PostHog設定の変更",
  get_faq_list: "FAQ一覧の取得",
  add_faq: "FAQの追加",
  update_faq: "FAQの更新",
  delete_faq: "FAQの削除",
  activate_avatar: "アバターの有効化",
  get_embed_code: "埋め込みコードの取得",
  set_widget_theme: "ウィジェットテーマの変更",
  get_tuning_rules: "指示ルール一覧の取得",
  update_tuning_rule: "指示ルールの更新",
  delete_tuning_rule: "指示ルールの削除",
  generate_tuning_rule_test_responses: "テスト応答の生成",
  approve_tuning_rule_response: "テスト応答の採用",
  remove_approved_response: "採用済み応答の取消",
  get_engagement_rules: "声がけルール一覧の取得",
  update_engagement_rule: "声がけルールの更新",
  delete_engagement_rule: "声がけルールの削除",
  get_knowledge_gaps: "知識ギャップの取得",
  dismiss_knowledge_gap: "知識ギャップの片付け",
  get_chat_sessions: "会話セッション一覧の取得",
  get_escalations: "エスカレーション一覧の取得",
  get_monitoring_summary: "モニタリングサマリーの取得",
  get_legacy_ui_link: "旧管理画面への案内",
  get_avatar_status: "アバター稼働状況の取得",
  request_sai_task: "Saiへの代行依頼",
  get_sai_task_status: "Saiタスク状況の取得",
};

// 実際にDBを書き換える(=「進捗」としてカウントしてよい)ツール名
const REAL_WRITE_TOOLS = new Set([
  "save_tuning_rule",
  "save_faq",
  "save_engagement_rule",
  "add_faq",
  "update_faq",
  "delete_faq",
  "set_ga4_id",
  "set_posthog",
  "set_widget_theme",
  "activate_avatar",
]);

// Phase2 (P7): ログイン直後に能動的に状況を尋ねる自動キックオフメッセージ
const BOOTSTRAP_PROMPT =
  "ログインしたところです。今週の状況を教えてください。要点と次にやるべきことを最大3つまで、簡潔に教えてください。";

// ─── 実APIのツール結果 → 見た目の良いカードへの変換 ────────────────────────────
// actionExecutor.ts が返す日本語の定型文字列を軽くパースする。想定外の形式なら
// null を返し、呼び出し側は汎用の agentAction カード（生テキスト）にフォールバックする。

function parseSuggestFaq(result: string): { question: string; answer: string; category: string } | null {
  const q = result.match(/質問:\s*(.+)/)?.[1]?.trim();
  const a = result.match(/回答:\s*(.+)/)?.[1]?.trim();
  if (!q || !a) return null;
  const c = result.match(/分類:\s*(.+)/)?.[1]?.trim();
  return { question: q, answer: a, category: c || "(自動判定)" };
}

function parseSuggestTuningRule(result: string): { trigger: string; behavior: string } | null {
  const t = result.match(/トリガー:\s*(.+)/)?.[1]?.trim();
  const b = result.match(/対応方針:\s*(.+)/)?.[1]?.trim();
  if (!t || !b) return null;
  return { trigger: t, behavior: b };
}

function describeEngagementTrigger(type: string, config: Record<string, unknown>): string {
  switch (type) {
    case "idle_time":
      return `${config["seconds"] ?? "?"}秒間操作がない時`;
    case "scroll_depth":
      return `ページを${config["threshold"] ?? "?"}%スクロールした時`;
    case "exit_intent":
      return "サイトを離れようとした時";
    case "page_url_match": {
      const patterns = Array.isArray(config["patterns"]) ? (config["patterns"] as unknown[]).join("・") : "特定ページ";
      return `${patterns} を見ている時`;
    }
    default:
      return type;
  }
}

function parseSuggestEngagementRule(result: string): { when: string; message: string } | null {
  const type = result.match(/トリガー種別:\s*(.+)/)?.[1]?.trim();
  const cfgRaw = result.match(/トリガー設定:\s*(\{.*\})/)?.[1];
  const message = result.match(/表示文言:\s*(.+)/)?.[1]?.trim();
  if (!type || !message) return null;
  let config: Record<string, unknown> = {};
  try {
    config = cfgRaw ? (JSON.parse(cfgRaw) as Record<string, unknown>) : {};
  } catch {
    // パース失敗時はトリガー種別名だけで表示（フォールバック文言）
  }
  return { when: describeEngagementTrigger(type, config), message };
}

function parseLegacyUiLink(result: string): { label: string; url: string; description: string } | null {
  const label = result.match(/画面:\s*(.+)/)?.[1]?.trim();
  const url = result.match(/URL:\s*(.+)/)?.[1]?.trim();
  const description = result.match(/説明:\s*(.+)/)?.[1]?.trim();
  if (!label || !url || !description) return null;
  return { label, url, description };
}

const SAVE_SUCCESS_RE = /を(保存|登録|削除|更新|有効化|設定)しました/;

// ─── 進行中テキストを少しずつ流し込む（体感の良さ重視の演出。本物の
//     トークンストリーミングではなく、確定済みの応答文字列をクライアント側で
//     少しずつ表示するだけ。真のストリーミングにはバックエンドの
//     SSE化(本番AdminAgentPanelと共有するエンドポイントの変更)が必要で別スコープ） ───

function useTypewriter(setMsgs: Dispatch<SetStateAction<Msg[]>>) {
  return useCallback(
    (id: number, fullText: string, onDone?: () => void) => {
      const reduceMotion =
        typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion || !fullText) {
        setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, text: fullText } : m)));
        onDone?.();
        return;
      }
      const chars = Array.from(fullText); // サロゲートペア・絵文字を考慮
      let i = 0;
      const CHARS_PER_TICK = 3;
      const timer = setInterval(() => {
        i = Math.min(chars.length, i + CHARS_PER_TICK);
        setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, text: chars.slice(0, i).join("") } : m)));
        if (i >= chars.length) {
          clearInterval(timer);
          onDone?.();
        }
      }, 16);
    },
    [setMsgs],
  );
}

interface Chip {
  label: string;
  action: string;
  tone?: "primary" | "ghost";
}

interface Msg {
  id: number;
  role: "ai" | "me";
  text?: string;
  card?: Card;
  chips?: Chip[];
  chipsUsed?: boolean;
}

const AGENT = "#7c3aed";
const AGENT_SOFT = "rgba(124,58,237,0.10)";
const AGENT_BORDER = "rgba(124,58,237,0.30)";

const CATEGORIES: Category[] = [
  { key: "assistant", label: "アシスタント", icon: "✨" },
  { key: "weekly", label: "今週のまとめ", icon: "📊" },
  { key: "history", label: "会話の履歴", icon: "💬" },
  { key: "knowledge", label: "知識データ", icon: "📚" },
  { key: "rules", label: "指示ルール", icon: "🎛️" },
  { key: "avatar", label: "アバター", icon: "🎭" },
];

// ─── ページ ──────────────────────────────────────────────────────────────────

let _uid = 100;
const nextId = () => ++_uid;

export default function CopilotPreviewPage() {
  const [active, setActive] = useState("assistant");
  const [input, setInput] = useState("");
  // 起動直後は空。bootstrap()が実データの週次ブリーフィングを積む
  const [msgs, setMsgs] = useState<Msg[]>([]);

  // 自由入力欄・起動時ブリーフィング・サイドバー各カテゴリーが繋がる実チャットの状態
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const [realHistory, setRealHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [realActionCount, setRealActionCount] = useState(0); // 実際に成功した書き込み操作の件数

  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const push = useCallback((...items: Msg[]) => {
    setMsgs((prev) => [...prev, ...items]);
  }, []);

  const revealText = useTypewriter(setMsgs);

  const say = (text: string, chips?: Chip[]): Msg => ({ id: nextId(), role: "ai", text, chips });
  const me = (text: string): Msg => ({ id: nextId(), role: "me", text });

  // チップを押したら、そのメッセージのチップを使用済みにする
  const consumeChips = (msgId: number) =>
    setMsgs((prev) => prev.map((m) => (m.id === msgId ? { ...m, chipsUsed: true } : m)));

  // Phase1/2: 実際の R2Cエージェント API を呼ぶ（自由入力欄・起動時ブリーフィングから）。
  // suggest_tuning_rule / save_tuning_rule / get_weekly_briefing 等が本物のDBを読み書きする。
  // silent=true はページ起動時の自動キックオフ用（ユーザーが打った体で me() バブルを積まない）。
  const sendReal = async (text: string, opts?: { silent?: boolean }) => {
    if (!text.trim() || sending) return;
    if (!opts?.silent) push(me(text));
    setSending(true);
    try {
      const body: { message: string; sessionId: string; history?: typeof realHistory } = {
        message: text,
        sessionId: sessionIdRef.current,
      };
      if (realHistory.length > 0) body.history = realHistory.slice(-20);

      const res = await authFetch(`${API_BASE}/v1/admin/agent/chat`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({} as { error?: string }));
        push(say(errBody.error ? `エラー: ${errBody.error}` : "うまく送信できませんでした。少し時間をおいてお試しください。"));
        setSending(false);
        return;
      }

      const data = (await res.json()) as { reply: string; actions: { tool: string; result: string }[] };
      setRealHistory((prev) =>
        [
          ...prev,
          { role: "user" as const, content: text },
          { role: "assistant" as const, content: data.reply },
        ].slice(-20),
      );

      // ツール結果を、可能なら提案書と同じ見た目のカードにパースする。
      // 想定外の形式(下書き生成失敗時のエラー文など)は汎用の agentAction カードにフォールバック。
      const actionMsgs: Msg[] = (data.actions ?? []).map((a) => {
        if (a.tool === "suggest_faq") {
          const parsed = parseSuggestFaq(a.result);
          if (parsed) return { id: nextId(), role: "ai", card: { kind: "faq", ...parsed } };
        } else if (a.tool === "suggest_tuning_rule") {
          const parsed = parseSuggestTuningRule(a.result);
          if (parsed) return { id: nextId(), role: "ai", card: { kind: "rule", ...parsed } };
        } else if (a.tool === "suggest_engagement_rule") {
          const parsed = parseSuggestEngagementRule(a.result);
          if (parsed) return { id: nextId(), role: "ai", card: { kind: "engagement", ...parsed } };
        } else if (a.tool === "get_legacy_ui_link") {
          const parsed = parseLegacyUiLink(a.result);
          if (parsed) return { id: nextId(), role: "ai", card: { kind: "link", ...parsed } };
        } else if (
          (a.tool === "save_faq" || a.tool === "save_tuning_rule" || a.tool === "save_engagement_rule") &&
          SAVE_SUCCESS_RE.test(a.result)
        ) {
          return { id: nextId(), role: "ai", card: { kind: "success", text: a.result } };
        }
        return { id: nextId(), role: "ai", card: { kind: "agentAction", tool: a.tool, result: a.result } };
      });

      // 実際にDBへ書き込んだ操作(確認ブロックで弾かれたものは除く)だけを実進捗としてカウントする
      const writesThisTurn = (data.actions ?? []).filter(
        (a) => REAL_WRITE_TOOLS.has(a.tool) && !a.result.includes("確認が必要"),
      ).length;
      if (writesThisTurn > 0) setRealActionCount((n) => n + writesThisTurn);

      // suggest系の下書きが出たら、そのまま自然文で確定できるチップを添える
      const SUGGEST_TOOLS = new Set(["suggest_tuning_rule", "suggest_faq", "suggest_engagement_rule"]);
      const suggested = data.actions?.some((a) => SUGGEST_TOOLS.has(a.tool));
      // Saiへの依頼がconfirmed待ちでブロックされた場合も、そのまま同意できるチップを添える
      const saiPendingConfirm = data.actions?.some(
        (a) => a.tool === "request_sai_task" && a.result.includes("確認が必要"),
      );
      const chips: Chip[] | undefined = suggested
        ? [
            { label: "保存して", action: "__real:保存してください", tone: "primary" },
            { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
          ]
        : saiPendingConfirm
        ? [
            { label: "お願いする", action: "__real:はい、お願いします", tone: "primary" },
            { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
          ]
        : undefined;

      push(...actionMsgs);

      // 最終返信だけを少しずつ流し込む(演出)。チップは流し込み完了後に表示する。
      const replyId = nextId();
      push({ id: replyId, role: "ai", text: "" });
      revealText(replyId, data.reply || "（応答なし）", () => {
        if (chips) setMsgs((prev) => prev.map((m) => (m.id === replyId ? { ...m, chips } : m)));
        setSending(false);
      });
      return; // setSending(false) は revealText の完了コールバックに任せる
    } catch (err: any) {
      if (err?.message === "__AUTH_REQUIRED__") {
        push(say("ログインが必要です。別タブで管理画面にログインしてから、もう一度お試しください。"));
      } else {
        push(say("うまく送信できませんでした。少し時間をおいてお試しください。"));
      }
    }
    setSending(false);
  };

  // マウント時に実データの週次ブリーフィングを自動取得
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      push({ id: nextId(), role: "ai", text: "ログイン、お疲れさまです。今週の実データを確認しています…" });
      await sendReal(BOOTSTRAP_PROMPT, { silent: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAction = (action: string, fromMsgId: number) => {
    consumeChips(fromMsgId);
    // チップは全て実APIへの返信（sendReal 側で me() を積むため、ここでは積まない）
    void sendReal(action.startsWith("__real:") ? action.slice("__real:".length) : action);
  };

  // 会話中は今アクティブなカテゴリー以外への切り替えを禁止する。応答が同じ
  // スレッドに割り込んで別カテゴリーの応答と混ざるのを防ぐため。
  // 「会話中」の定義:
  //   - sending: 実APIの応答待ち〜タイプライター演出完了まで
  //   - awaitingUserDecision: 直前のAIメッセージにまだ選ばれていないチップが残っている
  //     (＝suggest_*の下書きやSai依頼の確認待ちで、ユーザーの選択待ち)
  // いずれかがtrueの間はロックし、実APIの応答が完了すると自動的に解放される。
  const lastMsg = msgs[msgs.length - 1];
  const awaitingUserDecision =
    !!lastMsg && lastMsg.role === "ai" && !!lastMsg.chips && lastMsg.chips.length > 0 && !lastMsg.chipsUsed;
  const busy = sending || awaitingUserDecision;

  // ボタン側のdisabledで大半は弾かれるが、ここでも二重に防御する。
  const handleCategory = (key: string) => {
    if (busy && key !== active) return;
    setActive(key);
    if (key === "weekly") {
      void sendReal("今週の状況を教えてください。要点と次にやるべきことを最大3つまで、簡潔に教えてください。");
    } else if (key === "history") {
      void sendReal("最近の会話とエスカレーションの状況を教えて");
    } else if (key === "avatar") {
      void sendReal("アバターの稼働状況を教えて");
    } else if (key === "knowledge") {
      // Phase E: get_faq_list/get_knowledge_gaps(実API)に接続。以前はモック固定文言だった
      void sendReal("知識データの状況を教えて（FAQの件数と、AIが答えられなかった質問があれば教えて）");
    } else if (key === "rules") {
      // Phase B: get_tuning_rules(実API)に接続。以前はモック固定文言だった
      void sendReal("指示ルールの状況を教えて");
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    void sendReal(text);
  };

  // ─── レイアウト ───────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--background)", color: "var(--foreground)", fontFamily: "var(--font-sans, system-ui, sans-serif)", overflow: "hidden" }}>
      {/* 左レール(=各カテゴリはAIブリーフィングの窓口) */}
      <aside style={{ width: 248, flexShrink: 0, background: "var(--sidebar, var(--card))", borderRight: "1px solid var(--border)", padding: "20px 14px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "-0.03em", padding: "4px 8px 6px" }}>
          R2C
          <span style={{ fontSize: 11, fontWeight: 700, color: AGENT, background: AGENT_SOFT, padding: "2px 8px", borderRadius: 6, marginLeft: 7, letterSpacing: "0.04em" }}>店主モード</span>
        </div>
        <PreviewBadge />
        {CATEGORIES.map((c) => {
          const locked = busy && c.key !== active;
          return (
            <button
              key={c.key}
              onClick={() => handleCategory(c.key)}
              disabled={locked}
              title={locked ? "会話が完了するまで他のカテゴリーには切り替えられません" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 11, textAlign: "left",
                padding: "11px 12px", borderRadius: 10, border: "none",
                cursor: locked ? "not-allowed" : "pointer",
                fontSize: 15, fontWeight: active === c.key ? 700 : 500,
                color: active === c.key ? AGENT : "var(--muted-foreground)",
                background: active === c.key ? AGENT_SOFT : "transparent",
                opacity: locked ? 0.35 : c.dim ? 0.55 : 1, minHeight: 44,
              }}
            >
              <span style={{ fontSize: 18 }}>{c.icon}</span>{c.label}
            </button>
          );
        })}
        <div style={{ marginTop: "auto" }}>
          <Phase4DefaultToggle />
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.55, padding: "10px" }}>
            「くわしい設定」は従来画面のまま。会話UIは<strong style={{ color: "var(--foreground)" }}>追加</strong>で、既存は消していません。
          </div>
        </div>
      </aside>

      {/* チャット本体 */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* ヘッダー */}
        <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 28px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <AgentMark />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 17 }}>R2Cエージェント</div>
            <div style={{ fontSize: 13, color: "var(--muted-foreground)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 0 3px rgba(34,197,94,0.15)" }} />オンライン
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
            <RealActionBadge count={realActionCount} />
          </div>
        </header>

        {/* スレッド */}
        <div ref={threadRef} style={{ flex: 1, overflowY: "auto", padding: "28px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
            {msgs.map((m) => (
              <MessageRow key={m.id} m={m} onChip={runAction} />
            ))}
          </div>
        </div>

        {/* コンポーザ（実API接続） */}
        <div style={{ padding: "0 28px 24px", flexShrink: 0 }}>
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 12px 12px 20px", border: `1px solid ${sending ? AGENT_BORDER : "var(--border)"}`, borderRadius: 16, background: "var(--input, var(--card))" }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
                placeholder="指示ルールを話しかけてみてください（例：保証について聞かれたら2年と答えて）"
                disabled={sending}
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--foreground)", fontSize: 16, minHeight: 32 }}
              />
              <button onClick={handleSend} disabled={sending} aria-label="送信" style={{ width: 40, height: 40, borderRadius: 12, border: "none", background: AGENT, color: "#fff", cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.6 : 1, fontSize: 18 }}>
                {sending ? "…" : "↑"}
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted-foreground)", textAlign: "center" }}>
              実際の R2Cエージェントに接続されています。要ログイン。
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── 部品 ────────────────────────────────────────────────────────────────────

function PreviewBadge() {
  return (
    <div style={{ margin: "6px 8px 10px", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.03em", color: "#b45309", background: "rgba(245,158,11,0.14)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "6px 10px", lineHeight: 1.45 }}>
      PROTOTYPE ・ 全ての操作が実際のR2Cエージェント(実API)に接続されています
    </div>
  );
}

function AgentMark() {
  return (
    <div style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0, position: "relative", background: `conic-gradient(from 140deg, ${AGENT}, #d99320, ${AGENT})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 3, borderRadius: "50%", background: "var(--card, var(--background))" }} />
      <span style={{ position: "relative", zIndex: 1, fontSize: 20 }}>✨</span>
    </div>
  );
}

// Phase4: チャット・ファーストを既定ランディングにするかの個人オプトイン(このブラウザのみ)。
// ONにすると次回以降 /admin, / を開いた時にこの画面が開くようになる。テナント全体・
// 他ユーザーには一切影響しない。既定はOFF(従来のダッシュボードのまま)。
function Phase4DefaultToggle() {
  const [enabled, setEnabled] = useState(() => isChatFirstDefaultEnabled());

  const toggle = () => {
    const next = !enabled;
    setChatFirstDefaultEnabled(next);
    setEnabled(next);
  };

  return (
    <button
      onClick={toggle}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "calc(100% - 16px)", margin: "0 8px 8px",
        padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)",
        background: enabled ? AGENT_SOFT : "transparent", cursor: "pointer", textAlign: "left",
      }}
    >
      <span
        style={{
          width: 36, height: 20, borderRadius: 999, background: enabled ? AGENT : "var(--border)",
          position: "relative", flexShrink: 0, transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute", top: 3, left: enabled ? 19 : 3, width: 14, height: 14, borderRadius: "50%",
            background: "#fff", transition: "left 0.15s",
          }}
        />
      </span>
      <span style={{ fontSize: 13, color: enabled ? AGENT : "var(--muted-foreground)", lineHeight: 1.45 }}>
        これを既定の画面にする
        <br />
        <span style={{ fontSize: 11.5, opacity: 0.75 }}>このブラウザだけの設定です</span>
      </span>
    </button>
  );
}

function RealActionBadge({ count }: { count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: count > 0 ? "#16a34a" : "var(--muted-foreground)" }}>
      <span style={{ fontSize: 13 }}>{count > 0 ? "✅" : "◦"}</span>
      実際の操作 <strong style={{ fontVariantNumeric: "tabular-nums" }}>{count}</strong>件
    </div>
  );
}

function MessageRow({ m, onChip }: { m: Msg; onChip: (a: string, id: number) => void }) {
  const isMe = m.role === "me";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", gap: 10 }}>
      {m.text && (
        <div style={{ maxWidth: "90%", padding: "14px 18px", borderRadius: isMe ? "18px 18px 6px 18px" : "18px 18px 18px 6px", background: isMe ? AGENT : "var(--muted, rgba(120,120,140,0.12))", color: isMe ? "#fff" : "var(--foreground)", fontSize: 16, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {m.text}
        </div>
      )}
      {m.card && <CardView card={m.card} />}
      {m.chips && !m.chipsUsed && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {m.chips.map((c, i) => (
            <button
              key={i}
              onClick={() => onChip(c.action, m.id)}
              style={{
                fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, cursor: "pointer",
                border: c.tone === "primary" ? "none" : "1px solid var(--border)",
                background: c.tone === "primary" ? AGENT : "transparent",
                color: c.tone === "primary" ? "#fff" : "var(--muted-foreground)",
                minHeight: 44,
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CardShell({ hd, tone = "agent", children, foot }: { hd: React.ReactNode; tone?: "agent" | "brand" | "good"; children: React.ReactNode; foot?: React.ReactNode }) {
  const border = tone === "good" ? "rgba(34,197,94,0.4)" : tone === "brand" ? "rgba(217,147,32,0.4)" : AGENT_BORDER;
  const hdBg = tone === "good" ? "rgba(34,197,94,0.12)" : tone === "brand" ? "rgba(217,147,32,0.12)" : AGENT_SOFT;
  const hdColor = tone === "good" ? "#16a34a" : tone === "brand" ? "#b45309" : AGENT;
  return (
    <div style={{ width: "100%", maxWidth: "100%", border: `1px solid ${border}`, borderRadius: 16, overflow: "hidden", background: "var(--card)", boxShadow: "0 2px 4px rgba(0,0,0,0.05), 0 10px 28px rgba(0,0,0,0.07)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", background: hdBg, borderBottom: `1px solid ${border}`, fontWeight: 700, fontSize: 15, color: hdColor }}>{hd}</div>
      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
      {foot}
    </div>
  );
}

function Field({ k, v, quote, hi }: { k: string; v: string; quote?: boolean; hi?: boolean }) {
  return (
    <div style={{ fontSize: 15 }}>
      <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 4 }}>{k}</div>
      <div style={{ color: "var(--foreground)", ...(quote ? { background: "var(--muted, rgba(120,120,140,0.1))", borderRadius: 10, padding: "10px 14px", borderLeft: `3px solid ${hi ? "#d99320" : AGENT}`, lineHeight: 1.7 } : {}) }}>{v}</div>
    </div>
  );
}

function CardView({ card }: { card: Card }) {
  switch (card.kind) {
    case "agentAction":
      return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 14px", borderRadius: 12, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.28)", fontSize: 14.5, lineHeight: 1.7, maxWidth: "90%" }}>
          <span style={{ fontSize: 12.5, flexShrink: 0 }}>✅</span>
          <span>
            <strong style={{ color: "var(--foreground)" }}>{REAL_TOOL_LABEL[card.tool] ?? card.tool}</strong>
            <span style={{ color: "var(--muted-foreground)" }}>：{card.result}</span>
          </span>
        </div>
      );
    case "faq":
      return (
        <CardShell hd={<><span>📚</span>新しい知識を登録します</>}
          foot={<CardActionsNote note="登録するまで反映されません。内容はいつでも直せます。" />}>
          <Field k="お客様の質問" v={card.question} />
          <Field k="AIが答える内容" v={card.answer} quote />
          <Field k="分類" v={card.category + "（AIが自動で判定）"} />
        </CardShell>
      );
    case "rule":
      return (
        <CardShell hd={<><span>🎛️</span>AIへの指示ルールを追加します</>}
          foot={<CardActionsNote note="「いつ・どう振る舞うか」を1つの指示にまとめました。" />}>
          <Field k="どんな時に" v={card.trigger} />
          <Field k="こう振る舞う" v={card.behavior} quote />
        </CardShell>
      );
    case "engagement":
      return (
        <CardShell hd={<><span>⚡</span>お客様への声がけを設定します</>}
          foot={<CardActionsNote note="離脱しそうなタイミングを検知して自動で表示します。" />}>
          <Field k="いつ出すか" v={card.when} />
          <Field k="表示する言葉" v={card.message} quote hi />
        </CardShell>
      );
    case "success":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 12, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.28)", color: "var(--foreground)", fontSize: 15 }}>
          <span style={{ fontSize: 17 }}>✅</span>{card.text}
        </div>
      );
    case "link":
      return (
        <CardShell hd={<><span>🔗</span>{card.label}へご案内します</>}>
          <Field k="この操作について" v={card.description} />
          <a
            href={card.url}
            style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, background: AGENT, color: "#fff", fontSize: 14, fontWeight: 700, textDecoration: "none" }}
          >
            {card.label}を開く →
          </a>
        </CardShell>
      );
    default:
      return null;
  }
}

function CardActionsNote({ note }: { note: string }) {
  // ボタン自体はメッセージのchipsが担うため、ここは補足文のみ
  return (
    <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)", background: "var(--muted, rgba(120,120,140,0.06))", fontSize: 13, color: "var(--muted-foreground)" }}>
      {note}
    </div>
  );
}
