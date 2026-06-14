import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import { CARD_STYLE } from "./types";

interface SettingsHistoryEntry {
  id: number;
  tenant_id: string;
  changed_by: string;
  field_name: string;
  old_value: unknown;
  new_value: unknown;
  changed_at: string;
}

interface SettingsHistoryResponse {
  history: SettingsHistoryEntry[];
  total: number;
}

const FIELD_LABELS: Record<string, string> = {
  plan:            "プラン",
  features:        "機能フラグ",
  billing_enabled: "課金設定",
  is_active:       "有効/無効",
};

const PAGE_LIMIT = 20;

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "（未設定）";
  if (typeof v === "boolean") return v ? "ON" : "OFF";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function SettingsHistoryTab({ tenantId }: { tenantId: string }) {
  const [history, setHistory] = useState<SettingsHistoryEntry[]>([]);
  const [total, setTotal]     = useState(0);
  const [offset, setOffset]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(
          `${API_BASE}/v1/admin/tenants/${tenantId}/settings-history?limit=${PAGE_LIMIT}&offset=${offset}`
        );
        if (!res.ok) {
          setError("履歴の読み込みに失敗しました。もう一度お試しください。");
          return;
        }
        const json = await res.json() as SettingsHistoryResponse;
        setHistory(json.history);
        setTotal(json.total);
      } catch {
        setError("通信エラーが発生しました。しばらく待ってからもう一度お試しください。");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [tenantId, offset]);

  const totalPages = Math.ceil(total / PAGE_LIMIT);
  const currentPage = Math.floor(offset / PAGE_LIMIT) + 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          padding: "16px 18px",
          borderRadius: 12,
          background: "rgba(99,102,241,0.08)",
          border: "1px solid rgba(129,140,248,0.2)",
          color: "#a5b4fc",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <p style={{ margin: 0, fontWeight: 700, color: "#c7d2fe", fontSize: 14 }}>
          設定変更履歴
        </p>
        プラン・機能フラグ・課金設定・有効/無効の変更履歴を表示します。
      </div>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div
          style={{
            padding: "32px 20px",
            textAlign: "center",
            color: "var(--muted-foreground)",
            fontSize: 14,
          }}
        >
          読み込み中...
        </div>
      ) : history.length === 0 ? (
        <div
          style={{
            padding: "32px 20px",
            textAlign: "center",
            color: "var(--muted-foreground)",
            fontSize: 14,
          }}
        >
          まだ設定変更の記録がありません。
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {history.map((entry) => (
              <div key={entry.id} style={{ ...CARD_STYLE, padding: "14px 16px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--foreground)",
                      background: "rgba(99,102,241,0.15)",
                      border: "1px solid rgba(129,140,248,0.25)",
                      borderRadius: 6,
                      padding: "2px 8px",
                    }}
                  >
                    {FIELD_LABELS[entry.field_name] ?? entry.field_name}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                    {new Date(entry.changed_at).toLocaleString("ja-JP")}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: "rgba(127,29,29,0.25)",
                      border: "1px solid rgba(248,113,113,0.2)",
                      color: "#fca5a5",
                      fontFamily: "monospace",
                      wordBreak: "break-all",
                    }}
                  >
                    {formatValue(entry.old_value)}
                  </span>
                  <span style={{ color: "var(--muted-foreground)" }}>→</span>
                  <span
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: "rgba(6,78,59,0.25)",
                      border: "1px solid rgba(52,211,153,0.2)",
                      color: "#6ee7b7",
                      fontFamily: "monospace",
                      wordBreak: "break-all",
                    }}
                  >
                    {formatValue(entry.new_value)}
                  </span>
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted-foreground)" }}>
                  変更者: {entry.changed_by || "（不明）"}
                </div>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                paddingTop: 8,
              }}
            >
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
                style={{
                  padding: "10px 20px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "1px solid rgba(107,114,128,0.4)",
                  background: offset === 0 ? "rgba(107,114,128,0.1)" : "rgba(107,114,128,0.2)",
                  color: offset === 0 ? "#4b5563" : "var(--foreground)",
                  fontSize: 14,
                  cursor: offset === 0 ? "not-allowed" : "pointer",
                  opacity: offset === 0 ? 0.5 : 1,
                }}
              >
                &lt; 前
              </button>
              <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                {currentPage} / {totalPages} ページ（全 {total} 件）
              </span>
              <button
                type="button"
                disabled={offset + PAGE_LIMIT >= total}
                onClick={() => setOffset(offset + PAGE_LIMIT)}
                style={{
                  padding: "10px 20px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "1px solid rgba(107,114,128,0.4)",
                  background: offset + PAGE_LIMIT >= total ? "rgba(107,114,128,0.1)" : "rgba(107,114,128,0.2)",
                  color: offset + PAGE_LIMIT >= total ? "#4b5563" : "var(--foreground)",
                  fontSize: 14,
                  cursor: offset + PAGE_LIMIT >= total ? "not-allowed" : "pointer",
                  opacity: offset + PAGE_LIMIT >= total ? 0.5 : 1,
                }}
              >
                次 &gt;
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
