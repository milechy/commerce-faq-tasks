import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    // Supabase SDK がセッションを自動管理するため、手動保存は不要
    navigate("/");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#111827",
        color: "#e5e7eb",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: 360,
          padding: 24,
          borderRadius: 16,
          background: "#020617",
          boxShadow: "0 20px 40px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
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
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "#020617",
              color: "#e5e7eb",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "#020617",
              color: "#e5e7eb",
            }}
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
      </form>
    </div>
  );
}
