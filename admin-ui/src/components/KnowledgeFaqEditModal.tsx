// admin-ui/src/components/KnowledgeFaqEditModal.tsx
import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { API_BASE } from "../lib/api";
import { useLang } from "../i18n/LangContext";

const TENANT = "carnation";

export interface KnowledgeFaqItem {
  id: number;
  question: string;
  answer: string;
  category: string | null;
  tags: string[] | null;
  is_published?: boolean;
}

interface Props {
  mode: "create" | "edit";
  item?: KnowledgeFaqItem;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed.session?.access_token ?? null;
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  resize: "vertical",
  lineHeight: 1.6,
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 15,
  fontWeight: 600,
  color: "#d1d5db",
  marginBottom: 8,
};

export default function KnowledgeFaqEditModal({ mode, item, onClose, onSuccess }: Props) {
  const { t } = useLang();
  const [question, setQuestion] = useState(item?.question ?? "");
  const [answer, setAnswer] = useState(item?.answer ?? "");
  const [category, setCategory] = useState(item?.category ?? "inventory");
  const [tagsInput, setTagsInput] = useState((item?.tags ?? []).join(", "));
  const [isPublished, setIsPublished] = useState(item?.is_published ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const CATEGORIES = [
    { value: "inventory", label: t("category.inventory") },
    { value: "campaign", label: t("category.campaign") },
    { value: "coupon", label: t("category.coupon") },
    { value: "store_info", label: t("category.store_info") },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!question.trim()) {
      setError(t("modal.question_required"));
      return;
    }
    if (!answer.trim()) {
      setError(t("modal.answer_required"));
      return;
    }

    const token = await getToken();
    if (!token) {
      setError(t("modal.session_expired"));
      return;
    }

    setSaving(true);
    setError(null);

    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const payload = {
      question: question.trim(),
      answer: answer.trim(),
      category: category || null,
      tags,
      is_published: isPublished,
    };

    try {
      const url =
        mode === "edit"
          ? `${API_BASE}/v1/admin/knowledge/faq/${item!.id}?tenant=${TENANT}`
          : `${API_BASE}/v1/admin/knowledge/faq?tenant=${TENANT}`;

      const res = await fetch(url, {
        method: mode === "edit" ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 401 || res.status === 403) {
        setError(t("modal.session_expired"));
        return;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || t("modal.save_error"));
      }

      onSuccess(mode === "edit" ? t("modal.saved") : t("modal.added"));
    } catch {
      setError(t("modal.save_error"));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "edit" ? t("modal.edit_title") : t("modal.create_title");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 1000,
        padding: "20px 16px",
        overflowY: "auto",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1f2937",
          borderRadius: 18,
          width: "100%",
          maxWidth: 580,
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          overflow: "hidden",
          marginTop: 8,
          marginBottom: 8,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div
          style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid #1f2937",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              color: "#f9fafb",
            }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label={t("modal.close")}
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 20,
              cursor: saving ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* フォーム */}
        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 20 }}
        >
          {error && (
            <div
              style={{
                padding: "14px 18px",
                borderRadius: 12,
                background: "rgba(127,29,29,0.5)",
                border: "1px solid rgba(248,113,113,0.4)",
                color: "#fca5a5",
                fontSize: 15,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          {/* 質問 */}
          <div>
            <label style={LABEL_STYLE}>
              {t("modal.question")}
              <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
            </label>
            <textarea
              required
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder={t("modal.question_placeholder")}
              style={TEXTAREA_STYLE}
            />
          </div>

          {/* 回答 */}
          <div>
            <label style={LABEL_STYLE}>
              {t("modal.answer")}
              <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
            </label>
            <textarea
              required
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={6}
              placeholder={t("modal.answer_placeholder")}
              style={TEXTAREA_STYLE}
            />
          </div>

          {/* カテゴリ */}
          <div>
            <label style={LABEL_STYLE}>{t("modal.category")}</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{
                ...INPUT_STYLE,
                minHeight: 52,
                appearance: "auto",
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* タグ */}
          <div>
            <label style={LABEL_STYLE}>{t("modal.tags")}</label>
            <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 8px", lineHeight: 1.5 }}>
              {t("modal.tags_hint")}
            </p>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder={t("modal.tags_placeholder")}
              style={INPUT_STYLE}
            />
          </div>

          {/* 公開/非公開 トグル */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "18px 20px",
              borderRadius: 12,
              border: `1px solid ${isPublished ? "rgba(34,197,94,0.3)" : "#374151"}`,
              background: isPublished
                ? "rgba(5,46,22,0.4)"
                : "rgba(15,23,42,0.6)",
              transition: "all 0.2s",
              cursor: "pointer",
            }}
            onClick={() => setIsPublished((v) => !v)}
          >
            <div>
              <div
                style={{ fontSize: 16, fontWeight: 600, color: isPublished ? "#4ade80" : "#9ca3af" }}
              >
                {isPublished ? t("modal.published") : t("modal.draft")}
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
                {isPublished ? t("modal.published_hint") : t("modal.draft_hint")}
              </div>
            </div>
            {/* トグルスイッチ */}
            <div
              style={{
                width: 52,
                height: 30,
                borderRadius: 999,
                background: isPublished ? "#22c55e" : "#374151",
                position: "relative",
                flexShrink: 0,
                transition: "background 0.2s",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 3,
                  left: isPublished ? 25 : 3,
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.2s",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                }}
              />
            </div>
          </div>

          {/* ボタン */}
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                flex: 1,
                padding: "16px",
                minHeight: 56,
                borderRadius: 12,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 16,
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {t("modal.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                flex: 2,
                padding: "16px",
                minHeight: 56,
                borderRadius: 12,
                border: "none",
                background: saving
                  ? "#1e3a5f"
                  : "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 50%, #1d4ed8 100%)",
                color: "#fff",
                fontSize: 17,
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
                boxShadow: saving ? "none" : "0 8px 24px rgba(59,130,246,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                transition: "opacity 0.15s",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? (
                <>
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      border: "2px solid rgba(255,255,255,0.4)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  {t("modal.saving")}
                </>
              ) : (
                t("modal.save")
              )}
            </button>
          </div>
        </form>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
