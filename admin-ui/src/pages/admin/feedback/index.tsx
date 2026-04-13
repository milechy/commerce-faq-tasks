// admin-ui/src/pages/admin/feedback/index.tsx
// Phase43: AdminFeedback management — list, filter, detail modal, PATCH/DELETE

import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { Pagination } from "../../../components/common/Pagination";
import { PeriodFilter } from "../../../components/common/PeriodFilter";
import type { PeriodValue } from "../../../components/common/PeriodFilter";
import { SearchBox } from "../../../components/common/SearchBox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AdminFeedback {
  id: string;
  tenant_id: string;
  user_email: string | null;
  message: string;
  ai_response: string | null;
  ai_answered: boolean;
  status: "new" | "reviewed" | "needs_improvement" | "resolved";
  category: "operation_guide" | "feature_request" | "bug_report" | "knowledge_gap" | "other";
  priority: "low" | "normal" | "high";
  admin_notes: string | null;
  linked_knowledge_gap_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

const STATUS_COLORS: Record<AdminFeedback["status"], { bg: string; border: string; text: string; label_ja: string; label_en: string }> = {
  new: { bg: "rgba(59,130,246,0.15)", border: "rgba(59,130,246,0.45)", text: "#60a5fa", label_ja: "未対応", label_en: "New" },
  reviewed: { bg: "rgba(107,114,128,0.15)", border: "rgba(107,114,128,0.45)", text: "#9ca3af", label_ja: "確認済", label_en: "Reviewed" },
  needs_improvement: { bg: "rgba(249,115,22,0.15)", border: "rgba(249,115,22,0.45)", text: "#fb923c", label_ja: "要改善", label_en: "Needs Improvement" },
  resolved: { bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.45)", text: "#4ade80", label_ja: "解決済", label_en: "Resolved" },
};

const PRIORITY_COLORS: Record<AdminFeedback["priority"], { bg: string; border: string; text: string; label_ja: string; label_en: string }> = {
  low: { bg: "rgba(107,114,128,0.12)", border: "rgba(107,114,128,0.35)", text: "#9ca3af", label_ja: "低", label_en: "Low" },
  normal: { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.35)", text: "#60a5fa", label_ja: "通常", label_en: "Normal" },
  high: { bg: "rgba(239,68,68,0.15)", border: "rgba(239,68,68,0.45)", text: "#f87171", label_ja: "高", label_en: "High" },
};

const CATEGORY_LABELS: Record<AdminFeedback["category"], { ja: string; en: string }> = {
  operation_guide: { ja: "操作ガイド", en: "Operation Guide" },
  feature_request: { ja: "機能要望", en: "Feature Request" },
  bug_report: { ja: "バグ報告", en: "Bug Report" },
  knowledge_gap: { ja: "知識ギャップ", en: "Knowledge Gap" },
  other: { ja: "その他", en: "Other" },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function Badge(_props: { color: { bg: string; border: string; text: string } & { label_ja?: string; label_en?: string } }) {
  return null; // placeholder — badges rendered inline below
}
void Badge; // suppress unused warning

function StatusBadge({ status, lang }: { status: AdminFeedback["status"]; lang: string }) {
  const c = STATUS_COLORS[status];
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      background: c.bg,
      border: `1px solid ${c.border}`,
      color: c.text,
      whiteSpace: "nowrap",
    }}>
      {lang === "ja" ? c.label_ja : c.label_en}
    </span>
  );
}

function PriorityBadge({ priority, lang }: { priority: AdminFeedback["priority"]; lang: string }) {
  const c = PRIORITY_COLORS[priority];
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      background: c.bg,
      border: `1px solid ${c.border}`,
      color: c.text,
      whiteSpace: "nowrap",
    }}>
      {lang === "ja" ? c.label_ja : c.label_en}
    </span>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  minHeight: 44,
  borderRadius: 8,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.9)",
  color: "#e5e7eb",
  fontSize: 14,
  cursor: "pointer",
  outline: "none",
  appearance: "none" as const,
  WebkitAppearance: "none" as const,
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M6 8L1 3h10z'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  paddingRight: 32,
};

// ─── Detail Modal ─────────────────────────────────────────────────────────────

interface DetailModalProps {
  item: AdminFeedback;
  lang: string;
  isSuperAdmin: boolean;
  onClose: () => void;
  onSaved: (updated: AdminFeedback) => void;
  onDeleted: (id: string) => void;
}

function DetailModal({ item, lang, isSuperAdmin, onClose, onSaved, onDeleted }: DetailModalProps) {
  const locale = lang === "en" ? "en-US" : "ja-JP";
  const [status, setStatus] = useState<AdminFeedback["status"]>(item.status);
  const [priority, setPriority] = useState<AdminFeedback["priority"]>(item.priority);
  const [adminNotes, setAdminNotes] = useState(item.admin_notes ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingRule, setCreatingRule] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const showToast = (text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const handleCreateDenyRule = async () => {
    setCreatingRule(true);
    try {
      const ruleRes = await authFetch(`${API_BASE}/v1/admin/tuning-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: item.tenant_id,
          trigger_pattern: item.message,
          expected_behavior:
            "この種の質問には『申し訳ございませんが、当店ではお答えできかねます。ご了承ください。』と丁寧に断ってください",
          priority: 8,
        }),
      });
      if (!ruleRes.ok) {
        showToast(lang === "ja" ? "ルール作成に失敗しました" : "Failed to create rule", false);
        return;
      }
      // ステータスを「対応済み」に更新
      await authFetch(`${API_BASE}/v1/admin/feedback/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      setStatus("resolved");
      onSaved({ ...item, status: "resolved" });
      showToast(lang === "ja" ? "拒否ルールを作成しました" : "Deny rule created", true);
    } catch {
      showToast(lang === "ja" ? "ルール作成に失敗しました" : "Failed to create rule", false);
    } finally {
      setCreatingRule(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, priority, admin_notes: adminNotes }),
      });
      if (!res.ok) {
        setError(lang === "ja" ? "保存に失敗しました" : "Failed to save");
        return;
      }
      const data = await res.json() as { feedback?: AdminFeedback } | AdminFeedback;
      const updated = ("feedback" in data && data.feedback) ? data.feedback : { ...item, status, priority, admin_notes: adminNotes };
      onSaved(updated as AdminFeedback);
    } catch {
      setError(lang === "ja" ? "ネットワークエラー" : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback/${item.id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(lang === "ja" ? "削除に失敗しました" : "Failed to delete");
        setDeleting(false);
        return;
      }
      onDeleted(item.id);
    } catch {
      setError(lang === "ja" ? "ネットワークエラー" : "Network error");
      setDeleting(false);
    }
  };

  const catLabel = CATEGORY_LABELS[item.category];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 640,
          maxHeight: "90vh",
          overflowY: "auto",
          borderRadius: 16,
          border: "1px solid #1f2937",
          background: "rgba(15,23,42,0.98)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          padding: "24px 24px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {/* Modal header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <StatusBadge status={status} lang={lang} />
            <PriorityBadge priority={priority} lang={lang} />
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              {lang === "ja" ? catLabel.ja : catLabel.en}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid #374151",
              borderRadius: 8,
              color: "#9ca3af",
              fontSize: 18,
              cursor: "pointer",
              padding: "4px 10px",
              lineHeight: 1,
              minHeight: 36,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* Meta */}
        <div style={{ fontSize: 12, color: "#6b7280", display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>{new Date(item.created_at).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          {item.user_email && <span>{item.user_email}</span>}
          <span style={{ fontFamily: "monospace", opacity: 0.6 }}>{item.id.slice(0, 8)}…</span>
        </div>

        {/* Message */}
        <div>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>
            {lang === "ja" ? "メッセージ" : "Message"}
          </p>
          <div style={{
            padding: "12px 14px",
            borderRadius: 10,
            border: "1px solid #1f2937",
            background: "rgba(0,0,0,0.25)",
            fontSize: 14,
            color: "#f9fafb",
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {item.message}
          </div>
        </div>

        {/* AI response */}
        {item.ai_response && (
          <div>
            <p style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>
              {lang === "ja" ? "AI回答" : "AI Response"}
              {item.ai_answered && (
                <span style={{ marginLeft: 8, color: "#4ade80", fontSize: 11 }}>
                  {lang === "ja" ? "✓ 回答済" : "✓ Answered"}
                </span>
              )}
            </p>
            <div style={{
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid rgba(34,197,94,0.2)",
              background: "rgba(34,197,94,0.05)",
              fontSize: 13,
              color: "#d1fae5",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>
              {item.ai_response}
            </div>
          </div>
        )}

        {/* Status + Priority editors */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 180px" }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", display: "block", marginBottom: 6 }}>
              {lang === "ja" ? "ステータス" : "Status"}
            </label>
            <select value={status} onChange={(e) => setStatus(e.target.value as AdminFeedback["status"])} style={{ ...selectStyle, width: "100%" }}>
              <option value="new">{lang === "ja" ? "未対応" : "New"}</option>
              <option value="reviewed">{lang === "ja" ? "確認済" : "Reviewed"}</option>
              <option value="needs_improvement">{lang === "ja" ? "要改善" : "Needs Improvement"}</option>
              <option value="resolved">{lang === "ja" ? "解決済" : "Resolved"}</option>
            </select>
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", display: "block", marginBottom: 6 }}>
              {lang === "ja" ? "優先度" : "Priority"}
            </label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as AdminFeedback["priority"])} style={{ ...selectStyle, width: "100%" }}>
              <option value="low">{lang === "ja" ? "低" : "Low"}</option>
              <option value="normal">{lang === "ja" ? "通常" : "Normal"}</option>
              <option value="high">{lang === "ja" ? "高" : "High"}</option>
            </select>
          </div>
        </div>

        {/* Quick actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {status !== "needs_improvement" && (
            <button
              onClick={() => setStatus("needs_improvement")}
              style={{
                padding: "8px 16px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid rgba(249,115,22,0.45)",
                background: "rgba(249,115,22,0.08)",
                color: "#fb923c",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {lang === "ja" ? "⚠ 要改善にセット" : "⚠ Mark as Needs Improvement"}
            </button>
          )}
          {status !== "resolved" && (
            <button
              onClick={() => void handleCreateDenyRule()}
              disabled={creatingRule}
              style={{
                padding: "8px 16px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid rgba(239,68,68,0.45)",
                background: "rgba(239,68,68,0.08)",
                color: "#f87171",
                fontSize: 13,
                fontWeight: 600,
                cursor: creatingRule ? "not-allowed" : "pointer",
                opacity: creatingRule ? 0.6 : 1,
              }}
            >
              {creatingRule
                ? (lang === "ja" ? "作成中..." : "Creating...")
                : (lang === "ja" ? "🚫 拒否ルールを作成" : "🚫 Create Deny Rule")}
            </button>
          )}
        </div>

        {/* Toast */}
        {toast && (
          <div style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: toast.ok ? "rgba(5,46,22,0.6)" : "rgba(127,29,29,0.5)",
            border: `1px solid ${toast.ok ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
            color: toast.ok ? "#4ade80" : "#fca5a5",
            fontSize: 13,
            fontWeight: 600,
          }}>
            {toast.text}
          </div>
        )}

        {/* Admin notes */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", display: "block", marginBottom: 6 }}>
            {lang === "ja" ? "管理者メモ" : "Admin Notes"}
          </label>
          <textarea
            value={adminNotes}
            onChange={(e) => setAdminNotes(e.target.value)}
            placeholder={lang === "ja" ? "内部メモを入力..." : "Internal notes..."}
            rows={4}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "rgba(0,0,0,0.3)",
              color: "#e5e7eb",
              fontSize: 14,
              fontFamily: "inherit",
              lineHeight: 1.6,
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Error */}
        {error && (
          <div style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* Action row */}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
          {/* Delete (super admin only) */}
          {isSuperAdmin && (
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              style={{
                padding: "10px 16px",
                minHeight: 44,
                borderRadius: 8,
                border: confirmDelete ? "1px solid rgba(239,68,68,0.7)" : "1px solid #374151",
                background: confirmDelete ? "rgba(239,68,68,0.15)" : "transparent",
                color: confirmDelete ? "#f87171" : "#6b7280",
                fontSize: 14,
                fontWeight: 600,
                cursor: deleting ? "not-allowed" : "pointer",
                opacity: deleting ? 0.6 : 1,
              }}
            >
              {deleting ? "..." : confirmDelete ? (lang === "ja" ? "本当に削除" : "Confirm Delete") : (lang === "ja" ? "削除" : "Delete")}
            </button>
          )}

          <div style={{ display: "flex", gap: 10, marginLeft: "auto" }}>
            <button
              onClick={onClose}
              style={{
                padding: "10px 20px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {lang === "ja" ? "キャンセル" : "Cancel"}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                padding: "10px 24px",
                minHeight: 44,
                borderRadius: 8,
                border: "none",
                background: saving
                  ? "rgba(59,130,246,0.4)"
                  : "linear-gradient(135deg, #3b82f6, #6366f1)",
                color: "#fff",
                fontSize: 14,
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? (lang === "ja" ? "保存中..." : "Saving...") : (lang === "ja" ? "保存" : "Save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function FeedbackPage() {
  const navigate = useNavigate();
  const { lang } = useLang();
  const { isSuperAdmin } = useAuth();
  const locale = lang === "en" ? "en-US" : "ja-JP";

  const [items, setItems] = useState<AdminFeedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<"created_at" | "priority">("created_at");
  const [selected, setSelected] = useState<AdminFeedback | null>(null);
  const [searchText, setSearchText] = useState("");
  const [period, setPeriod] = useState<PeriodValue>("all");
  const [displayOffset, setDisplayOffset] = useState(0);
  const DISPLAY_LIMIT = 20;

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let url = `${API_BASE}/v1/admin/feedback?limit=200&offset=0`;
      if (statusFilter) url += `&status=${statusFilter}`;
      if (categoryFilter) url += `&category=${categoryFilter}`;
      if (sortBy === "priority") url += `&sort_by=priority`;
      const res = await authFetch(url);
      if (!res.ok) {
        setError(lang === "ja" ? "取得に失敗しました" : "Failed to load feedback");
        return;
      }
      const data = await res.json() as { items?: AdminFeedback[]; feedback?: AdminFeedback[] } | AdminFeedback[];
      if (Array.isArray(data)) {
        setItems(data);
      } else if ("items" in data && Array.isArray(data.items)) {
        setItems(data.items);
      } else if ("feedback" in data && Array.isArray(data.feedback)) {
        setItems(data.feedback);
      } else {
        setItems([]);
      }
    } catch {
      setError(lang === "ja" ? "ネットワークエラー" : "Network error");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, sortBy, lang]);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  // Client-side: search + period filter
  const filteredItems = useMemo(() => {
    let result = items;
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      result = result.filter(
        (it) =>
          it.message.toLowerCase().includes(q) ||
          (it.ai_response ?? "").toLowerCase().includes(q) ||
          (it.admin_notes ?? "").toLowerCase().includes(q),
      );
    }
    if (period !== "all") {
      const days = parseInt(period, 10);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      result = result.filter((it) => new Date(it.created_at) >= cutoff);
    }
    return result;
  }, [items, searchText, period]);

  // Reset page when filters change
  useEffect(() => { setDisplayOffset(0); }, [searchText, period, statusFilter, categoryFilter]);

  const handleSaved = (updated: AdminFeedback) => {
    setItems((prev) => prev.map((it) => it.id === updated.id ? updated : it));
    setSelected(updated);
  };

  const handleDeleted = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setSelected(null);
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            ← {lang === "ja" ? "管理画面に戻る" : "Back to Dashboard"}
          </button>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb", display: "flex", alignItems: "center", gap: 8 }}>
            📝 {lang === "ja" ? "お客様の声" : "Customer Feedback"}
          </h1>
          <p style={{ fontSize: 13, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {lang === "ja" ? "チャット中にお客様が送ったフィードバックを管理します" : "Manage feedback submitted by customers during chat"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <LangSwitcher />
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div style={{
          marginBottom: 20,
          padding: "12px 16px",
          borderRadius: 10,
          background: "rgba(127,29,29,0.4)",
          border: "1px solid rgba(248,113,113,0.3)",
          color: "#fca5a5",
          fontSize: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <div style={{ flex: "1 1 200px", minWidth: 180 }}>
          <SearchBox
            value={searchText}
            onChange={setSearchText}
            placeholder={lang === "ja" ? "フィードバック内容を検索..." : "Search feedback..."}
          />
        </div>
        <PeriodFilter value={period} onChange={setPeriod} />
        <button
          onClick={() => void fetchItems()}
          style={{
            padding: "6px 14px",
            minHeight: 36,
            borderRadius: 8,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          ↻ {lang === "ja" ? "更新" : "Refresh"}
        </button>
        <span style={{ marginLeft: "auto", fontSize: 13, color: "#6b7280" }}>
          {!loading && `${filteredItems.length} ${lang === "ja" ? "件" : "items"}`}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">{lang === "ja" ? "全ステータス" : "All Statuses"}</option>
          <option value="new">{lang === "ja" ? "未対応" : "New"}</option>
          <option value="reviewed">{lang === "ja" ? "確認済" : "Reviewed"}</option>
          <option value="needs_improvement">{lang === "ja" ? "要改善" : "Needs Improvement"}</option>
          <option value="resolved">{lang === "ja" ? "解決済" : "Resolved"}</option>
        </select>

        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={selectStyle}>
          <option value="">{lang === "ja" ? "全カテゴリ" : "All Categories"}</option>
          <option value="operation_guide">{lang === "ja" ? "操作ガイド" : "Operation Guide"}</option>
          <option value="feature_request">{lang === "ja" ? "機能要望" : "Feature Request"}</option>
          <option value="bug_report">{lang === "ja" ? "バグ報告" : "Bug Report"}</option>
          <option value="knowledge_gap">{lang === "ja" ? "知識ギャップ" : "Knowledge Gap"}</option>
          <option value="other">{lang === "ja" ? "その他" : "Other"}</option>
        </select>

        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "created_at" | "priority")} style={selectStyle}>
          <option value="created_at">{lang === "ja" ? "新着順" : "Newest First"}</option>
          <option value="priority">{lang === "ja" ? "優先度順" : "By Priority"}</option>
        </select>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 160, color: "#6b7280", fontSize: 15 }}>
          <span style={{ marginRight: 8 }}>⏳</span>
          {lang === "ja" ? "読み込み中..." : "Loading..."}
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 200,
          color: "#6b7280",
          fontSize: 15,
          gap: 8,
        }}>
          <span style={{ fontSize: 36 }}>📭</span>
          <span>{lang === "ja" ? "フィードバックがありません" : "No feedback items found"}</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filteredItems.slice(displayOffset, displayOffset + DISPLAY_LIMIT).map((item) => {
            const catLabel = CATEGORY_LABELS[item.category];
            return (
              <button
                key={item.id}
                onClick={() => setSelected(item)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  minHeight: 44,
                  borderRadius: 12,
                  border: "1px solid #1f2937",
                  background: "rgba(15,23,42,0.95)",
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 14,
                  transition: "border-color 0.15s, background 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#374151";
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,1)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#1f2937";
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.95)";
                }}
              >
                {/* Date column */}
                <div style={{ flexShrink: 0, minWidth: 90, paddingTop: 2 }}>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>{formatDate(item.created_at)}</span>
                </div>

                {/* Badges */}
                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, paddingTop: 2, minWidth: 96 }}>
                  <StatusBadge status={item.status} lang={lang} />
                  <PriorityBadge priority={item.priority} lang={lang} />
                </div>

                {/* Category */}
                <div style={{ flexShrink: 0, paddingTop: 4, minWidth: 80 }}>
                  <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 500 }}>
                    {lang === "ja" ? catLabel.ja : catLabel.en}
                  </span>
                </div>

                {/* Message preview + email */}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{
                    fontSize: 14,
                    color: "#f9fafb",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "block",
                  }}>
                    {item.message.slice(0, 60)}{item.message.length > 60 ? "…" : ""}
                  </span>
                  {item.user_email && (
                    <span style={{ fontSize: 12, color: "#6b7280" }}>{item.user_email}</span>
                  )}
                </div>

                {/* Arrow */}
                <div style={{ flexShrink: 0, color: "#4b5563", fontSize: 16, paddingTop: 2 }}>›</div>
              </button>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      <Pagination
        total={filteredItems.length}
        limit={DISPLAY_LIMIT}
        offset={displayOffset}
        onPageChange={setDisplayOffset}
      />

      {/* Detail Modal */}
      {selected && (
        <DetailModal
          item={selected}
          lang={lang}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
