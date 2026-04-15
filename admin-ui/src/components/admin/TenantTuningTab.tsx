// admin-ui/src/components/admin/TenantTuningTab.tsx
// Phase4-B: テナント詳細ハブ — チューニングタブ

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/useAuth";
import { authFetch, API_BASE } from "../../lib/api";
import TuningRuleModal, {
  type TuningRule,
} from "../tuning/TuningRuleModal";

interface Props {
  tenantId: string;
  tenantName: string;
}

async function fetchRules(tenantId: string): Promise<TuningRule[]> {
  const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules?tenant=${tenantId}`);
  if (!res.ok) throw new Error("load_error");
  const data = await res.json() as { rules: TuningRule[] };
  return data.rules;
}

async function deleteRule(id: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("delete_error");
}

async function toggleRule(id: number, is_active: boolean): Promise<void> {
  const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_active }),
  });
  if (!res.ok) throw new Error("toggle_error");
}

export default function TenantTuningTab({ tenantId, tenantName }: Props) {
  const { isSuperAdmin } = useAuth();
  const [rules, setRules] = useState<TuningRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<TuningRule | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRules(tenantId);
      setRules(data);
    } catch {
      setError("ルールの読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const handleSuccess = (message: string, _rule: TuningRule) => {
    showToast(message);
    void load();
  };

  const handleDelete = async (rule: TuningRule) => {
    if (!window.confirm(`「${rule.trigger_pattern.slice(0, 30)}...」を削除しますか？`)) return;
    try {
      await deleteRule(rule.id);
      showToast("✅ ルールを削除しました");
      void load();
    } catch {
      showToast("削除に失敗しました");
    }
  };

  const handleToggle = async (rule: TuningRule) => {
    try {
      await toggleRule(rule.id, !rule.is_active);
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, is_active: !r.is_active } : r))
      );
    } catch {
      showToast("更新に失敗しました");
    }
  };

  const tenantOptions = [{ value: tenantId, label: tenantName }];

  return (
    <div style={{ position: "relative" }}>
      {/* トースト */}
      {toast && (
        <div
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            padding: "14px 24px", borderRadius: 12,
            background: "rgba(15,23,42,0.98)", border: "1px solid #22c55e",
            color: "#4ade80", fontSize: 15, fontWeight: 600,
            zIndex: 2000, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}

      {/* ヘッダー */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 700, color: "#f9fafb" }}>
            チューニングルール
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>
            このテナントのAI応答をカスタマイズするルール一覧
          </p>
        </div>
        <button
          onClick={() => { setEditTarget(undefined); setShowModal(true); }}
          style={{
            padding: "10px 18px", minHeight: 44, borderRadius: 10,
            border: "1px solid rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.1)",
            color: "#4ade80", fontSize: 14, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          ＋ ルール追加
        </button>
      </div>

      {/* エラー */}
      {error && (
        <div style={{
          marginBottom: 16, padding: "12px 16px", borderRadius: 8, fontSize: 14,
          background: "rgba(127,29,29,0.3)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5",
        }}>
          {error}
        </div>
      )}

      {/* ローディング */}
      {loading ? (
        <div style={{ textAlign: "center", color: "#9ca3af", padding: "32px 0", fontSize: 14 }}>
          読み込み中...
        </div>
      ) : rules.length === 0 ? (
        <div style={{
          textAlign: "center", padding: "40px 20px", borderRadius: 12,
          border: "1px dashed #374151", color: "#6b7280", fontSize: 14,
        }}>
          ルールがまだ登録されていません。「＋ ルール追加」から作成してください。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                borderRadius: 12, border: "1px solid #1f2937",
                background: rule.is_active ? "rgba(15,23,42,0.8)" : "rgba(17,24,39,0.4)",
                padding: "16px 18px",
                opacity: rule.is_active ? 1 : 0.6,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                      background: rule.is_active ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.2)",
                      color: rule.is_active ? "#4ade80" : "#9ca3af",
                      border: `1px solid ${rule.is_active ? "rgba(34,197,94,0.3)" : "rgba(107,114,128,0.3)"}`,
                    }}>
                      {rule.is_active ? "有効" : "無効"}
                    </span>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>優先度: {rule.priority}</span>
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: 14, color: "#e5e7eb", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {rule.trigger_pattern}
                  </p>
                  <p style={{ margin: 0, fontSize: 13, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    → {rule.expected_behavior}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleToggle(rule)}
                    style={{
                      padding: "6px 12px", minHeight: 36, borderRadius: 8,
                      border: "1px solid #374151", background: "transparent",
                      color: "#9ca3af", fontSize: 12, cursor: "pointer",
                    }}
                  >
                    {rule.is_active ? "無効化" : "有効化"}
                  </button>
                  <button
                    onClick={() => { setEditTarget(rule); setShowModal(true); }}
                    style={{
                      padding: "6px 12px", minHeight: 36, borderRadius: 8,
                      border: "1px solid rgba(59,130,246,0.4)", background: "rgba(59,130,246,0.1)",
                      color: "#93c5fd", fontSize: 12, cursor: "pointer",
                    }}
                  >
                    編集
                  </button>
                  <button
                    onClick={() => handleDelete(rule)}
                    style={{
                      padding: "6px 12px", minHeight: 36, borderRadius: 8,
                      border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.1)",
                      color: "#f87171", fontSize: 12, cursor: "pointer",
                    }}
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* モーダル */}
      {showModal && (
        <TuningRuleModal
          mode={editTarget ? "edit" : "create"}
          initialData={editTarget}
          tenantId={tenantId}
          isSuperAdmin={isSuperAdmin}
          tenantOptions={tenantOptions}
          fromConversation={true}
          presetTenantId={tenantId}
          onClose={() => { setShowModal(false); setEditTarget(undefined); }}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
