// admin-ui/src/components/admin/ShopifyDeletionQueueCard.tsx
//
// Super Admin監視画面(monitoring/index.tsx)向け。GET /v1/admin/shopify/deletion-queue の
// 応答をそのまま表示するだけの表示専用コンポーネント(判定ロジックはサーバ側に置く。
// CLAUDE.md 禁止17: 集計値をLLM生成文で出さない、と同じ理由でクライアント側でも
// severity等の判定を再実装しない)。
//
// D15/FR-16/§7 D-5: shop/redact 受信後の削除保留(人間承認前)の件数・期限を監視する。
// 禁止50: 保留0件のときも「異常なし」の言い回しにせず、中立に「保留0件」と表示する
// (WordPress経由テナントの総量ガードカードと同じ流儀、monitoring/index.tsx 参照)。

export interface ShopifyDeletionQueueItem {
  tenantId: string;
  shopDomain: string | null;
  deletionRequestedAt: string;
  deadline: string;
  daysUntilDeadline: number;
  severity: "warning" | "alert" | "critical" | null;
}

export interface ShopifyDeletionQueueData {
  pending: ShopifyDeletionQueueItem[];
  total: number;
}

const SEVERITY_LABEL: Record<NonNullable<ShopifyDeletionQueueItem["severity"]>, string> = {
  warning: "まもなく期限",
  alert: "本日が期限",
  critical: "期限超過",
};

const SEVERITY_COLOR: Record<NonNullable<ShopifyDeletionQueueItem["severity"]>, string> = {
  warning: "#fbbf24",
  alert: "#f87171",
  critical: "#f87171",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
}

export default function ShopifyDeletionQueueCard({ data }: { data: ShopifyDeletionQueueData }) {
  const alerting = data.pending.filter((item) => item.severity !== null);

  return (
    <div
      style={{
        flex: "1 1 260px",
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "var(--card)",
        padding: "18px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
        Shopify削除保留(shop/redact)
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>保留件数</span>
        <span
          style={{
            fontSize: 24,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            color: alerting.length > 0 ? "#f87171" : "var(--foreground)",
          }}
        >
          {data.total.toLocaleString("ja-JP")}
        </span>
      </div>

      {data.total === 0 ? (
        // 禁止50: 0件を「異常なし」と表示せず、中立に「保留0件」と伝える。
        <p style={{ margin: 0, fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.6 }}>
          削除保留中のテナントはありません(保留0件)。
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.pending.map((item) => (
            <div
              key={item.tenantId}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                padding: "8px 10px",
                borderRadius: 8,
                border: `1px solid ${item.severity ? "rgba(248,113,113,0.35)" : "var(--border)"}`,
                background: item.severity ? "rgba(248,113,113,0.08)" : "transparent",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
                  {item.shopDomain ?? item.tenantId}
                </span>
                {item.severity && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: SEVERITY_COLOR[item.severity] }}>
                    {SEVERITY_LABEL[item.severity]}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                期限: {formatDate(item.deadline)}
                {item.daysUntilDeadline >= 0
                  ? `(残り${item.daysUntilDeadline}日)`
                  : `(${Math.abs(item.daysUntilDeadline)}日超過)`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
        受信日+30日以内に人間の承認が必要です(D15)。実削除は自動実行されません。
      </div>
    </div>
  );
}
