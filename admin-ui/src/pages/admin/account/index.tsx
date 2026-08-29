// admin-ui/src/pages/admin/account/index.tsx
// ログイン中のユーザー自身のアカウント設定。現状はパスワード変更のみ。
//
// なぜ必要か:
// パスワードを変更する手段が ResetPassword.tsx(ログイン前)しか無く、
// 「忘れていないのに、忘れた人向けの導線でログアウトしてやり直す」しかなかった。
// super_admin / client_admin を問わず全ユーザーが対象。
//
// 現在のパスワードを要求しない理由:
// supabase.auth.updateUser は確立済みセッションに対して動くため、Supabase 側で
// 既に本人性が検証されている(ResetPassword.tsx と同じ仕組み)。二重に問うと
// 「セッションはあるのにパスワードを思い出せない」ケースを自分で塞いでしまう。

import { useState } from "react";
import type { CSSProperties } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { useAuth } from "../../../auth/useAuth";
import { useLang } from "../../../i18n/LangContext";

const PAGE: CSSProperties = {
  padding: "80px 24px 48px",
  maxWidth: 640,
  margin: "0 auto",
  color: "var(--foreground)",
  fontFamily: "system-ui, sans-serif",
};
const CARD: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "20px 24px",
  marginBottom: 16,
};
const SECTION_TITLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "var(--foreground)",
  marginBottom: 14,
};
const INPUT: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: 14,
  boxSizing: "border-box",
};
const LABEL: CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "var(--muted-foreground)",
  marginBottom: 6,
};

const MIN_PASSWORD_LENGTH = 8;

export default function AccountPage() {
  const { t } = useLang();
  const { user, isSuperAdmin } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("account.err_length"));
      return;
    }
    if (password !== confirm) {
      setError(t("account.err_mismatch"));
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(t("account.err_failed"));
      return;
    }

    // 入力欄を空にして、変更後のパスワードが画面に残らないようにする。
    setPassword("");
    setConfirm("");
    setDone(true);
  };

  return (
    <div style={PAGE}>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 24px" }}>
        {t("account.title")}
      </h1>

      <div style={CARD}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={LABEL}>{t("account.email")}</div>
            <div style={{ fontSize: 14 }}>{user?.email ?? "—"}</div>
          </div>
          <div>
            <div style={LABEL}>{t("account.role")}</div>
            <div style={{ fontSize: 14 }}>
              {isSuperAdmin ? "Super Admin" : (user?.tenantName ?? "Admin")}
            </div>
          </div>
        </div>
      </div>

      <div style={CARD}>
        <div style={SECTION_TITLE}>🔑 {t("account.change_password")}</div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label>
            <span style={LABEL}>{t("account.new_password")}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={INPUT}
              required
            />
          </label>

          <label>
            <span style={LABEL}>{t("account.confirm_password")}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={INPUT}
              required
            />
          </label>

          <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{t("account.hint")}</div>

          {error && (
            <div role="alert" style={{ fontSize: 13, color: "#ef4444" }}>
              {error}
            </div>
          )}
          {done && (
            <div role="status" style={{ fontSize: 13, color: "#22c55e" }}>
              {t("account.updated")}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              background: loading ? "var(--muted)" : "var(--primary)",
              color: "var(--primary-foreground)",
              fontSize: 14,
              fontWeight: 700,
              cursor: loading ? "default" : "pointer",
              alignSelf: "flex-start",
            }}
          >
            {loading ? t("account.submitting") : t("account.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
