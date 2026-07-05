// admin-ui/src/pages/admin/escalations/index.tsx
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション — 対応中会話一覧

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface EscalationSummary {
  id: string;
  tenant_id: string;
  session_id: string;
  escalated_at: string;
  last_message_at: string;
  message_count: number;
  first_message_preview: string;
}

const POLL_INTERVAL_MS = 8000;

export default function EscalationsPage() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const { isSuperAdmin } = useAuth();

  const [escalations, setEscalations] = useState<EscalationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const locale = lang === "en" ? "en-US" : "ja-JP";

  const loadEscalations = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/chat-history/escalations`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { escalations: EscalationSummary[] };
      setEscalations(data.escalations ?? []);
      setError(null);
    } catch {
      setError("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEscalations();
    const timer = setInterval(() => void loadEscalations(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadEscalations]);

  const formatRelative = (iso: string) => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "たった今";
    if (mins < 60) return `${mins}分前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}時間前`;
    return new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            {t("common.back_to_dashboard")}
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "var(--foreground)" }}>
            🙋 対応中の会話
          </h1>
          <p style={{ fontSize: 14, color: "var(--muted-foreground)", marginTop: 4, marginBottom: 0 }}>
            有人スタッフとの会話を希望しているお客様の一覧です
          </p>
        </div>
        <LangSwitcher />
      </header>

      {error && (
        <div style={{ marginBottom: 20, padding: "14px 18px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 15 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込んでいます...
        </div>
      ) : escalations.length === 0 ? (
        <div style={{ padding: "48px 24px", textAlign: "center", borderRadius: 14, border: "1px solid var(--border)", background: "var(--card)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <p style={{ color: "var(--foreground)", fontSize: 15, fontWeight: 600, margin: "0 0 6px" }}>
            現在、対応待ちの会話はありません
          </p>
          <p style={{ color: "var(--muted-foreground)", fontSize: 13.5, margin: 0 }}>
            お客様が「有人スタッフに相談する」を選択すると、ここに表示されます
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {escalations.map((esc) => (
            <div
              key={esc.id}
              style={{
                borderRadius: 14,
                border: "1px solid rgba(234,179,8,0.35)",
                background: "rgba(234,179,8,0.06)",
                padding: "18px 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {isSuperAdmin && (
                    <span style={{ padding: "3px 10px", borderRadius: 999, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#4ade80", fontSize: 12, fontWeight: 600 }}>
                      {esc.tenant_id}
                    </span>
                  )}
                  <span style={{ padding: "3px 10px", borderRadius: 999, background: "rgba(234,179,8,0.18)", border: "1px solid rgba(234,179,8,0.4)", color: "#fbbf24", fontSize: 12, fontWeight: 700 }}>
                    🔔 対応待ち
                  </span>
                </div>
                {esc.first_message_preview && (
                  <span style={{ fontSize: 15, color: "var(--foreground)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {esc.first_message_preview}
                  </span>
                )}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                    🕐 {formatRelative(esc.escalated_at)}
                  </span>
                  <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                    💬 {esc.message_count}件のメッセージ
                  </span>
                </div>
              </div>
              <button
                onClick={() => navigate(`/admin/escalations/${esc.id}`)}
                style={{
                  padding: "10px 18px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg, #f59e0b, #fbbf24)",
                  color: "#451a03",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                対応する →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
