import { useState } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import type { TenantDetail } from "./types";

export default function ConversionTypesTab({
  tenant,
  onUpdate,
}: {
  tenant: TenantDetail;
  onUpdate: (updated: TenantDetail) => void;
}) {
  const [types, setTypes] = useState<string[]>(tenant.conversion_types ?? ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"]);
  const [newType, setNewType] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ msg: string; ok: boolean } | null>(null);

  const showMsg = (msg: string, ok: boolean) => {
    setSaveMsg({ msg, ok });
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const addType = () => {
    const trimmed = newType.trim();
    if (!trimmed) return;
    if (trimmed.length > 50) { showMsg("50文字以内で入力してください", false); return; }
    if (types.includes(trimmed)) { showMsg("同じタイプがすでに存在します", false); return; }
    if (types.length >= 10) { showMsg("最大10件まで登録できます", false); return; }
    setTypes([...types, trimmed]);
    setNewType("");
  };

  const removeType = (t: string) => setTypes(types.filter((x) => x !== t));

  const handleSave = async () => {
    if (types.length === 0) { showMsg("少なくとも1件必要です", false); return; }
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ conversion_types: types }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as any;
      const json = "tenant" in raw ? raw.tenant : raw;
      onUpdate({
        ...json,
        status: json.is_active ? "active" : "inactive",
        allowed_origins: json.allowed_origins ?? [],
        billing_enabled: json.billing_enabled ?? false,
        billing_free_from: json.billing_free_from ?? null,
        billing_free_until: json.billing_free_until ?? null,
        features: json.features ?? { avatar: false, voice: false, rag: true },
        lemonslice_agent_id: json.lemonslice_agent_id ?? null,
        conversion_types: json.conversion_types ?? types,
      } as TenantDetail);
      showMsg("✅ コンバージョンタイプを保存しました", true);
    } catch {
      showMsg("保存に失敗しました", false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p style={{ fontSize: 14, color: "#9ca3af", marginBottom: 20 }}>
        お客様の行動結果のカテゴリを設定します。会話詳細ページでこのカテゴリを選んで成果を記録できます。
      </p>
      {saveMsg && (
        <div style={{ marginBottom: 16, padding: "10px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600,
          background: saveMsg.ok ? "rgba(5,46,22,0.5)" : "rgba(127,29,29,0.4)",
          border: `1px solid ${saveMsg.ok ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
          color: saveMsg.ok ? "#86efac" : "#fca5a5",
        }}>
          {saveMsg.msg}
        </div>
      )}
      {/* タイプ一覧 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
        {types.map((t) => (
          <span key={t} style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "6px 12px", borderRadius: 999, fontSize: 14,
            background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#93c5fd",
          }}>
            {t}
            <button
              onClick={() => removeType(t)}
              style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
              title="削除"
            >
              ×
            </button>
          </span>
        ))}
        {types.length === 0 && <span style={{ fontSize: 14, color: "#6b7280" }}>タイプが登録されていません</span>}
      </div>
      {/* 追加フォーム */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          type="text"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addType(); } }}
          placeholder="新しいタイプを追加（例: 資料請求）"
          maxLength={50}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 8,
            border: "1px solid #374151", background: "rgba(255,255,255,0.05)",
            color: "#f9fafb", fontSize: 14,
          }}
        />
        <button
          onClick={addType}
          disabled={!newType.trim() || types.length >= 10}
          style={{
            padding: "0 18px", minHeight: 44, borderRadius: 8,
            border: "1px solid rgba(59,130,246,0.4)", background: "rgba(59,130,246,0.15)",
            color: "#93c5fd", fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          ＋ 追加
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 20 }}>最大10件、各50文字以内。現在 {types.length}/10 件</p>
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: "12px 24px", minHeight: 48, borderRadius: 10,
          border: "none", background: saving ? "#1f2937" : "#1d4ed8",
          color: saving ? "#6b7280" : "#fff", fontSize: 15, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "保存中..." : "保存"}
      </button>
    </div>
  );
}
