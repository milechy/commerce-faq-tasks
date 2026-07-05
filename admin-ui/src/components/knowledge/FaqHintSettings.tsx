// admin-ui/src/components/knowledge/FaqHintSettings.tsx
// GID 1216274385106667: FAQ登録フォームの質問/回答欄に、テナントごとのカスタム入力例
// (プレースホルダー)を設定できる折りたたみ設定パネル
// (HermesConsentToggleの fetch/楽観的更新+ロールバック パターンを踏襲)

import { useEffect, useState } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { useLang } from "../../i18n/LangContext";

interface TenantHints {
  faq_question_hint?: string | null;
  faq_answer_hint?: string | null;
}

interface FaqHintSettingsProps {
  tenantId: string;
  isSuperAdmin: boolean;
  onHintsLoaded?: (hints: { questionHint: string | null; answerHint: string | null }) => void;
}

export default function FaqHintSettings({ tenantId, isSuperAdmin, onHintsLoaded }: FaqHintSettingsProps) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [questionHint, setQuestionHint] = useState("");
  const [answerHint, setAnswerHint] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const endpoint = isSuperAdmin
    ? `${API_BASE}/v1/admin/tenants/${tenantId}`
    : `${API_BASE}/v1/admin/my-tenant`;

  useEffect(() => {
    if (!tenantId || tenantId === "global") return;
    authFetch(endpoint)
      .then((r) => r.json())
      .then((data: TenantHints) => {
        setQuestionHint(data.faq_question_hint ?? "");
        setAnswerHint(data.faq_answer_hint ?? "");
        setLoaded(true);
        onHintsLoaded?.({
          questionHint: data.faq_question_hint ?? null,
          answerHint: data.faq_answer_hint ?? null,
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, tenantId]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async () => {
    if (saving) return;
    const prevQ = questionHint;
    const prevA = answerHint;
    setSaving(true);
    try {
      const res = await authFetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          faq_question_hint: questionHint.trim() || null,
          faq_answer_hint: answerHint.trim() || null,
        }),
      });
      if (!res.ok) {
        setQuestionHint(prevQ);
        setAnswerHint(prevA);
        showToast(t("knowledge.faq_hint_save_error"));
        return;
      }
      const updated = (await res.json()) as TenantHints;
      const nextQ = updated.faq_question_hint ?? "";
      const nextA = updated.faq_answer_hint ?? "";
      setQuestionHint(nextQ);
      setAnswerHint(nextA);
      onHintsLoaded?.({ questionHint: nextQ || null, answerHint: nextA || null });
      showToast(t("knowledge.faq_hint_saved"));
    } catch {
      setQuestionHint(prevQ);
      setAnswerHint(prevA);
      showToast(t("knowledge.faq_hint_save_error"));
    } finally {
      setSaving(false);
    }
  };

  if (!tenantId || tenantId === "global") return null;

  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: 14,
        border: "1px solid #374151",
        background: "rgba(15,23,42,0.4)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "14px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "#d1d5db",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        <span>💡 {t("knowledge.faq_hint_settings_title")}</span>
        <span style={{ color: "#6b7280", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 18px 18px" }}>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 14px", lineHeight: 1.6 }}>
            {t("knowledge.faq_hint_settings_desc")}
          </p>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>
              {t("knowledge.faq_hint_question_label")}
            </label>
            <input
              type="text"
              value={questionHint}
              onChange={(e) => setQuestionHint(e.target.value)}
              disabled={!loaded}
              maxLength={200}
              placeholder={t("modal.question_placeholder")}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>
              {t("knowledge.faq_hint_answer_label")}
            </label>
            <input
              type="text"
              value={answerHint}
              onChange={(e) => setAnswerHint(e.target.value)}
              disabled={!loaded}
              maxLength={200}
              placeholder={t("modal.answer_placeholder")}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.8)",
                color: "#e5e7eb",
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !loaded}
            style={{
              padding: "10px 20px",
              minHeight: 40,
              borderRadius: 10,
              border: "1px solid rgba(59,130,246,0.4)",
              background: saving ? "rgba(59,130,246,0.1)" : "rgba(59,130,246,0.18)",
              color: "#93c5fd",
              fontSize: 14,
              fontWeight: 600,
              cursor: saving || !loaded ? "not-allowed" : "pointer",
              opacity: saving || !loaded ? 0.6 : 1,
            }}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
          {toast && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                borderRadius: 8,
                background: toast.startsWith("❌") ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)",
                color: toast.startsWith("❌") ? "#fca5a5" : "#86efac",
                fontSize: 13,
              }}
            >
              {toast}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
