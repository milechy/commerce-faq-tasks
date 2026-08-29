// admin-ui/src/pages/admin/author-loop/index.tsx
// GID 1217968284736841 (T9): 著者(赤嶺哲也氏)専用画面。
//
// 目的: 「自分の教えがどう使われたか」を会話1件ずつ読み、違うと思ったら直しに行ける。
// 決定事項(オーケストレータ指示、再検討しない):
//  - 対象は全テナントの会話。会話本文も見せる(伏せない)
//  - 「使われた」(注入=確実)までに留め、「効いた」(成約=相関)とは混ぜない → CV数値は出さない
//  - 会話を主語にし、一度に1つのことだけ尋ねる(はい/いいえ/あとで)。12件並べて選ばせない
//  - 直せる導線は既存のチャンク編集画面(BookChunksPanel)へ。再実装しない
//  - D: 専用画面を1枚だけ新設する例外。バックエンドは新設しない(既存2エンドポイントを流用)
//
// 新しいバックエンドエンドポイントを作らない方針のため、はい/いいえ/あとでの回答は
// サーバーに保存しない。「確認済み」はこのブラウザだけで覚える(localStorage)。
// 他端末では再度出るが、この画面の目的(著者が実際の使われ方を継続的に眺める)には
// これで足り、そのためだけに新しいテーブル/エンドポイントを増やさない判断とした。

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";

// ─── 型定義(バックエンドのレスポンス形をこのファイルだけで再宣言する。
//     admin-ui は別パッケージのためバックエンド型を直接importしない、既存の
//     chat-history/types.ts と同じ流儀) ────────────────────────────────────

interface RagSourceDto {
  chunk_id: string;
  source: "faq" | "book";
  score: number;
  principle?: string;
  retrieved?: boolean;
  injected?: boolean;
}

interface SessionSummaryDto {
  id: string;
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
}

interface ChatMessageDto {
  id: number;
  role: "user" | "assistant" | "operator";
  content: string;
  created_at: string;
  rag_sources?: RagSourceDto[] | null;
}

/** 「この会話に、この教えが使われた」1件 = レビューキューの1枚。 */
interface ReviewItem {
  key: string; // `${session.id}:${message.id}:${chunk_id}`
  session: SessionSummaryDto;
  messages: ChatMessageDto[]; // 会話本文(全メッセージ)
  highlightMessageId: number; // 教えを使った応答メッセージ
  principle: string; // 教え(打ち手)そのもの
}

// 直近{RECENT_SESSIONS_LIMIT}件の会話を対象にする。全テナント横断のため無制限にすると
// 画面表示のたびに大量のメッセージ取得が走る。著者が見たいのは「最近の実践」であり、
// 既存の会話一覧(GET .../sessions)がデフォルトで持つ並び順(最新順)をそのまま使う。
const RECENT_SESSIONS_LIMIT = 50;

// 母数が少ないうちから「対象0件」のような架空の判断材料を出さない。
// KnowledgeAttributionTab.tsx / ruleEffect.ts と同じ基準(5件)に揃える
// (admin-ui/CLAUDE.md「同じ値が面によって違って見えてはならない」)。
export const MIN_CONVERSATIONS_FOR_REVIEW = 5;

const STORAGE_KEY = "r2c_author_loop_reviewed_v1";

function loadReviewed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveReviewed(keys: Set<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    // ブラウザのストレージ制限などで保存できなくても画面は使えるため無視する
  }
}

// ─── スタイル(KnowledgeAttributionTab.tsx と揃える) ──────────────────────────

const CARD: CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px",
};

const BUTTON_BASE: CSSProperties = {
  padding: "10px 20px",
  minHeight: 44,
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid transparent",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** rag_sources から「教えとして使われた(injected)」ものだけを抜き出す。 */
function injectedPrinciplesOf(msg: ChatMessageDto): { principle: string }[] {
  if (!msg.rag_sources) return [];
  return msg.rag_sources
    .filter((s) => s.injected === true && typeof s.principle === "string" && s.principle.trim().length > 0)
    .map((s) => ({ principle: s.principle as string }));
}

function buildReviewItems(
  sessions: SessionSummaryDto[],
  messagesBySession: Map<string, ChatMessageDto[]>,
): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const session of sessions) {
    const messages = messagesBySession.get(session.id);
    if (!messages) continue;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const { principle } of injectedPrinciplesOf(msg)) {
        items.push({
          key: `${session.id}:${msg.id}:${principle}`,
          session,
          messages,
          highlightMessageId: msg.id,
          principle,
        });
      }
    }
  }
  return items;
}

// ─── コンポーネント本体 ───────────────────────────────────────────────────────

export default function AuthorLoopPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(() => loadReviewed());
  const [cursor, setCursor] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sessionsRes = await authFetch(
        `${API_BASE}/v1/admin/chat-history/sessions?limit=${RECENT_SESSIONS_LIMIT}&sort_by=last_message_at&sort_order=desc`,
      );
      if (!sessionsRes.ok) {
        const body = await sessionsRes.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${sessionsRes.status}`);
      }
      const sessionsJson = (await sessionsRes.json()) as { sessions: SessionSummaryDto[] };
      const sessions = sessionsJson.sessions ?? [];

      const messagesBySession = new Map<string, ChatMessageDto[]>();
      await Promise.all(
        sessions.map(async (session) => {
          const res = await authFetch(`${API_BASE}/v1/admin/chat-history/sessions/${session.id}/messages`);
          if (!res.ok) return; // 1件の取得失敗で画面全体を止めない
          const json = (await res.json()) as { messages: ChatMessageDto[] };
          messagesBySession.set(session.id, json.messages ?? []);
        }),
      );

      setReviewItems(buildReviewItems(sessions, messagesBySession));
      setCursor(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remainingItems = useMemo(
    () => reviewItems.filter((item) => !reviewed.has(item.key)),
    [reviewItems, reviewed],
  );

  const currentItem = remainingItems[Math.min(cursor, remainingItems.length - 1)] ?? null;

  // remainingItems は reviewed から derive されるため、ここで対象を追加するだけで
  // 次のレンダーでは自動的に1件詰まる(同じ cursor が次の未確認項目を指す)。
  const markReviewed = (key: string) => {
    setReviewed((prev) => {
      const next = new Set(prev);
      next.add(key);
      saveReviewed(next);
      return next;
    });
  };

  const skipForNow = () => {
    setCursor((c) => (c + 1 >= remainingItems.length ? 0 : c + 1));
  };

  const handleAnswer = (answer: "yes" | "no" | "later") => {
    if (!currentItem) return;
    if (answer === "later") {
      setToast(null);
      skipForNow();
      return;
    }
    if (answer === "yes") {
      setToast("確認しました");
      markReviewed(currentItem.key);
      setTimeout(() => setToast(null), 3000);
      return;
    }
    // answer === "no": 押しても何も起きない「報告ボタン」にはしない。
    // 判断はどこにも届かないため、実際に直せる画面(既存のチャンク編集画面)へ
    // その場で連れて行く。この会話はこのブラウザでは確認済み扱いにして良い
    // (著者はこの後、教え自体を直しに行くため)。
    markReviewed(currentItem.key);
    navigate("/admin/knowledge/global?tab=pdf");
  };

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f9fafb", marginBottom: 6 }}>
        あなたの教えの実践
      </h1>
      <p style={{ fontSize: 14, color: "#9ca3af", marginBottom: 24, lineHeight: 1.6 }}>
        お店からの相談に、あなたの本の教えが使われた会話を1件ずつ確認できます。
        「はい」「使われ方が違う（直しに行く）」「あとで」のどれかを選ぶだけで進みます。
        「使われ方が違う」を選ぶと、その場で教えを直す画面に移動します。
      </p>

      {loading && <p style={{ color: "#9ca3af" }}>読み込み中…</p>}
      {error && <p style={{ color: "#fca5a5", fontSize: 14 }}>エラー: {error}</p>}

      {!loading && !error && reviewItems.length < MIN_CONVERSATIONS_FOR_REVIEW && (
        <div style={CARD}>
          <p style={{ margin: 0, color: "#e5e7eb", fontSize: 15, lineHeight: 1.7 }}>
            まだ判断できる会話数がありません（現在{reviewItems.length}件。あと
            {Math.max(0, MIN_CONVERSATIONS_FOR_REVIEW - reviewItems.length)}件で見られます）
          </p>
        </div>
      )}

      {!loading && !error && reviewItems.length >= MIN_CONVERSATIONS_FOR_REVIEW && remainingItems.length === 0 && (
        <div style={CARD}>
          <p style={{ margin: 0, color: "#e5e7eb", fontSize: 15, lineHeight: 1.7 }}>
            たまっている会話はすべて確認済みです。新しい会話が増えたらまたお知らせします。
          </p>
        </div>
      )}

      {!loading && !error && currentItem && (
        <div>
          <p style={{ fontSize: 13, color: "#9ca3af", marginBottom: 10 }}>
            確認: {Math.min(cursor, remainingItems.length - 1) + 1} / {remainingItems.length}件
          </p>

          <div style={CARD}>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                marginBottom: 14,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, color: "#9ca3af" }}>
                {formatDate(currentItem.session.last_message_at)}
              </span>
            </div>

            <div
              style={{
                fontSize: 13,
                color: "#fbbf24",
                background: "rgba(251,191,36,0.1)",
                border: "1px solid rgba(251,191,36,0.3)",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: 14,
              }}
            >
              この教えを踏まえて答えました: {currentItem.principle}
            </div>

            <div
              style={{
                maxHeight: 360,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginBottom: 18,
                paddingRight: 4,
              }}
            >
              {currentItem.messages.map((msg) => {
                const isHighlighted = msg.id === currentItem.highlightMessageId;
                const roleLabel = msg.role === "user" ? "お客様" : msg.role === "operator" ? "スタッフ" : "AI";
                return (
                  <div
                    key={msg.id}
                    style={{
                      alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "85%",
                    }}
                  >
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>
                      {roleLabel} · {formatDate(msg.created_at)}
                    </div>
                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 12,
                        fontSize: 14,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        background: isHighlighted
                          ? "rgba(251,191,36,0.12)"
                          : msg.role === "user"
                          ? "rgba(37,99,235,0.18)"
                          : "rgba(31,41,55,0.9)",
                        border: isHighlighted ? "1px solid rgba(251,191,36,0.5)" : "1px solid var(--border, #374151)",
                        color: "#e5e7eb",
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => handleAnswer("yes")}
                style={{ ...BUTTON_BASE, background: "#16a34a", color: "#fff" }}
              >
                はい、この使い方でよい
              </button>
              <button
                type="button"
                onClick={() => handleAnswer("no")}
                style={{ ...BUTTON_BASE, background: "#dc2626", color: "#fff" }}
              >
                使われ方が違う（直しに行く）
              </button>
              <button
                type="button"
                onClick={() => handleAnswer("later")}
                style={{ ...BUTTON_BASE, background: "transparent", color: "#9ca3af", border: "1px solid #374151" }}
              >
                あとで
              </button>
            </div>

            {toast && <p style={{ fontSize: 13, color: "#4ade80", marginBottom: 8 }}>{toast}</p>}

            <a
              href="/admin/knowledge/global?tab=pdf"
              style={{ fontSize: 13, color: "#60a5fa", textDecoration: "underline" }}
            >
              この教えを直したい方はこちら
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
