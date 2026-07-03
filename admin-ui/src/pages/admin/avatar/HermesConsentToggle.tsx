// admin-ui/src/pages/admin/avatar/HermesConsentToggle.tsx
// Phase75: Hermes Agent(会話ログ学習エージェント)へのデータ提供同意 ON/OFF トグル
// （Client Adminのみ、自己完結型。ExcludeSearchToggleの楽観的更新+ロールバックパターンを踏襲）

import { useEffect, useState } from "react";
import { authFetch, API_BASE } from "../../../lib/api";

interface TenantFeatures {
  avatar: boolean;
  voice: boolean;
  rag: boolean;
  deep_research?: boolean;
  pre_dispatch?: boolean;
  hermes_raw_data_consent?: boolean;
}

export function HermesConsentToggle() {
  const [features, setFeatures] = useState<TenantFeatures | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`${API_BASE}/v1/admin/my-tenant`)
      .then((r) => r.json())
      .then((data: { features?: TenantFeatures }) => {
        setFeatures({
          avatar: data.features?.avatar ?? false,
          voice: data.features?.voice ?? false,
          rag: data.features?.rag ?? true,
          deep_research: data.features?.deep_research,
          pre_dispatch: data.features?.pre_dispatch,
          hermes_raw_data_consent: data.features?.hermes_raw_data_consent ?? false,
        });
      })
      .catch(() => {});
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const consentGranted = features?.hermes_raw_data_consent === true;

  const handleToggle = async () => {
    if (!features || saving) return;
    const next = !consentGranted;
    const prev = features;

    // 楽観的更新
    setFeatures({ ...features, hermes_raw_data_consent: next });
    setSaving(true);

    try {
      const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: { ...prev, hermes_raw_data_consent: next } }),
      });

      if (!res.ok) {
        setFeatures(prev); // ロールバック
        showToast("❌ 保存に失敗しました。もう一度お試しください。");
        return;
      }

      const updated = (await res.json()) as { features?: TenantFeatures };
      setFeatures({ ...prev, ...updated.features });
      showToast(
        next
          ? "✅ Hermes Agentへのデータ提供に同意しました"
          : "✅ 同意を取り消しました",
      );
    } catch {
      setFeatures(prev); // ロールバック
      showToast("❌ 保存に失敗しました。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        marginBottom: 24,
        padding: "20px 24px",
        borderRadius: 14,
        border: consentGranted
          ? "1px solid rgba(74,222,128,0.35)"
          : "1px solid rgba(107,114,128,0.3)",
        background: consentGranted
          ? "rgba(34,197,94,0.07)"
          : "rgba(255,255,255,0.03)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            🧠 Hermes Agent 学習への同意
          </h2>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "6px 0 0", maxWidth: 480 }}>
            ONにすると、貴社の会話ログ(QA AI・アバターの応答)がHermes Agentの学習・CVR向上のための分析に利用されます。いつでもOFFに戻せます。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={saving || features === null}
          aria-pressed={consentGranted}
          aria-label={
            consentGranted
              ? "Hermes Agentへのデータ提供同意を取り消す"
              : "Hermes Agentへのデータ提供に同意する"
          }
          style={{
            padding: "12px 28px",
            minHeight: 48,
            minWidth: 120,
            borderRadius: 10,
            border: consentGranted
              ? "1px solid rgba(74,222,128,0.5)"
              : "1px solid rgba(107,114,128,0.4)",
            background: consentGranted
              ? "rgba(34,197,94,0.22)"
              : "rgba(107,114,128,0.18)",
            color: consentGranted ? "#4ade80" : "#9ca3af",
            fontSize: 16,
            fontWeight: 700,
            cursor: saving || features === null ? "not-allowed" : "pointer",
            opacity: saving || features === null ? 0.6 : 1,
            transition: "all 0.15s",
          }}
        >
          {saving ? "保存中..." : consentGranted ? "✅ 同意済み" : "⏸️ 未同意"}
        </button>
      </div>
      {toast && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 8,
            background: toast.startsWith("❌")
              ? "rgba(239,68,68,0.12)"
              : "rgba(34,197,94,0.12)",
            color: toast.startsWith("❌") ? "#fca5a5" : "#86efac",
            fontSize: 14,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
