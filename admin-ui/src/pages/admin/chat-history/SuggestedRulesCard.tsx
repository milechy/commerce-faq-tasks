import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../../lib/api";
import type { SuggestedRule } from "./types";

// ─── AI提案ルール承認カード (Super Admin only) ─────────────────────────────────

export function SuggestedRulesCard({
  evaluationId,
  rules,
  onUpdate,
}: {
  evaluationId: number;
  rules: SuggestedRule[];
  onUpdate: (updated: SuggestedRule[]) => void;
}) {
  const navigate = useNavigate();
  const [processing, setProcessing] = useState<number | null>(null);

  const pending = rules.filter((r) => !r.status || r.status === "pending");
  const approved = rules.filter((r) => r.status === "approved");
  if (pending.length === 0 && approved.length === 0) return null;

  const handleAction = async (ruleIndex: number, action: "approve" | "reject") => {
    setProcessing(ruleIndex);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/evaluations/${evaluationId}/rules/${ruleIndex}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) },
      );
      if (res.ok) {
        const json = await res.json() as { tuning_rule_id?: number };
        const updated = rules.map((r, i) =>
          i === ruleIndex
            ? { ...r, status: action === "approve" ? "approved" : "rejected", tuning_rule_id: json.tuning_rule_id }
            : r,
        );
        onUpdate(updated);
      }
    } finally {
      setProcessing(null);
    }
  };

  const totalShown = pending.length + approved.length;

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#c4b5fd" }}>
        💡 AI提案ルール ({totalShown}件)
      </p>
      {rules.map((rule, idx) => {
        const isApproved = rule.status === "approved";
        const isPending = !rule.status || rule.status === "pending";
        if (!isPending && !isApproved) return null;
        const busy = processing === idx;
        return (
          <div
            key={idx}
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: isApproved ? "rgba(34,197,94,0.06)" : "rgba(124,58,237,0.08)",
              border: `1px solid ${isApproved ? "rgba(74,222,128,0.2)" : "rgba(196,181,253,0.2)"}`,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <p style={{ margin: 0, fontSize: 13, color: "var(--foreground)", lineHeight: 1.6 }}>
              {rule.rule_text}
            </p>
            {isApproved ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "#4ade80", fontWeight: 600 }}>✅ 承認済み</span>
                <button
                  onClick={() => {
                    const params = new URLSearchParams();
                    if (rule.tuning_rule_id) params.set("editId", String(rule.tuning_rule_id));
                    navigate(`/admin/tuning?${params.toString()}`);
                  }}
                  style={{
                    padding: "6px 12px", minHeight: 32, borderRadius: 6,
                    border: "1px solid rgba(148,163,184,0.3)", background: "rgba(148,163,184,0.1)",
                    color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  ✏️ 編集
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => void handleAction(idx, "approve")}
                  disabled={busy}
                  style={{
                    flex: 1, padding: "10px 12px", minHeight: 44, borderRadius: 8,
                    border: "1px solid rgba(74,222,128,0.4)", background: "rgba(34,197,94,0.15)",
                    color: "#4ade80", fontSize: 14, fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
                  }}
                >
                  ✅ 承認してルールに追加
                </button>
                <button
                  onClick={() => void handleAction(idx, "reject")}
                  disabled={busy}
                  style={{
                    padding: "10px 16px", minHeight: 44, borderRadius: 8,
                    border: "1px solid rgba(248,113,113,0.4)", background: "rgba(239,68,68,0.15)",
                    color: "#f87171", fontSize: 14, fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
                  }}
                >
                  ❌ 却下
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
