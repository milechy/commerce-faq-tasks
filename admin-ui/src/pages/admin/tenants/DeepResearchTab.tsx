import { useState } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import type { TenantDetail, TenantFeatures } from "./types";
import { CARD_STYLE } from "./types";

async function updateDeepResearchSettings(
  tenantId: string,
  deepResearch: boolean,
  currentFeatures: TenantFeatures
): Promise<TenantDetail> {
  const features: TenantFeatures = { ...currentFeatures, deep_research: deepResearch };
  const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}`, {
    method: "PATCH",
    body: JSON.stringify({ features }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await res.json()) as any;
  const json = "tenant" in raw ? raw.tenant : raw;
  return {
    ...json,
    status: json.is_active ? "active" : "inactive",
    allowed_origins: json.allowed_origins ?? [],
    billing_enabled: json.billing_enabled ?? false,
    billing_free_from: json.billing_free_from ?? null,
    billing_free_until: json.billing_free_until ?? null,
    features: json.features ?? { avatar: false, voice: false, rag: true, deep_research: false },
    lemonslice_agent_id: json.lemonslice_agent_id ?? null,
  } as TenantDetail;
}

export default function DeepResearchTab({
  tenant,
  onUpdate,
  showToast,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
  showToast: (msg: string) => void;
}) {
  const [deepResearch, setDeepResearch] = useState<boolean>(tenant.features.deep_research ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);

  const handleToggle = async () => {
    const next = !deepResearch;
    if (next) {
      // ON切り替え → 確認ダイアログ
      setConfirmPending(true);
      return;
    }
    // OFF切り替え → 即座に反映
    await save(false);
  };

  const save = async (value: boolean) => {
    setSaving(true);
    try {
      const updated = await updateDeepResearchSettings(tenant.id, value, tenant.features);
      setDeepResearch(value);
      onUpdate(updated);
      showToast("✅ 設定を保存しました");
    } catch {
      showToast("❌ 保存に失敗しました。もう一度お試しください");
    } finally {
      setSaving(false);
      setConfirmPending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box" }}>
      {/* 確認ダイアログ */}
      {confirmPending && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              background: "#111827", borderRadius: 14,
              border: "1px solid #374151",
              padding: "28px 24px", maxWidth: 400, width: "100%",
            }}
          >
            <p style={{ color: "#e5e7eb", fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>
              ディープリサーチをONにしますか？
            </p>
            <p style={{ color: "#9ca3af", fontSize: 13, margin: "0 0 24px", lineHeight: 1.6 }}>
              ディープリサーチをONにすると、追加コスト（月$3〜8程度）が発生します。よろしいですか？
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setConfirmPending(false)}
                style={{
                  padding: "10px 18px", borderRadius: 8,
                  border: "1px solid #374151", background: "transparent",
                  color: "#9ca3af", fontSize: 14, cursor: "pointer",
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => save(true)}
                disabled={saving}
                style={{
                  padding: "10px 18px", borderRadius: 8,
                  border: "none", background: saving ? "#1f2937" : "#1d4ed8",
                  color: saving ? "#6b7280" : "#fff",
                  fontSize: 14, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "保存中..." : "ONにする"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* メインカード */}
      <div
        style={{
          ...CARD_STYLE,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#e5e7eb", fontSize: 15 }}>
            🔬 ディープリサーチ（AI提案の精度向上）
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
            AIの改善提案に最新の市場動向・心理学研究を反映します
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          disabled={saving}
          aria-label="ディープリサーチ切り替え"
          style={{
            position: "relative",
            display: "inline-flex", alignItems: "center",
            width: 56, height: 32, borderRadius: 16,
            border: "none",
            background: deepResearch ? "#2563eb" : "#374151",
            cursor: saving ? "not-allowed" : "pointer",
            transition: "background 0.2s", flexShrink: 0,
            opacity: saving ? 0.6 : 1,
          }}
        >
          <span
            style={{
              display: "inline-block", width: 24, height: 24, borderRadius: "50%",
              background: "#fff",
              transform: deepResearch ? "translateX(28px)" : "translateX(4px)",
              transition: "transform 0.2s",
            }}
          />
        </button>
      </div>

      {/* ONにすると何が実現できるか */}
      <div
        style={{
          borderRadius: 12,
          border: "1px solid rgba(96,165,250,0.3)",
          background: "rgba(29,78,216,0.1)",
          padding: "16px 18px",
        }}
      >
        <p style={{ margin: "0 0 8px", fontWeight: 600, color: "#93c5fd", fontSize: 13 }}>
          ONにすると：
        </p>
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            "チューニングルール提案に最新の業界動向が反映されます",
            "ナレッジの穴の推薦精度が向上します",
            "管理画面AIアシスタントが外部の知見も参照します",
          ].map((item, i) => (
            <li key={i} style={{ color: "#bfdbfe", fontSize: 13 }}>・{item}</li>
          ))}
        </ul>
      </div>

      {/* コスト説明 */}
      <div
        style={{
          borderRadius: 10,
          border: "1px solid #1f2937",
          background: "rgba(17,24,39,0.5)",
          padding: "12px 16px",
          fontSize: 12, color: "#6b7280", lineHeight: 1.6,
        }}
      >
        <p style={{ margin: "0 0 4px" }}>💰 コスト目安：月あたり約 $3〜8 の追加（提案1回あたり約 $0.05〜0.10）</p>
        <p style={{ margin: 0 }}>※ 通常の提案機能は無料で引き続きご利用いただけます</p>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "#4b5563", textAlign: "right" }}>
        現在: <strong style={{ color: deepResearch ? "#60a5fa" : "#6b7280" }}>{deepResearch ? "ON" : "OFF"}</strong>
      </p>
    </div>
  );
}
