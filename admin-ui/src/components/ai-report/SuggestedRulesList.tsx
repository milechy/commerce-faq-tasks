import { useState } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { CARD } from "./styles";
import type { SuggestedRule } from "./types";

export function SuggestedRulesList({
  tenantId,
  rules,
  onDecision,
}: {
  tenantId: string;
  rules: SuggestedRule[];
  onDecision: (id: string, action: "approve" | "reject") => void;
}) {
  const [processing, setProcessing] = useState<string | null>(null);

  const handleDecision = async (rule: SuggestedRule, action: "approve" | "reject") => {
    setProcessing(rule.id);
    try {
      await authFetch(`${API_BASE}/v1/admin/tuning/${rule.id}/${action}?tenantId=${tenantId}`, {
        method: "PUT",
      });
      onDecision(rule.id, action);
    } catch {
      // show inline error? keep it simple for now
    } finally {
      setProcessing(null);
    }
  };

  if (rules.length === 0) {
    return (
      <p style={{ fontSize: 14, color: "#6b7280", textAlign: "center", padding: "20px 0" }}>
        現在、提案されたルールはありません。
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {rules.map((rule) => (
        <div key={rule.id} style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>トリガー</p>
            <p style={{ margin: "0 0 8px", fontSize: 14, color: "#e5e7eb" }}>「{rule.trigger}」</p>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>提案返答</p>
            <p style={{ margin: "0 0 8px", fontSize: 14, color: "#e5e7eb", lineHeight: 1.6 }}>{rule.response}</p>
            <p style={{ margin: 0, fontSize: 12, color: "#6b7280", lineHeight: 1.5, fontStyle: "italic" }}>
              💡 {rule.reason}
            </p>
            {rule.evidence && (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "rgba(37,99,235,0.08)",
                  border: "1px solid rgba(96,165,250,0.2)",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {rule.evidence.avgScore !== undefined && (
                  <span style={{ fontSize: 12, color: "#93c5fd", fontWeight: 700 }}>
                    📊 平均スコア {rule.evidence.avgScore}
                  </span>
                )}
                {rule.evidence.effectivePrinciples && rule.evidence.effectivePrinciples.length > 0 && (
                  <span style={{ fontSize: 11, color: "#4ade80" }}>
                    ✅ {rule.evidence.effectivePrinciples.join("・")}
                  </span>
                )}
                {rule.evidence.failedPrinciples && rule.evidence.failedPrinciples.length > 0 && (
                  <span style={{ fontSize: 11, color: "#f87171" }}>
                    ❌ {rule.evidence.failedPrinciples.join("・")}
                  </span>
                )}
                {rule.evidence.evaluationIds && (
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    {rule.evidence.evaluationIds.length}件の会話を分析
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => void handleDecision(rule, "approve")}
              disabled={processing === rule.id}
              style={{
                flex: 1,
                padding: "12px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(74,222,128,0.4)",
                background: "rgba(34,197,94,0.15)",
                color: "#4ade80",
                fontSize: 15,
                fontWeight: 700,
                cursor: processing === rule.id ? "not-allowed" : "pointer",
                opacity: processing === rule.id ? 0.6 : 1,
              }}
            >
              ✅ 承認
            </button>
            <button
              onClick={() => void handleDecision(rule, "reject")}
              disabled={processing === rule.id}
              style={{
                flex: 1,
                padding: "12px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(248,113,113,0.4)",
                background: "rgba(239,68,68,0.15)",
                color: "#f87171",
                fontSize: 15,
                fontWeight: 700,
                cursor: processing === rule.id ? "not-allowed" : "pointer",
                opacity: processing === rule.id ? 0.6 : 1,
              }}
            >
              ❌ 却下
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
