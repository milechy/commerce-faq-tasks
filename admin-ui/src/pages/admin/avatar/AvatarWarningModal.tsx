// admin-ui/src/pages/admin/avatar/AvatarWarningModal.tsx
// index.tsx から抽出 — テナント警告送信モーダル（機能変更なし）

import React, { useState } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import type { WarningTarget } from "./types";

const WARNING_REASONS = ["利用規約違反の疑い", "不適切なコンテンツ", "システムリソース過剰使用", "その他"];
const WARNING_DEADLINES = [{ label: "3日以内", days: 3 }, { label: "7日以内", days: 7 }, { label: "14日以内", days: 14 }];

export function AvatarWarningModal({ target, onClose }: { target: WarningTarget; onClose: () => void }) {
  const [reason, setReason] = useState(WARNING_REASONS[0]);
  const [deadlineDays, setDeadlineDays] = useState(3);
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const deadlineDate = new Date(Date.now() + deadlineDays * 86400000)
    .toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
  const previewTitle = `⚠️ アバター警告: ${target.name}`;
  const previewMessage = `理由: ${reason}\n対応期限: ${deadlineDate}${memo ? `\nメモ: ${memo}` : ""}`;

  const handleSend = async () => {
    setSending(true);
    setSendError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient_tenant_id: target.tenantId,
          type: "avatar_warning",
          title: previewTitle,
          message: previewMessage,
          link: "/admin/avatar",
          metadata: { avatar_config_id: target.id, reason, deadline_days: deadlineDays },
        }),
      });
      if (!res.ok) { setSendError("送信に失敗しました。もう一度お試しください。"); return; }
      setSent(true);
      setTimeout(onClose, 2000);
    } catch { setSendError("ネットワークエラーが発生しました。"); }
    finally { setSending(false); }
  };

  const INPUT_STYLE: React.CSSProperties = { padding: "8px 10px", minHeight: 44, borderRadius: 8, border: "1px solid var(--border)", background: "var(--input)", color: "var(--foreground)", fontSize: 13 };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(480px, 100%)", borderRadius: 16, background: "var(--background)", border: "1px solid rgba(239,68,68,0.3)", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--foreground)", margin: 0 }}>⚠️ 警告メッセージを送信</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 20, cursor: "pointer", padding: 4, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>テナントに警告通知を送信します。対象: <strong style={{ color: "var(--foreground)" }}>{target.name}</strong></p>

        {sent ? (
          <div style={{ textAlign: "center", padding: "20px 0", color: "#4ade80", fontSize: 16, fontWeight: 700 }}>✅ 送信しました</div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>警告理由</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} style={INPUT_STYLE}>
                {WARNING_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>対応期限</span>
              <select value={deadlineDays} onChange={(e) => setDeadlineDays(Number(e.target.value))} style={INPUT_STYLE}>
                {WARNING_DEADLINES.map((d) => (
                  <option key={d.days} value={d.days}>
                    {d.label}（{new Date(Date.now() + d.days * 86400000).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}）
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>メモ（任意）</span>
              <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} placeholder="詳細な説明やリンクなど..." style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--input)", color: "var(--foreground)", fontSize: 13, resize: "vertical", fontFamily: "inherit" }} />
            </label>

            <div style={{ padding: 12, borderRadius: 10, background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)" }}>
              <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600 }}>プレビュー</p>
              <p style={{ margin: 0, fontSize: 13, color: "#fca5a5", fontWeight: 700 }}>{previewTitle}</p>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted-foreground)", whiteSpace: "pre-line", lineHeight: 1.7 }}>{previewMessage}</p>
            </div>

            {sendError && <div style={{ color: "#fca5a5", fontSize: 13 }}>{sendError}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ padding: "10px 18px", minHeight: 44, borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>キャンセル</button>
              <button onClick={() => void handleSend()} disabled={sending} style={{ padding: "10px 18px", minHeight: 44, borderRadius: 8, border: "none", background: sending ? "#4b5563" : "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: sending ? "not-allowed" : "pointer" }}>
                {sending ? "送信中..." : "⚠️ 警告を送信"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
