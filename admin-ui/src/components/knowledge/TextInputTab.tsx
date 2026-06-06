import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";
import { useAuth } from "../../auth/useAuth";
import GapQuestionBanner from "./GapQuestionBanner";
import GlobalKnowledgeCheckbox from "./GlobalKnowledgeCheckbox";
import {
  fetchWithAuth,
  resolveKnowledgeGap,
  CARD_STYLE,
  BTN_PRIMARY,
  TEXTAREA_STYLE,
  SELECT_STYLE,
  CATEGORY_LABELS,
  type FaqEntry,
} from "./shared";

export default function TextInputTab({
  tenantId,
  gapQuestion,
  gapId,
}: {
  tenantId: string;
  gapQuestion?: string;
  gapId?: number;
}) {
  const navigate = useNavigate();
  const { t } = useLang();
  const { isSuperAdmin } = useAuth();

  const CATEGORIES = [
    { value: "", label: t("knowledge.category_auto") },
    { value: "inventory", label: t("category.inventory") },
    { value: "campaign", label: t("category.campaign") },
    { value: "coupon", label: t("category.coupon") },
    { value: "store_info", label: t("category.store_info") },
    { value: "product_info", label: t("category.product_info") },
    { value: "pricing", label: t("category.pricing") },
    { value: "booking", label: t("category.booking") },
    { value: "warranty", label: t("category.warranty") },
    { value: "general", label: t("category.general") },
  ];

  const [text, setText] = useState("");
  const [category, setCategory] = useState<string>("");
  const [isGlobal, setIsGlobal] = useState(tenantId === "global");
  useEffect(() => { setIsGlobal(tenantId === "global"); }, [tenantId]);
  const [converting, setConverting] = useState(false);
  const [preview, setPreview] = useState<FaqEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editCategory, setEditCategory] = useState<string>("");

  const handleStartEdit = (idx: number, faq: FaqEntry) => {
    setEditingIndex(idx);
    setEditQuestion(faq.question);
    setEditAnswer(faq.answer);
    setEditCategory(faq.category ?? "");
  };
  const handleSaveEdit = () => {
    if (editingIndex === null || !preview) return;
    const updated = preview.map((f, i) =>
      i === editingIndex ? { ...f, question: editQuestion.trim(), answer: editAnswer.trim(), category: editCategory || undefined } : f
    );
    setPreview(updated);
    setEditingIndex(null);
  };
  const handleDeleteFaq = (idx: number) => {
    if (!preview) return;
    setPreview(preview.filter((_, i) => i !== idx));
  };

  const handleConvert = async () => {
    if (text.trim().length < 50) {
      setError(t("knowledge.text_min_error"));
      return;
    }

    setConverting(true);
    setError(null);
    setPreview(null);
    setSuccess(null);

    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/text?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; preview?: FaqEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      setPreview(data.preview ?? []);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setConverting(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) return;

    setCommitting(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/text/commit?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faqs: preview, ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; inserted?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      // ギャップが紐付いていれば自動解決
      if (gapId) {
        await resolveKnowledgeGap(gapId).catch(() => {/* silent */});
        setSuccess("✅ ナレッジを追加し、未回答の質問を解決済みにしました");
      } else {
        setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
      }
      setPreview(null);
      setText("");
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {gapQuestion && <GapQuestionBanner question={gapQuestion} />}
      <div style={CARD_STYLE}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>
          {t("knowledge.text_title")}
        </h3>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px", lineHeight: 1.6 }}>
          {t("knowledge.text_desc")}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            gapQuestion
              ? `「${gapQuestion}」に回答できる情報を入力してください`
              : t("knowledge.text_placeholder")
          }
          maxLength={10000}
          style={TEXTAREA_STYLE}
        />
        <p style={{ textAlign: "right", fontSize: 12, color: text.length > 9000 ? "#ef4444" : "#6b7280", marginTop: 4 }}>
          {text.length.toLocaleString()} / 10,000
        </p>
      </div>

      <div style={CARD_STYLE}>
        <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 8 }}>
          {t("knowledge.category_label")}
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={SELECT_STYLE}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        {category === "" && (
          <p style={{ fontSize: 12, color: "#6b7280", margin: "6px 0 0", lineHeight: 1.5 }}>
            {t("knowledge.category_auto_desc")}
          </p>
        )}
        {isSuperAdmin && (
          <div style={{ marginTop: 16 }}>
            <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} disabled={tenantId === "global"} />
          </div>
        )}
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
          disabled={converting || text.trim().length < 50}
          style={{
            ...BTN_PRIMARY,
            opacity: converting || text.trim().length < 50 ? 0.6 : 1,
            cursor: converting || text.trim().length < 50 ? "not-allowed" : "pointer",
          }}
        >
          {converting ? t("knowledge.converting") : t("knowledge.convert")}
        </button>
      )}

      {preview && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
            {t("knowledge.preview_title", { n: preview.length })}
          </h3>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
            {t("knowledge.preview_desc")}
          </p>
          {preview.length === 0 ? (
            <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 14, marginBottom: 16 }}>
              {t("knowledge.preview_empty")}
            </div>
          ) : (
            <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden", marginBottom: 16 }}>
              {preview.map((faq, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: "16px 18px",
                    borderBottom: idx === preview.length - 1 ? "none" : "1px solid #111827",
                  }}
                >
                  {editingIndex === idx ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <input
                        value={editQuestion}
                        onChange={(e) => setEditQuestion(e.target.value)}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#f9fafb", fontSize: 14 }}
                      />
                      <textarea
                        value={editAnswer}
                        onChange={(e) => setEditAnswer(e.target.value)}
                        rows={3}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#9ca3af", fontSize: 13, resize: "vertical" }}
                      />
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#1f2937", color: "#d1d5db", fontSize: 13 }}
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={handleSaveEdit}
                          style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                        >
                          {t("knowledge.preview_edit_save")}
                        </button>
                        <button
                          onClick={() => setEditingIndex(null)}
                          style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 6px" }}>
                        Q: {faq.question}
                      </p>
                      <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 8px", lineHeight: 1.5 }}>
                        A: {faq.answer}
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                        {faq.category && (
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "rgba(37,99,235,0.25)", border: "1px solid rgba(96,165,250,0.3)", color: "#93c5fd", fontSize: 11, fontWeight: 600 }}>
                            {CATEGORY_LABELS[faq.category]?.ja ?? faq.category}
                          </span>
                        )}
                        {faq.duplicate && (
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, background: "rgba(120,53,15,0.4)", border: "1px solid rgba(251,191,36,0.4)", color: "#fbbf24", fontSize: 11, fontWeight: 600 }}>
                            ⚠️ 重複の可能性: 「{faq.duplicate.existingQuestion.slice(0, 30)}{faq.duplicate.existingQuestion.length > 30 ? "…" : ""}」
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => handleStartEdit(idx, faq)}
                          style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #374151", background: "transparent", color: "#93c5fd", fontSize: 12, cursor: "pointer" }}
                        >
                          {t("knowledge.edit")}
                        </button>
                        <button
                          onClick={() => handleDeleteFaq(idx)}
                          style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(248,113,113,0.3)", background: "transparent", color: "#fca5a5", fontSize: 12, cursor: "pointer" }}
                        >
                          {t("knowledge.preview_remove")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setPreview(null)}
              style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 12, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              {t("common.retry")}
            </button>
            <button
              onClick={handleCommit}
              disabled={committing || preview.length === 0}
              style={{ ...BTN_PRIMARY, flex: 2, width: "auto", opacity: (committing || preview.length === 0) ? 0.6 : 1, cursor: (committing || preview.length === 0) ? "not-allowed" : "pointer" }}
            >
              {committing ? t("knowledge.committing") : t("knowledge.commit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
