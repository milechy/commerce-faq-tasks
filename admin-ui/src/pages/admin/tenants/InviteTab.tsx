import { useState } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import { CARD_STYLE } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteResponse {
  error?: string;
  message?: string;
  ok?: boolean;
  email?: string;
}

/**
 * 招待APIは「メール送信」→「app_metadataへのrole/tenant_id設定」の2段階で、
 * ロールバックが無い（POST /:id/invite、backend側の既知の弱さ）。
 * metadata_update_failed は「招待メールは送信済みだがロール未設定」という
 * 中間状態を表すため、他の失敗（招待自体が届いていない）と文言を分ける。
 */
function messageFor(status: number, body: InviteResponse | null): string {
  if (body?.error === "metadata_update_failed") {
    return `招待メールは送信されました（${body.email ?? ""}）が、ロール設定に失敗しました。手動で設定するか、管理者にお問い合わせください。`;
  }
  if (body?.error === "invite_failed") {
    return body.message ?? "招待メールの送信に失敗しました。時間をおいて再度お試しください。";
  }
  if (body?.error === "tenant_disabled") {
    return "このテナントは無効化されているため、ユーザーを招待できません。";
  }
  if (body?.error === "not_found") {
    return "テナントが見つかりません。";
  }
  if (status === 503) {
    return "招待機能が現在利用できません（Supabase Admin未設定）。管理者にお問い合わせください。";
  }
  if (body?.message) {
    return body.message;
  }
  return "招待処理に失敗しました。時間をおいて再度お試しください。";
}

export function InviteTab({ tenantId }: { tenantId: string }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { kind: "success"; message: string } | { kind: "error"; message: string } | null
  >(null);

  const trimmed = email.trim();
  const isValid = EMAIL_PATTERN.test(trimmed);

  const handleSubmit = async () => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tenants/${tenantId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      let body: InviteResponse | null = null;
      try {
        body = (await res.json()) as InviteResponse;
      } catch {
        body = null;
      }
      if (res.ok) {
        setResult({
          kind: "success",
          message: `${trimmed} を client_admin として招待しました。招待メールをご確認ください。`,
        });
        setEmail("");
      } else {
        setResult({ kind: "error", message: messageFor(res.status, body) });
      }
    } catch {
      setResult({
        kind: "error",
        message: "通信エラーが発生しました。しばらく待ってからもう一度お試しください。",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={CARD_STYLE}>
      <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700 }}>
        client_admin を招待
      </h3>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted-foreground)" }}>
        メールアドレスを入力すると、このテナントの client_admin として招待メールが送信されます。
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="email"
          value={email}
          placeholder="user@example.com"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          style={{
            flex: 1,
            minWidth: 240,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--background)",
            color: "var(--foreground)",
            fontSize: 14,
          }}
          aria-label="招待するメールアドレス"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!isValid || submitting}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: "none",
            background: !isValid || submitting ? "var(--muted)" : "var(--primary)",
            color: !isValid || submitting ? "var(--muted-foreground)" : "var(--primary-foreground)",
            fontWeight: 600,
            fontSize: 14,
            cursor: !isValid || submitting ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "送信中…" : "招待メールを送信"}
        </button>
      </div>

      {trimmed.length > 0 && !isValid && (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--destructive, #dc2626)" }}>
          有効なメールアドレスを入力してください。
        </p>
      )}

      {result && (
        <div
          role="status"
          style={{
            marginTop: 16,
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 13,
            background:
              result.kind === "success"
                ? "rgba(34, 197, 94, 0.12)"
                : "rgba(220, 38, 38, 0.12)",
            color: result.kind === "success" ? "#16a34a" : "#dc2626",
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}
