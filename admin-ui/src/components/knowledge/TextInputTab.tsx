import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../i18n/LangContext";
import { useAuth } from "../../auth/useAuth";
import { API_BASE } from "../../lib/api";
import GlobalKnowledgeCheckbox from "./GlobalKnowledgeCheckbox";
import {
  type FaqEntry,
  type Category,
  fetchWithAuth,
  CARD_STYLE,
  BTN_PRIMARY,
  TEXTAREA_STYLE,
  SELECT_STYLE,
  CATEGORY_LABEL_MAP,
} from "./shared";

export default function TextInputTab({ tenantId }: { tenantId: string }) {
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
  const [category, setCategory] = useState<Category>("");
  const [isGlobal, setIsGlobal] = useState(false);
  const [converting, setConverting] = useState(false);
  const [preview, setPreview] = useState<FaqEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

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
      setSuccess(t("knowledge.committed", { n: data.inserted ?? 0 }));
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
          placeholder={t("knowledge.text_placeholder")}
          style={TEXTAREA_STYLE}
        />
        <div style={{ textAlign: "right", marginTop: 6, fontSize: 12 }}>
          {text.trim().length < 50 ? (
            <span style={{ color: "#fb923c" }}>
              {t("knowledge.char_count_need", { n: 50 - text.trim().length })}
            </span>
          ) : (
            <span style={{ color: "#6b7280" }}>
              {t("knowledge.char_count_ok", { n: text.trim().length })}
            </span>
          )}
        </div>
      </div>

      <div style={CARD_STYLE}>
        <label style={{ display: "block", fontSize: 15, fontWeight: 600, color: "#d1d5db", marginBottom: 8 }}>
          {t("knowledge.category_label")}
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
        {category === "" && (
          <p style={{ fontSize: 12, color: "#6b7280", margin: "6px 0 0", lineHeight: 1.5 }}>
            {t("knowledge.category_auto_desc")}
          </p>
        )}
        {isSuperAdmin && (
          <div style={{ marginTop: 16 }}>
            <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} />
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

      {preview && preview.length > 0 && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb", margin: "0 0 12px" }}>
            {t("knowledge.preview_title", { n: preview.length })}
          </h3>
          <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 16px" }}>
            {t("knowledge.preview_desc")}
          </p>
          <div style={{ ...CARD_STYLE, padding: 0, overflow: "hidden", marginBottom: 16 }}>
            {preview.map((faq, idx) => {
              const categoryLabel = faq.category ? CATEGORY_LABEL_MAP[faq.category]?.ja : null;
              return (
                <div
                  key={idx}
                  style={{
                    padding: "16px 18px",
                    borderBottom: idx === preview.length - 1 ? "none" : "1px solid #111827",
                  }}
                >
                  <span style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    background: "rgba(34,197,94,0.15)",
                    color: "#4ade80",
                    border: "1px solid rgba(34,197,94,0.3)",
                    marginBottom: 4,
                  }}>
                    {categoryLabel || faq.category || "自動判定"}
                  </span>
                  <p style={{ fontSize: 15, fontWeight: 600, color: "#f9fafb", margin: "0 0 6px" }}>
                    Q: {faq.question}
                  </p>
                  <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, lineHeight: 1.5 }}>
                    A: {faq.answer}
                  </p>
                  <select
                    value={faq.category || ""}
                    onChange={(e) => {
                      const updated = preview.map((f, i) =>
                        i === idx ? { ...f, category: e.target.value || undefined } : f
                      );
                      setPreview(updated);
                    }}
                    style={{
                      fontSize: 12,
                      padding: "3px 8px",
                      borderRadius: 6,
                      border: "1px solid #374151",
                      background: "rgba(15,23,42,0.8)",
                      color: "#9ca3af",
                      marginTop: 6,
                    }}
                  >
                    <option value="">🤖 AI自動判定</option>
                    {CATEGORIES.filter((c) => c.value !== "").map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setPreview(null)}
              style={{ flex: 1, padding: "14px", minHeight: 56, borderRadius: 12, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              {t("common.retry")}
            </button>
            <button
              onClick={handleCommit}
              disabled={committing}
              style={{ ...BTN_PRIMARY, flex: 2, width: "auto", opacity: committing ? 0.6 : 1 }}
            >
              {committing ? t("knowledge.committing") : t("knowledge.commit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
