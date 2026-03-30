import { useState } from "react";
import { API_BASE } from "../lib/api";
import { supabase } from "../lib/supabaseClient";

interface Props {
  tenantId: string;
  onClose: () => void;
  onSuccess: (newKey: string) => void;
}

async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Clipboard API（HTTPS環境）
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }

  // 2. execCommandフォールバック（HTTP環境）
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const result = document.execCommand('copy');
    document.body.removeChild(textarea);
    return result;
  } catch {
    return false;
  }
}

async function issueApiKey(tenantId: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token ?? null;
  if (!token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    token = refreshed.session?.access_token ?? null;
  }
  if (!token) throw new Error("認証が必要です");

  const res = await fetch(`${API_BASE}/v1/admin/tenants/${tenantId}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { api_key?: string; key?: string; apiKey?: string; plaintext?: string };
  const key = json.api_key ?? json.key ?? json.apiKey ?? json.plaintext;
  if (!key) throw new Error("APIキーが返されませんでした");
  return key;
}

export default function ApiKeyCreateModal({ tenantId, onClose, onSuccess }: Props) {
  const [phase, setPhase] = useState<"confirm" | "issued">("confirm");
  const [newKey, setNewKey] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleIssue = async () => {
    setLoading(true);
    setError(null);
    try {
      const key = await issueApiKey(tenantId);
      setNewKey(key);
      setPhase("issued");
    } catch {
      setError("APIキーの発行に失敗しました。もう一度お試しください 🙏");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    const success = await copyToClipboard(newKey);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    if (phase === "issued") {
      onSuccess(newKey);
    }
    onClose();
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1f2937",
          borderRadius: 16,
          padding: "28px 24px",
          maxWidth: 480,
          width: "100%",
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", margin: "0 0 20px" }}>
          🔑 APIキーの発行
        </h2>

        {error && (
          <div
            style={{
              marginBottom: 16,
              padding: "12px 16px",
              borderRadius: 10,
              background: "rgba(127,29,29,0.4)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#fca5a5",
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        {phase === "confirm" && (
          <>
            <p style={{ fontSize: 15, color: "#d1d5db", marginBottom: 24, lineHeight: 1.6 }}>
              新しいAPIキーを発行しますか？<br />
              発行されたキーは一度だけ表示されます。
            </p>
            <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
              <button
                onClick={handleIssue}
                disabled={loading}
                style={{
                  padding: "16px 24px",
                  minHeight: 56,
                  borderRadius: 12,
                  border: "none",
                  background: loading
                    ? "rgba(34,197,94,0.4)"
                    : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                  color: "#022c22",
                  fontSize: 17,
                  fontWeight: 700,
                  cursor: loading ? "not-allowed" : "pointer",
                  width: "100%",
                }}
              >
                {loading ? "⏳ 発行中..." : "🔑 発行する"}
              </button>
              <button
                onClick={onClose}
                disabled={loading}
                style={{
                  padding: "14px 24px",
                  minHeight: 48,
                  borderRadius: 12,
                  border: "1px solid #374151",
                  background: "transparent",
                  color: "#9ca3af",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                キャンセル
              </button>
            </div>
          </>
        )}

        {phase === "issued" && (
          <>
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                background: "rgba(120,53,15,0.4)",
                border: "1px solid rgba(251,191,36,0.3)",
                color: "#fbbf24",
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 20,
                lineHeight: 1.5,
              }}
            >
              ⚠️ このキーは一度だけ表示されます。必ずコピーしてください。
            </div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 18,
                letterSpacing: "0.05em",
                wordBreak: "break-all",
                color: "#86efac",
                background: "rgba(0,0,0,0.5)",
                border: "1px solid #374151",
                borderRadius: 10,
                padding: "16px",
                marginBottom: 20,
                userSelect: "text",
                cursor: "text",
              }}
            >
              {newKey}
            </div>
            <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
              <button
                onClick={handleCopy}
                style={{
                  padding: "16px 24px",
                  minHeight: 56,
                  borderRadius: 12,
                  border: "none",
                  background: copied
                    ? "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)"
                    : "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
                  color: "#022c22",
                  fontSize: 17,
                  fontWeight: 700,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                {copied ? "✅ コピーしました！" : "📋 コピー"}
              </button>
              <button
                onClick={handleClose}
                style={{
                  padding: "14px 24px",
                  minHeight: 48,
                  borderRadius: 12,
                  border: "1px solid #374151",
                  background: "transparent",
                  color: "#9ca3af",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                閉じる
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
