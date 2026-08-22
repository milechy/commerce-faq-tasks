import { useState, type Dispatch, type SetStateAction } from "react";
import type { Evaluation } from "./types";
import { SuggestedRulesCard } from "./SuggestedRulesCard";
import { authFetch, API_BASE } from "../../../lib/api";

// ─── Judge評価セクション（AI品質評価） ─────────────────────────────────────────

// POST /v1/admin/evaluations/trigger のレスポンスに応じたフィードバック文言。
// 200/404/409/422/500 の意味論は Phase45(#823/#829) と Phase75(#839) で確定済み。
function triggerErrorMessage(status: number, body: { error?: string; message?: string } | null): string {
  switch (status) {
    case 404:
      return "セッションが見つかりません（削除された、または他テナントのセッションの可能性があります）";
    case 409:
      return "既に評価済みです（画面を更新してください）";
    case 422:
      return body?.message ?? "会話が短すぎるため評価対象外です";
    default:
      return "評価の実行に失敗しました。しばらくしてから再度お試しください";
  }
}

export function JudgeEvaluationSection({
  evaluation,
  isSuperAdmin,
  setEvaluation,
  sessionId,
}: {
  evaluation: Evaluation | null;
  isSuperAdmin: boolean;
  setEvaluation: Dispatch<SetStateAction<Evaluation | null>>;
  sessionId?: string;
}) {
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const handleTrigger = async () => {
    if (!sessionId || triggering) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/evaluations/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setEvaluation(body?.evaluation ?? null);
        return;
      }
      setTriggerError(triggerErrorMessage(res.status, body));
    } catch {
      setTriggerError("通信に失敗しました。しばらくしてから再度お試しください");
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div
      style={{
        marginTop: 8,
        padding: "20px 18px",
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "linear-gradient(145deg, var(--card), var(--card))",
      }}
    >
      <p style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>
        🤖 AI品質評価 (Judge)
      </p>
      {evaluation == null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
          <span style={{
            display: "inline-flex", alignItems: "center", padding: "4px 12px",
            borderRadius: 999, fontSize: 12, fontWeight: 700,
            background: "rgba(107,114,128,0.15)", border: "1px solid rgba(107,114,128,0.3)", color: "var(--muted-foreground)",
          }}>未評価</span>
          {sessionId && (
            <button
              type="button"
              onClick={() => void handleTrigger()}
              disabled={triggering}
              style={{
                padding: "8px 16px",
                minHeight: 36,
                borderRadius: 8,
                border: "1px solid rgba(96,165,250,0.4)",
                background: triggering ? "rgba(96,165,250,0.1)" : "rgba(96,165,250,0.15)",
                color: "#93c5fd",
                fontSize: 13,
                fontWeight: 600,
                cursor: triggering ? "not-allowed" : "pointer",
              }}
            >
              {triggering ? "評価を実行中…" : "今すぐ評価を実行"}
            </button>
          )}
          {triggerError && (
            <p style={{ margin: 0, fontSize: 12, color: "#fca5a5", lineHeight: 1.5 }}>
              {triggerError}
            </p>
          )}
        </div>
      ) : (() => {
        const overall = evaluation.overall_score ?? evaluation.score;
        const scoreColor = overall >= 80 ? "#4ade80" : overall >= 60 ? "#fbbf24" : "#f87171";
        const scoreBg = overall >= 80 ? "rgba(34,197,94,0.15)" : overall >= 60 ? "rgba(251,191,36,0.15)" : "rgba(248,113,113,0.15)";
        const scoreBorder = overall >= 80 ? "rgba(34,197,94,0.3)" : overall >= 60 ? "rgba(251,191,36,0.3)" : "rgba(248,113,113,0.3)";
        const AXES = [
          { key: "psychology_fit_score" as const, label: "心理対応力" },
          { key: "customer_reaction_score" as const, label: "顧客対応力" },
          { key: "stage_progress_score" as const, label: "商談進行力" },
          { key: "taboo_violation_score" as const, label: "禁止事項の遵守率" },
        ];
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 14px",
              borderRadius: 999, fontSize: 15, fontWeight: 700,
              background: scoreBg, border: `1px solid ${scoreBorder}`, color: scoreColor,
              width: "fit-content",
            }}>
              総合スコア {overall}/100
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {AXES.map(({ key, label }) => {
                const s = evaluation[key];
                if (s == null) return null;
                const c = s >= 80 ? "#4ade80" : s >= 60 ? "#fbbf24" : "#f87171";
                return (
                  <span key={key} style={{
                    padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                    background: "rgba(31,41,55,0.8)", border: "1px solid var(--border)", color: c,
                  }}>
                    {label}: {s}
                  </span>
                );
              })}
            </div>
            {evaluation.feedback?.summary && (
              <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.6, padding: "10px 12px", borderRadius: 8, background: "rgba(31,41,55,0.6)", border: "1px solid var(--border)" }}>
                {evaluation.feedback.summary}
              </p>
            )}
            {isSuperAdmin && Array.isArray(evaluation.suggested_rules) && evaluation.suggested_rules.length > 0 && (
              <SuggestedRulesCard
                evaluationId={evaluation.id}
                rules={evaluation.suggested_rules}
                onUpdate={(updated) => setEvaluation((prev) => prev ? { ...prev, suggested_rules: updated } : prev)}
              />
            )}
          </div>
        );
      })()}
    </div>
  );
}
