import type { Dispatch, SetStateAction } from "react";

// ─── 営業結果入力セクション（Client Adminのみ表示） ────────────────────────────

export function OutcomeSection({
  outcome,
  outcomeRecordedAt,
  outcomeRecordedBy,
  setOutcome,
  setOutcomeRecordedAt,
  setOutcomeRecordedBy,
  conversionTypes,
  outcomeSubmitting,
  handleOutcome,
}: {
  outcome: string | null;
  outcomeRecordedAt: string | null;
  outcomeRecordedBy: string | null;
  setOutcome: Dispatch<SetStateAction<string | null>>;
  setOutcomeRecordedAt: Dispatch<SetStateAction<string | null>>;
  setOutcomeRecordedBy: Dispatch<SetStateAction<string | null>>;
  conversionTypes: string[];
  outcomeSubmitting: boolean;
  handleOutcome: (value: string) => Promise<void>;
}) {
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
      <p
        style={{
          margin: "0 0 14px",
          fontSize: 15,
          fontWeight: 700,
          color: "var(--foreground)",
        }}
      >
        この会話の営業結果を記録
      </p>
      {/* 記録済み情報 */}
      {outcome && outcomeRecordedAt && (
        <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(5,46,22,0.4)", border: "1px solid rgba(74,222,128,0.2)", fontSize: 12, color: "#86efac" }}>
          ✓ 記録済み: {new Date(outcomeRecordedAt).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          {outcomeRecordedBy && ` by ${outcomeRecordedBy}`}
          <button
            onClick={() => { setOutcome(null); setOutcomeRecordedAt(null); setOutcomeRecordedBy(null); }}
            style={{ marginLeft: 8, background: "none", border: "none", color: "#4ade80", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}
          >
            変更
          </button>
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
        }}
      >
        {conversionTypes.map((value) => (
          <button
            key={value}
            onClick={() => void handleOutcome(value)}
            disabled={outcomeSubmitting}
            style={{
              padding: "14px 12px",
              minHeight: 52,
              borderRadius: 10,
              border:
                outcome === value
                  ? "1px solid rgba(74,222,128,0.5)"
                  : "1px solid var(--border)",
              background:
                outcome === value
                  ? "rgba(34,197,94,0.2)"
                  : "rgba(31,41,55,0.5)",
              color: outcome === value ? "#4ade80" : "#9ca3af",
              fontSize: 15,
              fontWeight: outcome === value ? 700 : 500,
              cursor: outcomeSubmitting ? "not-allowed" : "pointer",
              opacity: outcomeSubmitting && outcome !== value ? 0.6 : 1,
              transition: "all 0.15s",
              width: "100%",
            }}
          >
            {outcome === value ? `✓ ${value}` : value}
          </button>
        ))}
      </div>
    </div>
  );
}
