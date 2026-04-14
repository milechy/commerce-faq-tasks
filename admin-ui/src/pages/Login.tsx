import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

type View = "login" | "reset" | "reset_sent";

const INPUT_STYLE: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #374151",
  background: "#020617",
  color: "#e5e7eb",
  fontSize: 14,
};

const CARD_STYLE: React.CSSProperties = {
  width: 360,
  padding: 24,
  borderRadius: 16,
  background: "#020617",
  boxShadow: "0 20px 40px rgba(0,0,0,0.45)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

export default function Login() {
  const navigate = useNavigate();
  const [view, setView] = useState<View>("login");
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  // すでにログイン済みなら一覧へリダイレクト
  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        navigate("/faqs", { replace: true });
      }
    })();
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    navigate("/");
  };

  const handleResetPassword = async () => {
    setResetError(null);
    setResetLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setResetLoading(false);

    if (error) {
      setResetError("メール送信に失敗しました。メールアドレスをご確認ください。");
    } else {
      setView("reset_sent");
    }
  };

  const WRAP_STYLE: React.CSSProperties = {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#111827",
    color: "#e5e7eb",
  };

  // ---- ログインフォーム ----
  if (view === "login") {
    return (
      <div style={WRAP_STYLE}>
        <form onSubmit={handleSubmit} style={CARD_STYLE}>
          <h1 style={{ fontSize: 22, fontWeight: 600, textAlign: "center" }}>
            R2C Admin
          </h1>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 14 }}>Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={INPUT_STYLE}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 14 }}>Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={INPUT_STYLE}
            />
          </label>

          {error && <div style={{ color: "#fca5a5", fontSize: 13 }}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 8,
              padding: "10px 12px",
              borderRadius: 999,
              border: "none",
              background: loading ? "#4b5563" : "#22c55e",
              color: "#020617",
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>

          <button
            type="button"
            onClick={() => { setResetError(null); setView("reset"); }}
            style={{
              background: "none",
              border: "none",
              color: "#6b7280",
              fontSize: 13,
              cursor: "pointer",
              textAlign: "center",
              padding: "2px 0",
              textDecoration: "underline",
            }}
          >
            パスワードを忘れた方
          </button>
        </form>
      </div>
    );
  }

  // ---- パスワードリセット送信済み ----
  if (view === "reset_sent") {
    return (
      <div style={WRAP_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={{ fontSize: 22, fontWeight: 600, textAlign: "center" }}>
            R2C Admin
          </h1>
          <div style={{ textAlign: "center", fontSize: 32 }}>📧</div>
          <p style={{ fontSize: 14, color: "#d1d5db", textAlign: "center", lineHeight: 1.7, margin: 0 }}>
            パスワードリセットのメールを送信しました。<br />メールをご確認ください。
          </p>
          <button
            type="button"
            onClick={() => setView("login")}
            style={{
              background: "none",
              border: "none",
              color: "#6b7280",
              fontSize: 13,
              cursor: "pointer",
              textAlign: "center",
              textDecoration: "underline",
              padding: "2px 0",
            }}
          >
            ← ログインに戻る
          </button>
        </div>
      </div>
    );
  }

  // ---- パスワードリセットフォーム ----
  return (
    <div style={WRAP_STYLE}>
      <div style={CARD_STYLE}>
        <h1 style={{ fontSize: 22, fontWeight: 600, textAlign: "center" }}>
          R2C Admin
        </h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, lineHeight: 1.6 }}>
          登録済みのメールアドレスを入力してください。パスワードリセット用のリンクをお送りします。
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            style={INPUT_STYLE}
          />
        </label>

        {resetError && (
          <div style={{ color: "#fca5a5", fontSize: 13 }}>{resetError}</div>
        )}

        <button
          type="button"
          onClick={() => void handleResetPassword()}
          disabled={resetLoading || !email}
          style={{
            marginTop: 4,
            padding: "10px 12px",
            borderRadius: 999,
            border: "none",
            background: resetLoading || !email ? "#4b5563" : "#22c55e",
            color: "#020617",
            fontWeight: 600,
            cursor: resetLoading || !email ? "default" : "pointer",
          }}
        >
          {resetLoading ? "送信中..." : "リセットメールを送信"}
        </button>

        <button
          type="button"
          onClick={() => setView("login")}
          style={{
            background: "none",
            border: "none",
            color: "#6b7280",
            fontSize: 13,
            cursor: "pointer",
            textAlign: "center",
            textDecoration: "underline",
            padding: "2px 0",
          }}
        >
          ← ログインに戻る
        </button>
      </div>
    </div>
  );
}
