import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FileUpload from "../../../components/admin/FileUpload";
import { API_BASE } from "../../../lib/api";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface BookMetadata {
  id: string;
  title: string;
  author: string;
  totalPages: number;
  totalChunks: number;
  uploadedAt: number;
}

interface KnowledgeItem {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  created_at: string;
}

interface FaqEntry {
  question: string;
  answer: string;
}

interface OcrJobStatus {
  status: "processing" | "done" | "failed";
  pages?: number;
  chunks?: number;
  error?: string;
}

type Tab = "list" | "text" | "scrape";
type DeleteState = "idle" | "confirming" | "deleting" | "success" | "error";
type Category = "inventory" | "campaign" | "coupon" | "store_info";

const TENANT = "carnation";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "inventory", label: "在庫・車両情報" },
  { value: "campaign", label: "キャンペーン・セール" },
  { value: "coupon", label: "クーポン・割引" },
  { value: "store_info", label: "店舗情報・アクセス" },
];

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function getAccessToken(): string | null {
  const raw = localStorage.getItem("supabaseSession");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
  } catch {
    localStorage.removeItem("supabaseSession");
    return null;
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

const BTN_PRIMARY: React.CSSProperties = {
  padding: "16px 24px",
  minHeight: 56,
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
  color: "#022c22",
  fontSize: 17,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
};

const BTN_DANGER: React.CSSProperties = {
  padding: "10px 16px",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid #7f1d1d",
  background: "rgba(127,29,29,0.2)",
  color: "#fca5a5",
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 500,
};

const TEXTAREA_STYLE: React.CSSProperties = {
  width: "100%",
  minHeight: 180,
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};

const SELECT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  minHeight: 48,
};

// ─── タブ1: ナレッジ一覧 ────────────────────────────────────────────────────

function KnowledgeListTab() {
  const navigate = useNavigate();
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    question: string;
    state: DeleteState;
    error?: string;
  } | null>(null);

  const fetchItems = useCallback(async () => {
    const token = getAccessToken();
    if (!token) { navigate("/login", { replace: true }); return; }

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ tenant: TENANT });
      if (categoryFilter !== "all") params.set("category", categoryFilter);

      const res = await fetch(`${API_BASE}/v1/admin/knowledge?${params}`, {
        headers: authHeaders(token),
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("supabaseSession");
        navigate("/login", { replace: true });
        return;
      }
      if (!res.ok) throw new Error("読み込みに失敗しました。もう一度お試しください 🙏");
      const data = (await res.json()) as { items: KnowledgeItem[] };
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, [navigate, categoryFilter]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const token = getAccessToken();
    if (!token) { navigate("/login", { replace: true }); return; }

    setDeleteTarget((prev) => prev ? { ...prev, state: "deleting" } : null);
    try {
      const res = await fetch(
        `${API_BASE}/v1/admin/knowledge/${deleteTarget.id}?tenant=${TENANT}`,
        { method: "DELETE", headers: authHeaders(token) }
      );
      if (!res.ok) throw new Error("削除に失敗しました。もう一度お試しください 🙏");
      setDeleteTarget((prev) => prev ? { ...prev, state: "success" } : null);
      setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
      setTimeout(() => setDeleteTarget(null), 2000);
    } catch (err) {
      setDeleteTarget((prev) =>
        prev ? { ...prev, state: "error", error: err instanceof Error ? err.message : "エラーが発生しました" } : null
      );
    }
  };

  const categoryLabel = (cat: string | null) => {
    const found = CATEGORIES.find((c) => c.value === cat);
    return found ? found.label : cat ?? "未分類";
  };

  return (
    <div>
      {/* フィルター */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 14, color: "#9ca3af" }}>カテゴリ絞り込み:</span>
        {[{ value: "all", label: "すべて" }, ...CATEGORIES].map((c) => (
          <button
            key={c.value}
            onClick={() => setCategoryFilter(c.value)}
            style={{
              padding: "6px 14px",
              minHeight: 36,
              borderRadius: 999,
              border: `1px solid ${categoryFilter === c.value ? "#22c55e" : "#374151"}`,
              background: categoryFilter === c.value ? "rgba(34,197,94,0.15)" : "transparent",
              color: categoryFilter === c.value ? "#4ade80" : "#9ca3af",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        ))}
        <button
          onClick={fetchItems}
          disabled={loading}
          style={{
            marginLeft: "auto",
            padding: "6px 14px",
            minHeight: 36,
            borderRadius: 999,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 13,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "読み込み中..." : "🔄 更新"}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込んでいます...
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", borderRadius: 14, border: "1px dashed #374151", background: "rgba(15,23,42,0.4)" }}>
          <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>📭</span>
          <p style={{ fontSize: 16, fontWeight: 600, color: "#d1d5db", margin: 0 }}>
            まだナレッジが登録されていません
          </p>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6, marginBottom: 0 }}>
            「テキスト入力」または「URLから取得」タブで情報を登録してください
          </p>
        </div>
      ) : (
        <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid #111827", fontSize: 13, color: "#6b7280" }}>
            {items.length}件のナレッジ
          </div>
          {items.map((item, idx) => (
            <div
              key={item.id}
              style={{
                padding: "16px 18px",
                borderBottom: idx === items.length - 1 ? "none" : "1px solid #111827",
                display: "flex",
                gap: 14,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                  <span style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(34,197,94,0.1)",
                    border: "1px solid rgba(34,197,94,0.2)",
                    color: "#4ade80",
                    fontSize: 11,
                    fontWeight: 600,
                  }}>
                    {categoryLabel(item.category)}
                  </span>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>{formatDate(item.created_at)}</span>
                </div>
                <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 4px", lineHeight: 1.4 }}>
                  Q: {item.question}
                </p>
                <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, lineHeight: 1.5 }}>
                  A: {item.answer.slice(0, 120)}{item.answer.length > 120 ? "…" : ""}
                </p>
              </div>
              <button
                onClick={() => setDeleteTarget({ id: item.id, question: item.question, state: "confirming" })}
                style={BTN_DANGER}
              >
                削除
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 削除確認ダイアログ */}
      {deleteTarget && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}
          onClick={(e) => { if (e.target === e.currentTarget && deleteTarget.state !== "deleting") setDeleteTarget(null); }}
        >
          <div style={{ background: "#0f172a", border: "1px solid #1f2937", borderRadius: 16, padding: "28px 24px", maxWidth: 420, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,0.6)" }}>
            {deleteTarget.state === "success" ? (
              <div style={{ textAlign: "center" }}>
                <span style={{ fontSize: 48, display: "block", marginBottom: 12 }}>✅</span>
                <p style={{ fontSize: 17, fontWeight: 600, color: "#4ade80", margin: 0 }}>削除しました</p>
              </div>
            ) : (
              <>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>本当に削除しますか？</h3>
                <p style={{ fontSize: 14, color: "#d1d5db", margin: "0 0 6px" }}>Q: {deleteTarget.question}</p>
                <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 20px", lineHeight: 1.6 }}>
                  削除するとAIがこの情報を参照できなくなります。この操作は取り消せません。
                </p>
                {deleteTarget.state === "error" && deleteTarget.error && (
                  <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "rgba(127,29,29,0.4)", color: "#fca5a5", fontSize: 14 }}>
                    {deleteTarget.error}
                  </div>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleteTarget.state === "deleting"}
                    style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 10, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
                  >
                    やめる
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleteTarget.state === "deleting"}
                    style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 10, border: "none", background: "linear-gradient(135deg, #991b1b, #dc2626)", color: "#fee2e2", fontSize: 15, fontWeight: 700, cursor: deleteTarget.state === "deleting" ? "not-allowed" : "pointer" }}
                  >
                    {deleteTarget.state === "deleting" ? "削除中..." : "削除する"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── タブ2: テキスト入力（LLM自動FAQ化） ────────────────────────────────────

function TextInputTab() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category>("inventory");
  const [converting, setConverting] = useState(false);
  const [preview, setPreview] = useState<FaqEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const handleConvert = async () => {
    const token = getAccessToken();
    if (!token) { navigate("/login", { replace: true }); return; }
    if (text.trim().length < 10) {
      setError("10文字以上のテキストを入力してください");
      return;
    }

    setConverting(true);
    setError(null);
    setPreview(null);
    setSuccess(null);

    try {
      const res = await fetch(`${API_BASE}/v1/admin/knowledge/text?tenant=${TENANT}`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), category }),
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("supabaseSession");
        navigate("/login", { replace: true });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; preview?: FaqEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "変換に失敗しました");
      setPreview(data.preview ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました。もう一度お試しください 🙏");
    } finally {
      setConverting(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) return;
    const token = getAccessToken();
    if (!token) { navigate("/login", { replace: true }); return; }

    setCommitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/admin/knowledge/text/commit?tenant=${TENANT}`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ faqs: preview, category }),
      });
      const data = (await res.json()) as { ok?: boolean; inserted?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "登録に失敗しました");
      setSuccess(`✅ ${data.inserted}件のFAQをAIナレッジに登録しました！`);
      setPreview(null);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました。もう一度お試しください 🙏");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>
          情報を貼り付けてください
        </h3>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px", lineHeight: 1.6 }}>
          在庫情報・キャンペーン内容・クーポン情報など、AIに覚えさせたいテキストを貼り付けてください。
          AIが自動でよくある質問と回答に変換します。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例：2024年式 トヨタ プリウス 走行距離3万km、車体色シルバー、修復歴なし、車検2年付き、価格198万円..."
          style={TEXTAREA_STYLE}
        />
      </div>

      <div style={CARD_STYLE}>
        <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 8 }}>
          情報のカテゴリを選んでください
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          style={SELECT_STYLE}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {success && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(5,46,22,0.6)", border: "1px solid rgba(74,222,128,0.3)", color: "#86efac", fontSize: 15 }}>
          {success}
        </div>
      )}

      {!preview && (
        <button
          onClick={handleConvert}
          disabled={converting || text.trim().length < 10}
          style={{
            ...BTN_PRIMARY,
            opacity: converting || text.trim().length < 10 ? 0.6 : 1,
            cursor: converting || text.trim().length < 10 ? "not-allowed" : "pointer",
          }}
        >
          {converting ? "⏳ AIが変換中です..." : "🤖 AIで自動変換する"}
        </button>
      )}

      {/* プレビュー */}
      {preview && preview.length > 0 && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
            変換結果 — {preview.length}件のFAQが生成されました
          </h3>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
            内容を確認して「登録する」ボタンを押してください。
          </p>
          <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden", marginBottom: 16 }}>
            {preview.map((faq, idx) => (
              <div
                key={idx}
                style={{
                  padding: "16px 18px",
                  borderBottom: idx === preview.length - 1 ? "none" : "1px solid #111827",
                }}
              >
                <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 6px" }}>
                  Q: {faq.question}
                </p>
                <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, lineHeight: 1.5 }}>
                  A: {faq.answer}
                </p>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setPreview(null)}
              style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 12, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              やり直す
            </button>
            <button
              onClick={handleCommit}
              disabled={committing}
              style={{ ...BTN_PRIMARY, flex: 2, width: "auto", opacity: committing ? 0.6 : 1 }}
            >
              {committing ? "⏳ 登録中..." : "✅ この内容で登録する"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── タブ3: URLスクレイプ ────────────────────────────────────────────────────

function ScrapeTab() {
  const navigate = useNavigate();
  const [urls, setUrls] = useState("");
  const [category, setCategory] = useState<Category>("store_info");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ url: string; ok: boolean; count?: number; error?: string }[] | null>(null);

  const handleScrape = async () => {
    const token = getAccessToken();
    if (!token) { navigate("/login", { replace: true }); return; }

    const urlList = urls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urlList.length === 0) {
      setError("URLを1行に1つずつ入力してください");
      return;
    }
    if (urlList.length > 5) {
      setError("一度に処理できるURLは最大5件です");
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const res = await fetch(`${API_BASE}/v1/admin/knowledge/scrape?tenant=${TENANT}`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlList, category }),
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("supabaseSession");
        navigate("/login", { replace: true });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; results?: typeof results; error?: string };
      if (!res.ok) throw new Error(data.error ?? "取得に失敗しました");
      setResults(data.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました。もう一度お試しください 🙏");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>
          WebサイトのURLを入力してください
        </h3>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px", lineHeight: 1.6 }}>
          1行に1つのURLを入力してください（最大5件）。
          AIがページの内容を読み取り、FAQに変換して登録します。
        </p>
        <textarea
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder={"https://example.com/campaign\nhttps://example.com/store"}
          style={{ ...TEXTAREA_STYLE, minHeight: 120, fontFamily: "monospace" }}
        />
      </div>

      <div style={CARD_STYLE}>
        <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 8 }}>
          情報のカテゴリを選んでください
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          style={SELECT_STYLE}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ padding: "20px", textAlign: "center", ...CARD_STYLE }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          <p style={{ fontSize: 15, color: "#93c5fd", margin: 0 }}>
            AIがページを読み取り中です... しばらくお待ちください
          </p>
        </div>
      )}

      {!loading && (
        <button
          onClick={handleScrape}
          disabled={urls.trim().length === 0}
          style={{
            ...BTN_PRIMARY,
            opacity: urls.trim().length === 0 ? 0.6 : 1,
            cursor: urls.trim().length === 0 ? "not-allowed" : "pointer",
          }}
        >
          🌐 取得して登録する
        </button>
      )}

      {results && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: "#f9fafb", margin: "0 0 12px" }}>
            処理結果
          </h3>
          <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden" }}>
            {results.map((r, idx) => (
              <div
                key={idx}
                style={{
                  padding: "14px 18px",
                  borderBottom: idx === results.length - 1 ? "none" : "1px solid #111827",
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>{r.ok ? "✅" : "⚠️"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.url}
                  </p>
                  <p style={{ fontSize: 14, color: r.ok ? "#4ade80" : "#fca5a5", margin: 0 }}>
                    {r.ok ? `${r.count}件のFAQを登録しました` : r.error ?? "取得に失敗しました"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PDFアップロードセクション（既存機能） ────────────────────────────────────

function PdfSection() {
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<OcrJobStatus | null>(null);
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBooks = useCallback(async () => {
    const token = getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/v1/admin/knowledge?tenant=${TENANT}`, {
        headers: authHeaders(token),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: unknown[]; count?: number };
      setBooks((data.items ?? []) as BookMetadata[]);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { fetchBooks(); }, [fetchBooks]);

  useEffect(() => {
    if (!currentJobId) return;
    const poll = async () => {
      const token = getAccessToken();
      if (!token) return;
      try {
        const res = await fetch(`${API_BASE}/v1/admin/knowledge/jobs/${currentJobId}`, {
          headers: authHeaders(token),
        });
        if (!res.ok) return;
        const data = (await res.json()) as OcrJobStatus;
        setJobStatus(data);
        if (data.status === "done" || data.status === "failed") {
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
          setCurrentJobId(null);
          if (data.status === "done") fetchBooks();
        }
      } catch {
        // ignore
      }
    };
    void poll();
    pollingRef.current = setInterval(() => void poll(), 10_000);
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [currentJobId, fetchBooks]);

  return (
    <div style={{ ...CARD_STYLE, marginBottom: 24 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: "0 0 12px" }}>
        PDF資料のアップロード（OCR）
      </h3>
      <FileUpload
        uploadEndpoint="/v1/admin/knowledge/pdf"
        onUploadSuccess={(name) => { setUploadSuccess(name); setTimeout(() => setUploadSuccess(null), 5000); }}
        onUploadResponse={(data) => {
          const d = data as { jobId?: string } | null;
          if (d?.jobId) { setJobStatus({ status: "processing" }); setCurrentJobId(d.jobId); }
        }}
      />
      {uploadSuccess && (
        <div style={{ marginTop: 10, padding: "12px 16px", borderRadius: 10, background: "rgba(5,46,22,0.5)", border: "1px solid rgba(74,222,128,0.3)", color: "#86efac", fontSize: 14 }}>
          ✅ 「{uploadSuccess}」を受け付けました！AIが内容の確認を開始しました。
        </div>
      )}
      {jobStatus && (
        <div style={{
          marginTop: 10, padding: "12px 16px", borderRadius: 10, fontSize: 14,
          border: `1px solid ${jobStatus.status === "done" ? "rgba(74,222,128,0.3)" : jobStatus.status === "failed" ? "rgba(248,113,113,0.3)" : "rgba(96,165,250,0.3)"}`,
          background: jobStatus.status === "done" ? "rgba(5,46,22,0.5)" : jobStatus.status === "failed" ? "rgba(127,29,29,0.4)" : "rgba(23,37,84,0.5)",
          color: jobStatus.status === "done" ? "#86efac" : jobStatus.status === "failed" ? "#fca5a5" : "#93c5fd",
        }}>
          {jobStatus.status === "processing" && "⏳ AIが書籍を読み込み中です..."}
          {jobStatus.status === "done" && `✅ OCR完了！ ${jobStatus.pages}ページ / ${jobStatus.chunks}チャンク追加`}
          {jobStatus.status === "failed" && `⚠️ 失敗しました。${jobStatus.error ?? "再試行してください。"}`}
        </div>
      )}
      {books.length > 0 && (
        <p style={{ fontSize: 12, color: "#6b7280", margin: "10px 0 0" }}>
          登録済みPDF: {books.length}件
        </p>
      )}
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────────────

export default function KnowledgePage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("list");

  useEffect(() => {
    const token = getAccessToken();
    if (!token) navigate("/login", { replace: true });
  }, [navigate]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "list", label: "ナレッジ一覧", icon: "📋" },
    { id: "text", label: "テキスト入力", icon: "✏️" },
    { id: "scrape", label: "URLから取得", icon: "🌐" },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <button
          onClick={() => navigate("/admin")}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 0", border: "none", background: "none", color: "#9ca3af", fontSize: 13, cursor: "pointer", marginBottom: 8 }}
        >
          ← ダッシュボードに戻る
        </button>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
          ナレッジ管理
        </h1>
        <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
          在庫・キャンペーン・クーポン情報を登録してAIに覚えさせましょう
        </p>
      </header>

      {/* PDFアップロード */}
      <PdfSection />

      {/* タブ */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: "1px solid #1f2937" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "12px 20px",
              minHeight: 48,
              border: "none",
              borderBottom: `2px solid ${activeTab === tab.id ? "#22c55e" : "transparent"}`,
              background: "transparent",
              color: activeTab === tab.id ? "#4ade80" : "#9ca3af",
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 700 : 500,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "color 0.15s",
            }}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* タブコンテンツ */}
      {activeTab === "list" && <KnowledgeListTab />}
      {activeTab === "text" && <TextInputTab />}
      {activeTab === "scrape" && <ScrapeTab />}
    </div>
  );
}
