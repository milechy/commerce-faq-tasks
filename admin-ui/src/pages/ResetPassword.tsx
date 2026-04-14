import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

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

const WRAP_STYLE: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#111827",
  color: "#e5e7eb",
};

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Supabase redirects with #access_token in the URL hash.
  // The supabase client picks it up automatically via onAuthStateChange.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        // Session is now active — user can set a new password
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("パスワードは8文字以上で入力してください。");
      return;
    }
    if (password !== confirm) {
      setError("パスワードが一致しません。");
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError("パスワードの更新に失敗しました。リンクの有効期限が切れている可能性があります。");
      return;
    }

    setDone(true);
    setTimeout(() => {
      void navigate("/login", { replace: true });
    }, 3000);
  };

  if (done) {
    return (
      <div style={WRAP_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={{ fontSize: 22, fontWeight: 600, textAlign: "center" }}>
            R2C Admin
          </h1>
          <div style={{ textAlign: "center", fontSize: 32 }}>✅</div>
          <p style={{ fontSize: 14, color: "#d1d5db", textAlign: "center", lineHeight: 1.7, margin: 0 }}>
            パスワードを更新しました。<br />ログイン画面に移動します。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={WRAP_STYLE}>
      <form onSubmit={(e) => void handleSubmit(e)} style={CARD_STYLE}>
        <h1 style={{ fontSize: 22, fontWeight: 600, textAlign: "center" }}>
          R2C Admin
        </h1>
        <p style={{ fontSize: 13, color: "#9ca3af", margin: 0, lineHeight: 1.6 }}>
          新しいパスワードを入力してください。
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>新しいパスワード</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={INPUT_STYLE}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>パスワード（確認）</span>
          <input
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={INPUT_STYLE}
          />
        </label>

        {error && <div style={{ color: "#fca5a5", fontSize: 13 }}>{error}</div>}

        <button
          type="submit"
          disabled={loading || !password || !confirm}
          style={{
            marginTop: 4,
            padding: "10px 12px",
            borderRadius: 999,
            border: "none",
            background: loading || !password || !confirm ? "#4b5563" : "#22c55e",
            color: "#020617",
            fontWeight: 600,
            cursor: loading || !password || !confirm ? "default" : "pointer",
          }}
        >
          {loading ? "更新中..." : "パスワードを更新"}
        </button>
      </form>
    </div>
  );
}
