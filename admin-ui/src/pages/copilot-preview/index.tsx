// admin-ui/src/pages/copilot-preview/index.tsx
//
// 【プロトタイプ / 追加専用】テナント向けチャット・ファースト管理画面のUX検証用ページ。
// 既存の管理画面(App.tsx の認証ルート群)には一切影響しない、認証ゲート外の隔離ルート。
//   URL: /copilot-preview
// 左のブリーフィング/カード群はスクリプト化したモック(①能動ブリーフィング ②確認カード
// ③解決後の次へ導く循環(進捗つき) ④Sai委譲)で、体験の形を見せるためのもの。
//
// Phase1: 下部コンポーザ(自由入力)だけは実際の R2Cエージェント API
// (POST /v1/admin/agent/chat, suggest_tuning_rule / save_tuning_rule ツール)に接続されている。
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
  | { kind: "briefing" }
  | { kind: "faq"; question: string; answer: string; category: string }
  | { kind: "rule"; trigger: string; behavior: string }
  | { kind: "engagement"; when: string; message: string }
  | { kind: "sai"; request: string; result: string; url: string }
  | { kind: "success"; text: string }
  | { kind: "analytics" }
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
  get_feedback_list: "フィードバック一覧の取得",
  triage_feedback: "フィードバックの更新",
  create_deny_rule_from_feedback: "拒否ルールの一発作成",
  get_knowledge_gaps: "知識ギャップの取得",
  dismiss_knowledge_gap: "知識ギャップの片付け",
  get_chat_sessions: "会話セッション一覧の取得",
  get_escalations: "エスカレーション一覧の取得",
  get_monitoring_summary: "モニタリングサマリーの取得",
  get_sai_order_list: "代行注文一覧の取得",
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
  const [done, setDone] = useState(0); // モックデモ: 今週の改善 3件中 done件 完了
  const [input, setInput] = useState("");
  // Phase2: 起動直後は空。bootstrap()が①実データのブリーフィング→②モックデモの順で積む
  const [msgs, setMsgs] = useState<Msg[]>([]);

  // Phase1/2: 自由入力欄・起動時ブリーフィングが繋がる実チャットの状態
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const [realHistory, setRealHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [realActionCount, setRealActionCount] = useState(0); // 実際に成功した書き込み操作の件数
  // モックデモ側の非同期待ち（saiYesの疑似処理中など）。sendingと合わせて「会話ビジー」を構成する。
  const [pendingTimer, setPendingTimer] = useState(false);

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
      const chips: Chip[] | undefined = suggested
        ? [
            { label: "保存して", action: "__real:保存してください", tone: "primary" },
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

  // Phase2 (P7): マウント時に実データの週次ブリーフィングを自動取得 → その後にモックデモを積む
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      push({ id: nextId(), role: "ai", text: "ログイン、お疲れさまです。今週の実データを確認しています…" });
      await sendReal(BOOTSTRAP_PROMPT, { silent: true });

      push({
        id: nextId(),
        role: "ai",
        text: "─────────────\nここから先は、将来のビジョンのデモです（バックエンド未接続のスクリプト固定・サンプルデータ）。",
      });
      push(
        { id: nextId(), role: "ai", text: "おはようございます、田中さん☀️ 今週のお店の様子をまとめました。" },
        {
          id: nextId(),
          role: "ai",
          card: { kind: "briefing" },
          chips: [
            { label: "1番をやる", action: "do1", tone: "primary" },
            { label: "あとで", action: "later", tone: "ghost" },
          ],
        },
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAction = (action: string, fromMsgId: number, label: string) => {
    consumeChips(fromMsgId);

    // "__real:" プレフィックスは実APIへの返信（sendReal 側で me() を積むため、ここでは積まない）
    if (action.startsWith("__real:")) {
      void sendReal(action.slice("__real:".length));
      return;
    }

    if (label) push(me(label));

    switch (action) {
      case "do1":
        push(
          say("いいですね。送料の質問に答えられるよう、こう登録します 👇 内容をご確認ください。"),
          {
            id: nextId(),
            role: "ai",
            card: {
              kind: "faq",
              question: "送料はいくらですか？",
              answer:
                "全国一律550円です。5,000円以上のお買い上げで送料無料になります。北海道・沖縄は追加で440円いただいております。",
              category: "店舗情報 ・ すぐに公開",
            },
            chips: [
              { label: "✓ この内容で登録", action: "confirmFaq", tone: "primary" },
              { label: "文章を直したい", action: "editFaq", tone: "ghost" },
            ],
          },
        );
        break;

      case "editFaq":
        push(say("どこを直しましょう？ 例えば「北海道・沖縄も無料にして」のように話しかけてください。（このプロトタイプでは登録に進みます）", [
          { label: "やっぱりこのまま登録", action: "confirmFaq", tone: "primary" },
        ]));
        break;

      case "confirmFaq":
        setDone(1);
        push(
          { id: nextId(), role: "ai", card: { kind: "success", text: "「送料はいくらですか？」への答えを登録しました。次から自動で答えます。" } },
          say(
            "直りました！ ✅（今週の改善 3件中 1件 完了）\n\nついでにもう一つ。最近「丁寧すぎて説明が長い」というお客様の反応が増えています。少しだけ短く話す設定にできますが、やりますか？",
            [
              { label: "お願い", action: "do2", tone: "primary" },
              { label: "今日はここまで", action: "stop", tone: "ghost" },
            ],
          ),
        );
        break;

      case "do2":
        push(
          say("承知しました。AIへの指示ルールをこう追加します 👇"),
          {
            id: nextId(),
            role: "ai",
            card: {
              kind: "rule",
              trigger: "商品説明・使い方の質問",
              behavior: "要点を先に1〜2文で答え、詳細は必要な時だけ足す。前置きのあいさつは省く。",
            },
            chips: [
              { label: "✓ この方針で適用", action: "confirmRule", tone: "primary" },
              { label: "今日はここまで", action: "stop", tone: "ghost" },
            ],
          },
        );
        break;

      case "confirmRule":
        setDone(2);
        push(
          { id: nextId(), role: "ai", card: { kind: "success", text: "応答をやや簡潔にする指示ルールを適用しました。" } },
          say(
            "できました！ ✅（3件中 2件 完了）\n\n最後にもう一つ。夜21時台にサイトを離れるお客様が多めです。この時間に一言、声をかけると引き止められそうです。設定しますか？",
            [
              { label: "お願い", action: "do3", tone: "primary" },
              { label: "今日はここまで", action: "stop", tone: "ghost" },
            ],
          ),
        );
        break;

      case "do3":
        push(
          say("では、こんな声がけを用意します 👇"),
          {
            id: nextId(),
            role: "ai",
            card: {
              kind: "engagement",
              when: "サイトを離れそうな時（夜間に多い離脱を検知）",
              message: "お探しのものは見つかりましたか？ よければ人気ランキングもご覧ください🎁",
            },
            chips: [
              { label: "✓ この声がけを設定", action: "confirmEngage", tone: "primary" },
              { label: "今日はここまで", action: "stop", tone: "ghost" },
            ],
          },
        );
        break;

      case "confirmEngage":
        setDone(3);
        push(
          { id: nextId(), role: "ai", card: { kind: "success", text: "離脱しそうなお客様への声がけを設定しました。" } },
          say(
            "今週の改善、3件ぜんぶ完了しました 🎉 これでAIはもっと賢く、取りこぼしも減ります。\n\nもう一つ、私が代わりにやっておけることがあります。あなたの商品ページの送料表記が古いままでした。R2Cが代わりに直しておきましょうか？（作業料 ¥3,000）",
            [
              { label: "お願いする", action: "saiYes", tone: "primary" },
              { label: "あとで自分でやる", action: "saiLater", tone: "ghost" },
            ],
          ),
        );
        break;

      case "saiYes":
        push(say("承知しました。商品ページを開いて更新します…（30秒ほどお待ちください）"));
        setPendingTimer(true);
        setTimeout(() => {
          setPendingTimer(false);
          push(
            say("完了しました。実際の画面がこちらです。仕上がりをご確認ください 👇"),
            {
              id: nextId(),
              role: "ai",
              card: {
                kind: "sai",
                request: "商品ページの送料表記を新しい内容に更新",
                result: "送料の記載を「全国一律550円・5,000円以上で無料」に更新しました。",
                url: "your-shop.example.com/products/123",
              },
              chips: [
                { label: "✓ これでOK", action: "saiOk", tone: "primary" },
                { label: "ちがう、直したい", action: "saiFix", tone: "ghost" },
              ],
            },
          );
        }, 1400);
        break;

      case "saiFix":
        push(say("どこを直しましょう？ 「ここはこうして」と教えていただければ、その指示は次回から私が覚えて、同じ間違いをしなくなります。（このプロトタイプではここまで）"));
        break;

      case "saiOk":
        push(say("ありがとうございます！ 反映しました。今日はここまでで大丈夫です。また何かあれば通知でお知らせしますね 🔔"));
        break;

      case "saiLater":
      case "stop":
      case "later":
        push(say("承知しました。また通知でお声がけします。いつでも話しかけてください 🙌"));
        break;

      case "analytics":
        push(
          { id: nextId(), role: "ai", card: { kind: "analytics" } },
          say("特に気になるのは夜21時台の離脱です。ここに声がけを1つ足すと拾えそうです。設定しますか？", [
            { label: "設定する", action: "do3", tone: "primary" },
            { label: "今はいい", action: "stop", tone: "ghost" },
          ]),
        );
        break;

      default:
        break;
    }
  };

  // 会話中は今アクティブなカテゴリー以外への切り替えを禁止する。応答が同じ
  // スレッドに割り込んで別カテゴリーの定型メッセージと混ざるのを防ぐため。
  // 「会話中」の定義:
  //   - sending: 実APIの応答待ち〜タイプライター演出完了まで
  //   - pendingTimer: モックデモのsaiYes疑似処理中(setTimeout待ち)
  //   - awaitingUserDecision: 直前のAIメッセージにまだ選ばれていないチップが
  //     残っている(＝「1番をやる」等のデモ会話がまだ途中で、ユーザーの選択待ち)
  // いずれかがtrueの間はロックし、"stop"等の終端メッセージ(チップなし)に
  // 達するか、実APIの応答が完了すると自動的に解放される。
  const lastMsg = msgs[msgs.length - 1];
  const awaitingUserDecision =
    !!lastMsg && lastMsg.role === "ai" && !!lastMsg.chips && lastMsg.chips.length > 0 && !lastMsg.chipsUsed;
  const busy = sending || pendingTimer || awaitingUserDecision;

  // ボタン側のdisabledで大半は弾かれるが、ここでも二重に防御する。
  const handleCategory = (key: string) => {
    if (busy && key !== active) return;
    setActive(key);
    if (key === "weekly") {
      push(me("今週のまとめを見せて"));
      push({ id: nextId(), role: "ai", card: { kind: "analytics" } }, say("先週より会話は増えています。改善候補は3件、上から順にやると効果的です。", [
        { label: "1番をやる", action: "do1", tone: "primary" },
      ]));
    } else if (key === "history") {
      push(me("最近の会話を教えて"));
      push(say("直近142件のうち、AIが答えに困ったのは11件でした。そのうち9件が「送料」に関する質問です。まずここを直しますか？", [
        { label: "送料を直す", action: "do1", tone: "primary" },
      ]));
    } else if (key === "knowledge") {
      // Phase E: get_faq_list/get_knowledge_gaps(実API)に接続。以前はモック固定文言だった
      void sendReal("知識データの状況を教えて（FAQの件数と、AIが答えられなかった質問があれば教えて）");
    } else if (key === "rules") {
      // Phase B: get_tuning_rules(実API)に接続。以前はモック固定文言だった
      void sendReal("指示ルールの状況を教えて");
    } else if (key === "avatar") {
      push(me("アバターの状況を見せて"));
      push(say("アバターは稼働中です。今週は142件の会話のうち98件でアバターが応答しました(平均応答時間1.8秒)。夜21時台の離脱がやや多いので、声がけを1つ追加すると引き止められそうです。設定しますか？", [
        { label: "設定する", action: "do3", tone: "primary" },
        { label: "あとで", action: "later", tone: "ghost" },
      ]));
    }
  };

  // Phase1: 自由入力は実APIに接続（sendReal）。チップ操作は引き続きスクリプト化されたモック。
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
            <ProgressPill done={done} total={3} />
          </div>
        </header>

        {/* スレッド */}
        <div ref={threadRef} style={{ flex: 1, overflowY: "auto", padding: "28px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
            {msgs.map((m) => (
              <MessageRow key={m.id} m={m} onChip={runAction} done={done} />
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
              ここだけ実際の R2Cエージェント（指示ルール作成）に接続されています。要ログイン。
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
      PROTOTYPE ・ 起動時ブリーフィング＋下の入力欄は実API接続。チップのデモ部分のみモック
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

function ProgressPill({ done, total }: { done: number; total: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13.5, color: "var(--muted-foreground)" }}>
      <span>今週の改善 <strong style={{ color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>{done}/{total}</strong></span>
      <span style={{ display: "flex", gap: 4 }}>
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} style={{ width: 20, height: 6, borderRadius: 3, background: i < done ? "#22c55e" : "var(--border)" }} />
        ))}
      </span>
    </div>
  );
}

function MessageRow({ m, onChip }: { m: Msg; onChip: (a: string, id: number, label: string) => void; done: number }) {
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
              onClick={() => onChip(c.action, m.id, c.label)}
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
    case "briefing":
      return (
        <CardShell tone="brand" hd={<><span>📊</span>今週のまとめ<span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: "#b45309" }}>7日間</span></>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Stat n="142" label="件の会話（先週比 +18%）" />
            <Stat n="8" label="件の成約 ・ ¥96,000" />
            <Stat n="11" label="件、AIが答えられなかった質問" crit />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 6 }}>
            <Todo i="1" text="「送料はいくら？」に9人が困っていました。" g="答えを教えれば解決します" />
            <Todo i="2" text="丁寧すぎて長い、という反応が増加。" g="少し短く話す設定にできます" />
            <Todo i="3" text="夜21時台の離脱が多め。" g="声がけを1つ足すと拾えます" />
          </div>
        </CardShell>
      );
    case "analytics":
      return (
        <CardShell tone="agent" hd={<><span>📈</span>会話分析 ・ 今週の要約</>}>
          <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
            <Kpi n="142" label="会話数" sub="+18%" />
            <Kpi n="82" label="応答品質" sub="/100" />
            <Kpi n="8" label="成約" sub="¥96,000" />
            <Kpi n="11" label="未回答" sub="要対応" crit />
          </div>
          <div style={{ fontSize: 15, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
            数字の羅列ではなく、<strong style={{ color: "var(--foreground)" }}>「で、何を直すか」</strong>まで私がご提案します。
          </div>
        </CardShell>
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
    case "sai":
      return (
        <CardShell tone="agent" hd={<><span>🤖</span>R2Cが代わりに直しました</>}
          foot={<CardActionsNote note="画面を見て、これで良ければOKを押してください。" />}>
          <Field k="依頼" v={card.request} />
          <Screenshot url={card.url} />
          <Field k="結果" v={card.result} />
        </CardShell>
      );
    case "success":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 12, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.28)", color: "var(--foreground)", fontSize: 15 }}>
          <span style={{ fontSize: 17 }}>✅</span>{card.text}
        </div>
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

function Stat({ n, label, crit }: { n: string; label: string; crit?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 15 }}>
      <b style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: 17, color: crit ? "#dc2626" : "var(--foreground)" }}>{n}</b>
      <span style={{ color: "var(--muted-foreground)" }}>{label}</span>
    </div>
  );
}

function Kpi({ n, label, sub, crit }: { n: string; label: string; sub: string; crit?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: crit ? "#dc2626" : "var(--foreground)", lineHeight: 1.15 }}>{n}</div>
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>{label} <span style={{ opacity: 0.7 }}>{sub}</span></div>
    </div>
  );
}

function Todo({ i, text, g }: { i: string; text: string; g: string }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px dashed var(--border)", fontSize: 14.5, alignItems: "flex-start" }}>
      <span style={{ fontFamily: "var(--font-mono, monospace)", fontWeight: 700, color: AGENT, fontSize: 14 }}>{i}</span>
      <span style={{ color: "var(--foreground)" }}>{text}<span style={{ color: "var(--muted-foreground)", fontSize: 13.5 }}> → {g}</span></span>
    </div>
  );
}

function Screenshot({ url }: { url: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 12px", background: "var(--muted, rgba(120,120,140,0.1))", borderBottom: "1px solid var(--border)" }}>
        <i style={{ width: 9, height: 9, borderRadius: "50%", background: "#e0697c", display: "inline-block" }} />
        <i style={{ width: 9, height: 9, borderRadius: "50%", background: "#eeb84c", display: "inline-block" }} />
        <i style={{ width: 9, height: 9, borderRadius: "50%", background: "#4bbd83", display: "inline-block" }} />
        <span style={{ marginLeft: 9, fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</span>
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ height: 11, width: "55%", borderRadius: 5, background: "var(--muted, rgba(120,120,140,0.15))" }} />
        <div style={{ height: 11, width: "88%", borderRadius: 5, background: "var(--muted, rgba(120,120,140,0.15))" }} />
        <div style={{ height: 11, width: "66%", borderRadius: 5, background: "rgba(34,197,94,0.18)", border: "1px solid rgba(34,197,94,0.5)" }} />
        <div style={{ height: 11, width: "40%", borderRadius: 5, background: "var(--muted, rgba(120,120,140,0.15))" }} />
      </div>
    </div>
  );
}
