// admin-ui/src/pages/admin/knowledge-gaps/index.tsx
// Phase46 Stream C: ナレッジの穴ダッシュボード + インラインナレッジ追加モーダル

import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import LangSwitcher from "../../../components/LangSwitcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeGap {
  id: number;
  tenant_id: string;
  user_question: string;
  session_id: string | null;
  rag_hit_count: number;
  rag_top_score: number;
  status: string;
  frequency: number | null;
  detection_source: string | null;
  recommended_action: string | null;
  suggested_answer: string | null;
  recommendation_status: string | null;
  last_detected_at: string | null;
  created_at: string;
}

type FilterTab = "all" | "pending" | "approved" | "resolved";

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

function DetectionBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const cfg: Record<string, { label: string; bg: string; border: string; color: string }> = {
    no_rag:         { label: "RAG検索なし",   bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)", color: "#f87171" },
    low_confidence: { label: "低信頼度",       bg: "rgba(251,191,36,0.15)",  border: "rgba(251,191,36,0.3)",  color: "#fbbf24" },
    fallback:       { label: "フォールバック応答", bg: "rgba(156,163,175,0.15)", border: "rgba(156,163,175,0.3)", color: "#9ca3af" },
    judge_low:      { label: "Judge低評価",   bg: "rgba(167,139,250,0.15)", border: "rgba(167,139,250,0.3)", color: "#a78bfa" },
  };
  const c = cfg[source] ?? { label: source, bg: "rgba(107,114,128,0.15)", border: "rgba(107,114,128,0.3)", color: "#9ca3af" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", padding: "2px 9px",
      borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: c.bg, border: `1px solid ${c.border}`, color: c.color, whiteSpace: "nowrap",
    }}>
      {c.label}
    </span>
  );
}

function RecStatusBadge({ status }: { status: string | null }) {
  const cfg: Record<string, { label: string; bg: string; border: string; color: string }> = {
    pending:  { label: "未対応",  bg: "rgba(251,146,60,0.15)",  border: "rgba(251,146,60,0.3)",  color: "#fb923c" },
    approved: { label: "承認済み", bg: "rgba(34,197,94,0.15)",   border: "rgba(34,197,94,0.3)",   color: "#4ade80" },
    dismissed:{ label: "却下",    bg: "rgba(107,114,128,0.15)", border: "rgba(107,114,128,0.3)", color: "#9ca3af" },
    resolved: { label: "解決済み", bg: "rgba(59,130,246,0.15)",  border: "rgba(59,130,246,0.3)",  color: "#60a5fa" },
  };
  const key = status ?? "pending";
  const c = cfg[key] ?? cfg["pending"]!;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", padding: "2px 9px",
      borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: c.bg, border: `1px solid ${c.border}`, color: c.color, whiteSpace: "nowrap",
    }}>
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add-Knowledge Modal
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { value: "", label: "カテゴリを選択（任意）" },
  { value: "inventory",    label: "📦 在庫・入荷" },
  { value: "campaign",     label: "🎉 キャンペーン" },
  { value: "coupon",       label: "🎫 クーポン" },
  { value: "store_info",   label: "🏪 店舗情報" },
  { value: "product_info", label: "🛍 商品情報" },
  { value: "pricing",      label: "💴 価格・料金" },
  { value: "booking",      label: "📅 予約・来店" },
  { value: "warranty",     label: "🔧 保証・修理" },
  { value: "general",      label: "💬 その他" },
];

interface ModalProps {
  gap: KnowledgeGap;
  onClose: () => void;
  onSuccess: (gapId: number) => void;
  onDismiss: (gapId: number) => void;
}

function AddKnowledgeModal({ gap, onClose, onSuccess, onDismiss }: ModalProps) {
  const [answerText, setAnswerText] = useState(gap.suggested_answer ?? "");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const INPUT_STYLE = {
    width: "100%",
    padding: "11px 14px",
    borderRadius: 10,
    border: "1px solid #374151",
    background: "rgba(15,23,42,0.8)",
    color: "#e5e7eb",
    fontSize: 14,
    boxSizing: "border-box",
  };

  const handleAddKnowledge = async () => {
    if (!answerText.trim()) {
      setError("回答テキストを入力してください。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge-gaps/${gap.id}/add-knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer_text: answerText.trim(),
          category: category || undefined,
          source_type: gap.suggested_answer ? "ai_suggested" : "manual",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "追加に失敗しました");
      }
      setSuccess(true);
      setTimeout(() => {
        onSuccess(gap.id);
        onClose();
      }, 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "追加できませんでした。もう一度お試しください。";
      setError(msg);
      setSaving(false);
    }
  };

  const handleDismiss = async () => {
    setDismissing(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge-gaps/${gap.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      if (!res.ok) throw new Error("却下に失敗しました");
      onDismiss(gap.id);
      onClose();
    } catch {
      setError("却下できませんでした。もう一度お試しください。");
      setDismissing(false);
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving && !dismissing) onClose(); }}
    >
      <div style={{
        background: "linear-gradient(145deg, #0f172a, #050d1a)",
        border: "1px solid #1f2937",
        borderRadius: 18,
        padding: "28px 24px",
        maxWidth: 560,
        width: "100%",
        maxHeight: "90vh",
        overflowY: "auto",
        boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>
            ナレッジを追加する
          </h2>
          <button
            onClick={onClose}
            disabled={saving || dismissing}
            style={{ background: "none", border: "none", color: "#6b7280", fontSize: 20, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {/* Gap info section */}
        <div style={{ padding: "16px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid #1f2937", marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <DetectionBadge source={gap.detection_source} />
            <RecStatusBadge status={gap.recommendation_status} />
          </div>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#f9fafb", lineHeight: 1.5, wordBreak: "break-word" }}>
            「{gap.user_question}」
          </p>
          {(gap.frequency ?? 0) > 1 && (
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#9ca3af" }}>
              この質問は <span style={{ color: "#fbbf24", fontWeight: 700 }}>{gap.frequency}回</span> 聞かれています
            </p>
          )}
        </div>

        {/* AI suggestion section */}
        {gap.recommended_action && (
          <div style={{ padding: "14px 16px", borderRadius: 12, background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.25)", marginBottom: 20 }}>
            <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, color: "#a78bfa", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              🤖 AI提案
            </p>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "#c4b5fd", lineHeight: 1.6 }}>
              {gap.recommended_action}
            </p>
            {gap.suggested_answer && (
              <>
                <p style={{ margin: "0 0 6px", fontSize: 12, color: "#7c3aed" }}>ドラフト回答:</p>
                <p style={{ margin: "0 0 12px", fontSize: 13, color: "#ddd6fe", lineHeight: 1.6, fontStyle: "italic" }}>
                  {gap.suggested_answer}
                </p>
                <button
                  onClick={() => setAnswerText(gap.suggested_answer ?? "")}
                  style={{ padding: "8px 14px", minHeight: 36, borderRadius: 8, border: "1px solid rgba(167,139,250,0.4)", background: "rgba(167,139,250,0.12)", color: "#c4b5fd", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  この提案を使う
                </button>
              </>
            )}
          </div>
        )}

        {/* Instruction text */}
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
          この質問への回答を入力すると、AIが次から自動で答えられるようになります。
        </p>

        {/* Answer textarea */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#d1d5db", marginBottom: 6 }}>
            回答テキスト <span style={{ color: "#f87171" }}>*</span>
          </label>
          <textarea
            value={answerText}
            onChange={(e) => setAnswerText(e.target.value)}
            placeholder="この質問に対して、AIにどう答えてほしいですか？"
            rows={5}
            style={{ ...INPUT_STYLE, resize: "vertical", lineHeight: 1.6 }}
          />
        </div>

        {/* Category select */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#d1d5db", marginBottom: 6 }}>
            カテゴリ（任意）
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={INPUT_STYLE}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        {/* Error */}
        {error && (
          <div style={{ marginBottom: 16, padding: "12px 14px", borderRadius: 10, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Success animation */}
        {success && (
          <div style={{ marginBottom: 16, padding: "14px", borderRadius: 10, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#4ade80", fontSize: 14, fontWeight: 600, textAlign: "center" }}>
            ✅ 追加しました！ナレッジベースに登録されました。
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => void handleAddKnowledge()}
            disabled={saving || dismissing || success}
            style={{
              flex: "1 1 160px",
              padding: "14px 20px",
              minHeight: 52,
              borderRadius: 12,
              border: "none",
              background: saving || success ? "rgba(34,197,94,0.3)" : "linear-gradient(135deg, #22c55e 0%, #4ade80 100%)",
              color: "#fff",
              fontSize: 16,
              fontWeight: 700,
              cursor: saving || success ? "not-allowed" : "pointer",
              boxShadow: "0 4px 15px rgba(34,197,94,0.3)",
              transition: "opacity 0.15s",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "追加中..." : success ? "追加済み ✅" : "ナレッジに追加"}
          </button>

          <button
            onClick={() => void handleDismiss()}
            disabled={saving || dismissing || success}
            style={{
              padding: "14px 16px",
              minHeight: 52,
              borderRadius: 12,
              border: "1px solid #374151",
              background: "rgba(15,23,42,0.8)",
              color: dismissing ? "#6b7280" : "#9ca3af",
              fontSize: 14,
              cursor: saving || dismissing || success ? "not-allowed" : "pointer",
            }}
          >
            {dismissing ? "..." : "却下"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all",      label: "すべて" },
  { key: "pending",  label: "未対応" },
  { key: "approved", label: "承認済み" },
  { key: "resolved", label: "解決済み" },
];

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";
const SELECT_STYLE = {
  padding: "10px 14px",
  minHeight: 40,
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 13,
  cursor: "pointer",
};

export default function KnowledgeGapsPage() {
  const navigate = useNavigate();
  const { user, isSuperAdmin, isClientAdmin } = useAuth();

  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>("pending");
  const [tenantFilter, setTenantFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [genToast, setGenToast] = useState<string | null>(null);
  const [selectedGap, setSelectedGap] = useState<KnowledgeGap | null>(null);

  const tenantId = isSuperAdmin ? undefined : (user?.tenantId ?? undefined);
  const effectiveTenant = isSuperAdmin ? (tenantFilter || undefined) : tenantId;

  // Map filter tab to API status param
  const apiStatus = activeTab === "resolved" ? "resolved" : "open";

  const fetchGaps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: apiStatus, sort: "frequency", limit: "100", offset: String(offset) });
      if (effectiveTenant) params.set("tenant_id", effectiveTenant);
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge-gaps?${params}`);
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json() as { gaps: KnowledgeGap[]; total: number };
      setGaps(data.gaps ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setError("データの取得に失敗しました。再試行してください。");
    } finally {
      setLoading(false);
    }
  }, [apiStatus, effectiveTenant, offset]);

  useEffect(() => {
    void fetchGaps();
  }, [fetchGaps]);

  // Client-side filter by recommendation_status
  const filteredGaps = useMemo(() => {
    if (activeTab === "all" || activeTab === "resolved") return gaps;
    return gaps.filter((g) => (g.recommendation_status ?? "pending") === activeTab);
  }, [gaps, activeTab]);

  const formatDate = (iso: string | null) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const handleGenerate = async () => {
    if (!effectiveTenant && !isSuperAdmin) return;
    const targetTenant = effectiveTenant ?? "";
    if (!targetTenant) {
      setGenToast("テナントを選択してから生成してください。");
      setTimeout(() => setGenToast(null), 3000);
      return;
    }
    setGenerating(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/knowledge-gaps/generate-recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: targetTenant }),
      });
      if (!res.ok) throw new Error("生成に失敗しました");
      const data = await res.json() as { count: number };
      setGenToast(`${data.count}件のAI提案を生成しました。`);
      setTimeout(() => setGenToast(null), 4000);
      void fetchGaps();
    } catch {
      setGenToast("AI提案の生成に失敗しました。");
      setTimeout(() => setGenToast(null), 3000);
    } finally {
      setGenerating(false);
    }
  };

  const handleModalSuccess = (gapId: number) => {
    setGaps((prev) => prev.map((g) => g.id === gapId ? { ...g, status: "resolved", recommendation_status: "resolved" } : g));
  };

  const handleModalDismiss = (gapId: number) => {
    setGaps((prev) => prev.map((g) => g.id === gapId ? { ...g, recommendation_status: "dismissed" } : g));
  };

  const pendingCount = gaps.filter((g) => (g.recommendation_status ?? "pending") === "pending").length;

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            ← ダッシュボードに戻る
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            📋 ナレッジの穴
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            AIが答えられなかった質問を管理し、ナレッジベースを強化します
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <LangSwitcher />
          {isSuperAdmin && (
            <button
              onClick={() => void handleGenerate()}
              disabled={generating}
              style={{
                padding: "10px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(167,139,250,0.4)",
                background: generating ? "rgba(167,139,250,0.05)" : "rgba(167,139,250,0.12)",
                color: "#c4b5fd",
                fontSize: 13,
                fontWeight: 600,
                cursor: generating ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {generating ? "⏳ 生成中..." : "🤖 AI提案を生成"}
            </button>
          )}
          <button
            onClick={() => { setOffset(0); void fetchGaps(); }}
            style={{ padding: "10px 16px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.8)", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
          >
            更新
          </button>
        </div>
      </header>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        {/* Status tabs */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTER_TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setOffset(0); }}
                style={{
                  padding: "8px 16px",
                  minHeight: 38,
                  borderRadius: 999,
                  border: `1px solid ${isActive ? "rgba(234,179,8,0.5)" : "#374151"}`,
                  background: isActive ? "rgba(234,179,8,0.12)" : "rgba(15,23,42,0.8)",
                  color: isActive ? "#fbbf24" : "#9ca3af",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {tab.label}
                {tab.key === "pending" && pendingCount > 0 && (
                  <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: "rgba(234,179,8,0.25)", fontSize: 11, fontWeight: 700 }}>
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tenant filter — super_admin only */}
        {isSuperAdmin && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "#9ca3af", whiteSpace: "nowrap" }}>テナント:</span>
            <input
              type="text"
              value={tenantFilter}
              onChange={(e) => { setTenantFilter(e.target.value); setOffset(0); }}
              placeholder="tenant_id で絞り込み"
              style={{ ...SELECT_STYLE, width: 200 }}
            />
          </div>
        )}
      </div>

      {/* Stats bar */}
      {!loading && (
        <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#6b7280" }}>
            合計 <span style={{ color: "#d1d5db", fontWeight: 700 }}>{total}</span> 件
            {filteredGaps.length !== total && (
              <> / 表示 <span style={{ color: "#d1d5db", fontWeight: 700 }}>{filteredGaps.length}</span> 件</>
            )}
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ marginBottom: 20, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span>{error}</span>
          <button onClick={() => void fetchGaps()} style={{ padding: "8px 14px", minHeight: 36, borderRadius: 8, border: "1px solid rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.1)", color: "#fca5a5", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            再試行
          </button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div style={{ padding: 48, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込み中...
        </div>
      ) : filteredGaps.length === 0 ? (
        <div style={{ padding: "48px 24px", textAlign: "center", color: "#6b7280", fontSize: 15, borderRadius: 14, border: "1px solid #1f2937", background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))" }}>
          <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>✅</span>
          {activeTab === "pending" ? "未対応のナレッジの穴はありません" : "該当するデータがありません"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredGaps.map((gap) => (
            <div
              key={gap.id}
              onClick={() => setSelectedGap(gap)}
              style={{
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                padding: "16px 20px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                cursor: "pointer",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "#374151"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "#1f2937"; }}
            >
              {/* Row: badges + question + meta */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                {/* Left: question */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    <DetectionBadge source={gap.detection_source} />
                    <RecStatusBadge status={gap.recommendation_status} />
                    {isSuperAdmin && (
                      <span style={{ fontSize: 11, color: "#4b5563", padding: "2px 7px", borderRadius: 999, border: "1px solid #1f2937" }}>
                        {gap.tenant_id}
                      </span>
                    )}
                  </div>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#f9fafb", lineHeight: 1.5, wordBreak: "break-word" }}>
                    「{gap.user_question}」
                  </p>
                  {gap.recommended_action && (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "#a78bfa", lineHeight: 1.4 }}>
                      💡 {gap.recommended_action}
                    </p>
                  )}
                </div>

                {/* Right: stats */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  {(gap.frequency ?? 0) > 0 && (
                    <span style={{ padding: "3px 10px", borderRadius: 999, background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
                      🔁 {gap.frequency}回
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                    {formatDate(gap.last_detected_at ?? gap.created_at)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > 100 && (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 24 }}>
          <button
            onClick={() => setOffset(Math.max(0, offset - 100))}
            disabled={offset === 0}
            style={{ padding: "10px 20px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.8)", color: offset === 0 ? "#374151" : "#9ca3af", cursor: offset === 0 ? "not-allowed" : "pointer", fontSize: 13 }}
          >
            ← 前へ
          </button>
          <span style={{ display: "flex", alignItems: "center", fontSize: 13, color: "#6b7280", padding: "0 12px" }}>
            {offset + 1}–{Math.min(offset + 100, total)} / {total}
          </span>
          <button
            onClick={() => setOffset(offset + 100)}
            disabled={offset + 100 >= total}
            style={{ padding: "10px 20px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.8)", color: offset + 100 >= total ? "#374151" : "#9ca3af", cursor: offset + 100 >= total ? "not-allowed" : "pointer", fontSize: 13 }}
          >
            次へ →
          </button>
        </div>
      )}

      {/* Modal */}
      {selectedGap && (
        <AddKnowledgeModal
          gap={selectedGap}
          onClose={() => setSelectedGap(null)}
          onSuccess={handleModalSuccess}
          onDismiss={handleModalDismiss}
        />
      )}

      {/* Toast */}
      {genToast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", padding: "14px 24px", borderRadius: 12, background: "#1f2937", border: "1px solid #374151", color: "#f9fafb", fontSize: 14, fontWeight: 600, boxShadow: "0 8px 30px rgba(0,0,0,0.4)", zIndex: 2000, whiteSpace: "nowrap" }}>
          {genToast}
        </div>
      )}
    </div>
  );
}
