import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../../lib/api";

interface PostHogStatus {
  configured: boolean;
  key_hint: string | null;
}

export default function PostHogIntegrationTab({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState<PostHogStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; status: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/status`)
      .then((r) => r.json() as Promise<PostHogStatus>)
      .then((d) => setStatus(d))
      .catch(() => setStatus({ configured: false, key_hint: null }));
  }, [tenantId]);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_api_key: apiKey.trim() }),
      });
      if (!res.ok) throw new Error();
      showToast("PostHog Project API Key を保存しました");
      setApiKey("");
      const updated = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/status`).then((r) => r.json() as Promise<PostHogStatus>);
      setStatus(updated);
    } catch {
      showToast("保存に失敗しました", false);
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/verify`, { method: "POST" });
      const d = await res.json() as { ok: boolean; status: string };
      setVerifyResult(d);
    } catch {
      setVerifyResult({ ok: false, status: "error" });
    } finally {
      setVerifying(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/posthog/disconnect`, { method: "DELETE" });
      setStatus({ configured: false, key_hint: null });
      setShowDisconnectModal(false);
      showToast("PostHog連携を解除しました");
    } catch {
      showToast("解除に失敗しました", false);
    } finally {
      setDisconnecting(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "#1e293b", borderRadius: 8, padding: "20px 24px", marginBottom: 16,
  };
  const labelStyle: React.CSSProperties = {
    display: "block", color: "#9ca3af", fontSize: 12, marginBottom: 6,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%", background: "#0f172a", border: "1px solid #334155",
    borderRadius: 6, color: "#e2e8f0", fontSize: 14, padding: "8px 12px",
  };
  const btnStyle = (color: string): React.CSSProperties => ({
    background: color, color: "#fff", border: "none", borderRadius: 6,
    padding: "8px 18px", fontSize: 13, cursor: "pointer", marginRight: 8,
  });

  return (
    <div style={{ padding: "16px 0" }}>
      {toast && (
        <div style={{
          position: "fixed", top: 16, right: 16, zIndex: 9999,
          background: toast.ok ? "#166534" : "#7f1d1d",
          color: "#fff", padding: "10px 20px", borderRadius: 8,
        }}>
          {toast.msg}
        </div>
      )}

      {/* 概要 */}
      <div style={cardStyle}>
        <div style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 600, marginBottom: 8 }}>PostHog 連携</div>
        <div style={{ color: "#9ca3af", fontSize: 13, lineHeight: 1.6 }}>
          PostHog のプロジェクト API キーを登録すると、このテナントのウィジェットから
          widget_opened / message_sent / llm_response_received / cv_macro イベントが自動送信されます。
          <br />
          LLM Analytics ($ai_generation) も自動収集されます。
        </div>
        {status && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              background: status.configured ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.2)",
              color: status.configured ? "#4ade80" : "#9ca3af",
              borderRadius: 12, padding: "2px 10px", fontSize: 12,
            }}>
              {status.configured ? "✓ 設定済み" : "未設定"}
            </span>
            {status.key_hint && (
              <span style={{ color: "#9ca3af", fontSize: 12, fontFamily: "monospace" }}>
                キー: {status.key_hint}
              </span>
            )}
          </div>
        )}
      </div>

      {/* API Key 設定 */}
      <div style={cardStyle}>
        <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Project API Key 設定
        </div>
        <label style={labelStyle}>
          PostHog Project API Key（phc_ で始まるキー）
        </label>
        <input
          type="password"
          style={inputStyle}
          placeholder="phc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          AES-256-GCM で暗号化してDBに保存されます。平文は保存されません。
        </div>
        <button
          style={{ ...btnStyle("#2563eb"), marginTop: 12, opacity: (!apiKey.trim() || saving) ? 0.5 : 1 }}
          onClick={handleSave}
          disabled={!apiKey.trim() || saving}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      {/* 接続確認 */}
      {status?.configured && (
        <div style={cardStyle}>
          <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            接続確認
          </div>
          <button style={btnStyle("#0891b2")} onClick={handleVerify} disabled={verifying}>
            {verifying ? "テスト中..." : "接続テスト実行"}
          </button>
          {verifyResult && (
            <div style={{
              marginTop: 12, padding: "10px 14px", borderRadius: 6,
              background: verifyResult.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              color: verifyResult.ok ? "#4ade80" : "#f87171", fontSize: 13,
            }}>
              {verifyResult.ok
                ? "✓ PostHog への接続を確認しました"
                : `✗ 接続エラー: ${verifyResult.status}`}
            </div>
          )}
        </div>
      )}

      {/* 連携解除 */}
      {status?.configured && (
        <div style={cardStyle}>
          <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            連携解除
          </div>
          <button style={btnStyle("#dc2626")} onClick={() => setShowDisconnectModal(true)}>
            PostHog 連携を解除する
          </button>
        </div>
      )}

      {/* 解除確認モーダル */}
      {showDisconnectModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
        }}>
          <div style={{ background: "#1e293b", borderRadius: 8, padding: 24, maxWidth: 400, width: "90%" }}>
            <div style={{ color: "#e2e8f0", fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              PostHog 連携を解除しますか？
            </div>
            <div style={{ color: "#9ca3af", fontSize: 13, marginBottom: 16 }}>
              Project API Key が削除されます。ウィジェットからのイベント送信が停止します。
            </div>
            <button style={btnStyle("#dc2626")} onClick={handleDisconnect} disabled={disconnecting}>
              {disconnecting ? "解除中..." : "解除する"}
            </button>
            <button style={btnStyle("#374151")} onClick={() => setShowDisconnectModal(false)}>
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
