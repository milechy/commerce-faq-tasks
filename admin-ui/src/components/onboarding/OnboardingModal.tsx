// admin-ui/src/components/onboarding/OnboardingModal.tsx
// GID 1216274591838389: 初回ログイン時の1問オンボーディング
// 業種を1問だけ聞き、業種別のFAQテンプレートを一括インポート提案する。

import { useState } from "react";
import { API_BASE, authFetch } from "../../lib/api";
import {
  ONBOARDING_INDUSTRIES,
  INDUSTRY_FAQ_TEMPLATES,
  type OnboardingIndustry,
} from "./industryFaqTemplates";

interface OnboardingModalProps {
  tenantId: string;
  onClose: () => void;
}

type Step = "industry" | "templates" | "done";

export default function OnboardingModal({ tenantId, onClose }: OnboardingModalProps) {
  const [step, setStep] = useState<Step>("industry");
  const [industry, setIndustry] = useState<OnboardingIndustry | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);

  const handleSelectIndustry = async (value: OnboardingIndustry) => {
    setIndustry(value);
    setSelected(new Set(INDUSTRY_FAQ_TEMPLATES[value].map((_, i) => i)));
    setError(null);
    try {
      await authFetch(`${API_BASE}/v1/admin/my-tenant`, {
        method: "PATCH",
        body: JSON.stringify({ onboarding_industry: value }),
      });
    } catch {
      // 保存失敗してもオンボーディング自体は続行する（次回また表示されるだけ）
    }
    setStep("templates");
  };

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const handleImport = async () => {
    if (!industry) return;
    const templates = INDUSTRY_FAQ_TEMPLATES[industry].filter((_, i) => selected.has(i));
    if (templates.length === 0) {
      setStep("done");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/knowledge/text/commit?tenant=${encodeURIComponent(tenantId)}`,
        {
          method: "POST",
          body: JSON.stringify({ faqs: templates }),
        }
      );
      if (!res.ok) {
        setError("インポートに失敗しました。あとでナレッジ画面から追加できます。");
        setStep("done");
        return;
      }
      const data = (await res.json()) as { inserted?: number };
      setImportedCount(data.inserted ?? templates.length);
      setStep("done");
    } catch {
      setError("インポートに失敗しました。あとでナレッジ画面から追加できます。");
      setStep("done");
    } finally {
      setSaving(false);
    }
  };

  const skipTemplates = () => setStep("done");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        padding: 20,
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1f2937",
          borderRadius: 18,
          width: "100%",
          maxWidth: 560,
          maxHeight: "85vh",
          overflowY: "auto",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          padding: "28px 26px",
        }}
      >
        {step === "industry" && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", margin: "0 0 8px" }}>
              👋 ようこそ！まず1つだけ教えてください
            </h2>
            <p style={{ fontSize: 14, color: "#9ca3af", margin: "0 0 20px", lineHeight: 1.6 }}>
              どんな業種ですか？回答に合わせて、すぐ使えるFAQのたたき台をご提案します。
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {ONBOARDING_INDUSTRIES.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => void handleSelectIndustry(opt.value)}
                  style={{
                    padding: "16px 14px",
                    minHeight: 64,
                    borderRadius: 12,
                    border: "1px solid #374151",
                    background: "rgba(255,255,255,0.03)",
                    color: "#e5e7eb",
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#3b82f6"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#374151"; }}
                >
                  <span style={{ fontSize: 22 }}>{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              style={{
                marginTop: 20,
                background: "none",
                border: "none",
                color: "#6b7280",
                fontSize: 13,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              あとで設定する
            </button>
          </>
        )}

        {step === "templates" && industry && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", margin: "0 0 8px" }}>
              📋 FAQのたたき台をご用意しました
            </h2>
            <p style={{ fontSize: 14, color: "#9ca3af", margin: "0 0 18px", lineHeight: 1.6 }}>
              チェックを外せば登録から除外できます。登録後も自由に編集・削除できます。
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {INDUSTRY_FAQ_TEMPLATES[industry].map((tpl, i) => (
                <label
                  key={i}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: `1px solid ${selected.has(i) ? "rgba(59,130,246,0.4)" : "#374151"}`,
                    background: selected.has(i) ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.02)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => toggle(i)}
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#f3f4f6" }}>Q: {tpl.question}</div>
                    <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 2 }}>A: {tpl.answer}</div>
                  </div>
                </label>
              ))}
            </div>
            {error && (
              <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(127,29,29,0.4)", color: "#fca5a5", fontSize: 13 }}>
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={skipTemplates}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: "14px",
                  minHeight: 48,
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "transparent",
                  color: "#9ca3af",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                スキップ
              </button>
              <button
                onClick={() => void handleImport()}
                disabled={saving}
                style={{
                  flex: 2,
                  padding: "14px",
                  minHeight: 48,
                  borderRadius: 10,
                  border: "none",
                  background: saving ? "#1e3a5f" : "linear-gradient(135deg, #1d4ed8, #3b82f6)",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "登録中..." : `選択した${selected.size}件を登録する`}
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <span style={{ fontSize: 44, display: "block", marginBottom: 12 }}>✅</span>
            <h2 style={{ fontSize: 19, fontWeight: 700, color: "#f9fafb", margin: "0 0 8px" }}>
              準備完了です！
            </h2>
            <p style={{ fontSize: 14, color: "#9ca3af", margin: "0 0 24px", lineHeight: 1.6 }}>
              {importedCount > 0
                ? `${importedCount}件のFAQを登録しました。ナレッジ画面でいつでも編集できます。`
                : "ナレッジ画面からいつでもFAQを追加できます。"}
            </p>
            <button
              onClick={onClose}
              style={{
                padding: "14px 32px",
                minHeight: 48,
                borderRadius: 10,
                border: "none",
                background: "linear-gradient(135deg, #22c55e, #4ade80)",
                color: "#022c22",
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              はじめる
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
