import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import { CARD_STYLE } from "./types";

interface NotificationPref {
  notification_type: string;
  email_enabled: boolean;
  in_app_enabled: boolean;
  threshold: Record<string, unknown> | null;
}

const DEFAULT_NOTIFICATION_TYPES = [
  { type: "ga4_error", label: "GA4接続エラー" },
  { type: "cv_drop", label: "CV数急減" },
  { type: "llm_cost_spike", label: "LLMコスト急増" },
  { type: "weekly_report", label: "週次レポート" },
];

export default function NotificationPreferencesTab({ tenantId }: { tenantId: string }) {
  const [prefs, setPrefs] = useState<Record<string, NotificationPref>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    const load = async () => {
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/notification-preferences`);
        if (!res.ok) return;
        const json = await res.json() as { preferences: NotificationPref[] };
        const map: Record<string, NotificationPref> = {};
        for (const p of json.preferences) map[p.notification_type] = p;
        setPrefs(map);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [tenantId]);

  const handleToggle = async (type: string, field: "email_enabled" | "in_app_enabled") => {
    const current = prefs[type] ?? { notification_type: type, email_enabled: true, in_app_enabled: true, threshold: null };
    const updated = { ...current, [field]: !current[field] };
    setSaving(type);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/notification-preferences`, {
        method: "PUT",
        body: JSON.stringify({ notification_type: type, email_enabled: updated.email_enabled, in_app_enabled: updated.in_app_enabled }),
      });
      if (res.ok) {
        setPrefs((prev) => ({ ...prev, [type]: updated }));
        showToast("✅ 保存しました");
      }
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div style={{ color: "var(--muted-foreground)", textAlign: "center", padding: 32 }}>読み込み中...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {toast && (
        <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--card)", border: "1px solid #22c55e", color: "#4ade80", fontSize: 14, fontWeight: 600 }}>
          {toast}
        </div>
      )}
      <div style={{ ...CARD_STYLE }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--muted-foreground)", margin: "0 0 16px" }}>🔔 通知設定</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {DEFAULT_NOTIFICATION_TYPES.map(({ type, label }) => {
            const pref = prefs[type] ?? { notification_type: type, email_enabled: true, in_app_enabled: true, threshold: null };
            const isSavingThis = saving === type;
            return (
              <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                <span style={{ fontSize: 14, color: "var(--muted-foreground)", fontWeight: 500 }}>{label}</span>
                <div style={{ display: "flex", gap: 12 }}>
                  {(["email_enabled", "in_app_enabled"] as const).map((field) => (
                    <button
                      key={field}
                      type="button"
                      disabled={isSavingThis}
                      onClick={() => void handleToggle(type, field)}
                      style={{
                        padding: "6px 14px",
                        minHeight: 32,
                        borderRadius: 6,
                        border: pref[field] ? "1px solid #4ade80" : "1px solid var(--border)",
                        background: pref[field] ? "rgba(34,197,94,0.15)" : "rgba(0,0,0,0.3)",
                        color: pref[field] ? "#4ade80" : "#6b7280",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: isSavingThis ? "not-allowed" : "pointer",
                        opacity: isSavingThis ? 0.5 : 1,
                      }}
                    >
                      {field === "email_enabled" ? "📧 メール" : "🔔 アプリ内"}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
