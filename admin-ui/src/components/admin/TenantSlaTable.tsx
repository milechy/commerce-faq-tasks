export interface TenantSlaRow {
  tenantId: string;
  tenantName: string;
  completionRateMet: boolean;
  loopRateMet: boolean;
  fallbackRateMet: boolean;
  searchP95Met: boolean;
  errorRateMet: boolean;
  killSwitchOff: boolean;
}

interface TenantSlaTableProps {
  rows: TenantSlaRow[];
}

const COLUMNS = [
  { key: "completionRateMet" as const, label: "会話完了率" },
  { key: "loopRateMet" as const, label: "ループ検出率" },
  { key: "fallbackRateMet" as const, label: "フォールバック率" },
  { key: "searchP95Met" as const, label: "応答速度（95%ile）" },
  { key: "errorRateMet" as const, label: "エラー率" },
  { key: "killSwitchOff" as const, label: "緊急停止スイッチ" },
];

function StatusBadge({ met }: { met: boolean }) {
  return (
    <span
      style={{
        fontSize: 18,
        lineHeight: 1,
        color: met ? "#4ade80" : "#f87171",
      }}
      aria-label={met ? "達成" : "未達成"}
      title={met ? "達成" : "未達成"}
    >
      {met ? "◎" : "✗"}
    </span>
  );
}

export default function TenantSlaTable({ rows }: TenantSlaTableProps) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: "24px",
          textAlign: "center",
          color: "#6b7280",
          fontSize: 14,
          borderRadius: 12,
          border: "1px solid #1f2937",
          background: "rgba(15,23,42,0.5)",
        }}
      >
        テナントデータがありません
      </div>
    );
  }

  return (
    <div
      style={{
        overflowX: "auto",
        borderRadius: 14,
        border: "1px solid #1f2937",
        background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 14,
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                padding: "14px 16px",
                textAlign: "left",
                fontWeight: 600,
                color: "#9ca3af",
                borderBottom: "1px solid #1f2937",
                whiteSpace: "nowrap",
                background: "rgba(15,23,42,0.8)",
                fontSize: 13,
              }}
            >
              テナント名
            </th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                style={{
                  padding: "14px 12px",
                  textAlign: "center",
                  fontWeight: 600,
                  color: "#9ca3af",
                  borderBottom: "1px solid #1f2937",
                  whiteSpace: "nowrap",
                  background: "rgba(15,23,42,0.8)",
                  fontSize: 12,
                  minWidth: 80,
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const allMet =
              row.completionRateMet &&
              row.loopRateMet &&
              row.fallbackRateMet &&
              row.searchP95Met &&
              row.errorRateMet &&
              row.killSwitchOff;

            return (
              <tr
                key={row.tenantId}
                style={{
                  background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
                  transition: "background 0.15s",
                }}
              >
                <td
                  style={{
                    padding: "14px 16px",
                    fontWeight: 600,
                    color: allMet ? "#f9fafb" : "#fca5a5",
                    borderBottom: "1px solid rgba(31,41,55,0.5)",
                    whiteSpace: "nowrap",
                    fontSize: 14,
                  }}
                >
                  {row.tenantName}
                </td>
                {COLUMNS.map((col) => (
                  <td
                    key={col.key}
                    style={{
                      padding: "14px 12px",
                      textAlign: "center",
                      borderBottom: "1px solid rgba(31,41,55,0.5)",
                    }}
                  >
                    <StatusBadge met={row[col.key]} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
