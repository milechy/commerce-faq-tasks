import type { TenantDetail } from "./types";
import { CARD_STYLE } from "./types";

export default function BillingInfoTab({ tenant }: { tenant: TenantDetail }) {
  return (
    <div style={{ ...CARD_STYLE, display: "flex", flexDirection: "column", gap: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#d1d5db", margin: 0 }}>💳 請求情報</h3>
      <div style={{ display: "grid", gap: 10 }}>
        {[
          { label: "プラン", value: tenant.plan.toUpperCase() },
          { label: "課金有効", value: tenant.billing_enabled ? "有効" : "無効" },
          { label: "無料期間（開始）", value: tenant.billing_free_from ? new Date(tenant.billing_free_from).toLocaleDateString("ja-JP") : "—" },
          { label: "無料期間（終了）", value: tenant.billing_free_until ? new Date(tenant.billing_free_until).toLocaleDateString("ja-JP") : "—" },
        ].map(({ label, value }) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid #1f2937", fontSize: 14 }}>
            <span style={{ color: "#9ca3af" }}>{label}</span>
            <span style={{ color: "#e5e7eb", fontWeight: 600 }}>{value}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
        詳細な請求設定はSuper Admin専用の設定タブから変更できます。
      </p>
    </div>
  );
}
