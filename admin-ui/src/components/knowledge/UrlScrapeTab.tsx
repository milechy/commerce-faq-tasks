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
  type ScrapePreviewItem,
} from "./shared";

export default function ScrapeTab({
  tenantId,
  onCommitSuccess,
  gapQuestion,
  gapId,
}: {
  tenantId: string;
  onCommitSuccess: () => void;
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

  const [urls, setUrls] = useState("");
  const [category, setCategory] = useState<string>("");
  const [isGlobal, setIsGlobal] = useState(tenantId === "global");
  useEffect(() => { setIsGlobal(tenantId === "global"); }, [tenantId]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ScrapePreviewItem[] | null>(null);
  const [committing, setCommitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<{ url: string; idx: number } | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editCategory, setEditCategory] = useState<string>("");

  const handleStartEdit = (url: string, idx: number, faq: FaqEntry) => {
    setEditingKey({ url, idx });
    setEditQuestion(faq.question);
    setEditAnswer(faq.answer);
    setEditCategory(faq.category ?? "");
  };
  const handleSaveEdit = () => {
    if (!editingKey || !preview) return;
    setPreview(preview.map((item) =>
      item.url === editingKey.url
        ? { ...item, faqs: item.faqs.map((f, i) => i === editingKey.idx ? { ...f, question: editQuestion.trim(), answer: editAnswer.trim(), category: editCategory || undefined } : f) }
        : item
    ));
    setEditingKey(null);
  };
  const handleDeleteFaq = (url: string, idx: number) => {
    if (!preview) return;
    setPreview(preview.map((item) =>
      item.url === url ? { ...item, faqs: item.faqs.filter((_, i) => i !== idx) } : item
    ));
  };

  const handleFetch = async () => {
    const urlList = urls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urlList.length === 0) {
      setError(t("knowledge.url_required"));
      return;
    }
    if (urlList.length > 5) {
      setError(t("knowledge.url_max"));
      return;
    }

    setLoading(true);
    setError(null);
    setPreview(null);
    setSuccess(null);

    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/scrape?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: urlList, ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      if (res.status === 401 || res.status === 403) {
        navigate("/login", { replace: true });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; preview?: ScrapePreviewItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      setPreview(data.preview ?? []);
    } catch (err) {
      if (err instanceof Error && err.message === "__AUTH_REQUIRED__") {
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : t("knowledge.load_error"));
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) return;
    const validItems = preview.filter((p) => p.faqs.length > 0);
    if (validItems.length === 0) return;

    setCommitting(true);
    setError(null);

    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/scrape/commit?tenant=${tenantId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: validItems, ...(category ? { category } : {}), ...(isGlobal ? { target: "global" } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean; inserted?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("knowledge.load_error"));
      if (gapId) {
        await resolveKnowledgeGap(gapId).catch(() => {/* silent */});
        setSuccess("✅ ナレッジを追加し、未回答の質問を解決済みにしました");
      } else {
        setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
      }
      setPreview(null);
      setUrls("");
      onCommitSuccess();
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

  const totalFaqs = preview?.reduce((sum, p) => sum + p.faqs.length, 0) ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {gapQuestion && <GapQuestionBanner question={gapQuestion} />}
      {!preview && (
        <>
          <div style={CARD_STYLE}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 6px" }}>
              {t("knowledge.scrape_title")}
            </h3>
            <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px", lineHeight: 1.6 }}>
              {t("knowledge.scrape_desc")}
            </p>
            <textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={t("knowledge.scrape_placeholder")}
              style={{ ...TEXTAREA_STYLE, minHeight: 120, fontFamily: "monospace" }}
            />
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
        </>
      )}

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

      {loading && (
        <div style={{ padding: "20px", textAlign: "center", ...CARD_STYLE }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          <p style={{ fontSize: 15, color: "#93c5fd", margin: 0 }}>
            {t("knowledge.scraping")}
          </p>
        </div>
      )}

      {!preview && !loading && (
        <button
          onClick={handleFetch}
          disabled={urls.trim().length === 0}
          style={{
            ...BTN_PRIMARY,
            opacity: urls.trim().length === 0 ? 0.6 : 1,
            cursor: urls.trim().length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {t("knowledge.fetch")}
        </button>
      )}

      {preview && preview.length > 0 && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
            {t("knowledge.scrape_preview_title", { n: totalFaqs })}
          </h3>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
            {t("knowledge.scrape_preview_desc")}
          </p>

          {preview.map((item) => (
            <div key={item.url} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                🔗 {item.url}
              </div>
              {item.error ? (
                <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 13 }}>
                  {t("knowledge.scrape_fetch_failed", { error: item.error })}
                </div>
              ) : item.faqs.length === 0 ? (
                <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 13 }}>
                  {t("knowledge.preview_empty")}
                </div>
              ) : (
                <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden" }}>
                  {item.faqs.map((faq, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "14px 18px",
                        borderBottom: idx === item.faqs.length - 1 ? "none" : "1px solid #111827",
                      }}
                    >
                      {editingKey?.url === item.url && editingKey?.idx === idx ? (
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
                              onClick={() => setEditingKey(null)}
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
                              onClick={() => handleStartEdit(item.url, idx, faq)}
                              style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #374151", background: "transparent", color: "#93c5fd", fontSize: 12, cursor: "pointer" }}
                            >
                              {t("knowledge.edit")}
                            </button>
                            <button
                              onClick={() => handleDeleteFaq(item.url, idx)}
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
            </div>
          ))}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button
              onClick={() => { setPreview(null); setError(null); }}
              style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 12, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              {t("common.retry")}
            </button>
            <button
              onClick={handleCommit}
              disabled={committing || totalFaqs === 0}
              style={{ ...BTN_PRIMARY, flex: 2, width: "auto", opacity: (committing || totalFaqs === 0) ? 0.6 : 1 }}
            >
              {committing ? t("knowledge.committing") : t("knowledge.commit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
