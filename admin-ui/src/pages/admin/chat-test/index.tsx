import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";

export default function ChatTestPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user } = useAuth();
  const [started, setStarted] = useState(false);

  // テナントの API キーは実際には /v1/auth/me または tenant detail から取得する
  // TODO: Stream A の GET /v1/auth/me が実装されたら apiKey をそこから取得する
  const tenantId = user?.tenantId ?? "demo";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
        <button
          onClick={() => navigate("/admin")}
          style={{
            padding: "10px 16px",
            minHeight: 44,
            borderRadius: 999,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 14,
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {t("common.back_to_dashboard")}
        </button>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("chat_test.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("chat_test.description")}
          </p>
        </div>
      </header>

      <section
        style={{
          borderRadius: 16,
          border: "1px solid #1f2937",
          background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          padding: "32px 24px",
          textAlign: "center",
        }}
      >
        {!started ? (
          <>
            <div style={{ fontSize: 64, marginBottom: 16 }}>💬</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb", marginBottom: 8 }}>
              {t("chat_test.title")}
            </h2>
            <p style={{ fontSize: 15, color: "#9ca3af", marginBottom: 32, maxWidth: 400, margin: "0 auto 32px" }}>
              {t("chat_test.description")}
            </p>
            <button
              onClick={() => setStarted(true)}
              style={{
                padding: "18px 40px",
                minHeight: 56,
                borderRadius: 12,
                border: "none",
                background: "linear-gradient(135deg, #3b82f6 0%, #60a5fa 50%, #3b82f6 100%)",
                color: "#fff",
                fontSize: 18,
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 8px 25px rgba(59,130,246,0.35)",
              }}
            >
              {t("chat_test.start")}
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 16 }}>
              {t("chat_test.tenant_label")}: <strong style={{ color: "#9ca3af" }}>{user?.tenantName ?? tenantId}</strong>
            </p>
            {/* ウィジェット埋め込みエリア */}
            <div
              style={{
                width: "100%",
                maxWidth: 420,
                height: 560,
                margin: "0 auto",
                borderRadius: 12,
                border: "1px solid #374151",
                overflow: "hidden",
                position: "relative",
                background: "#0f172a",
              }}
            >
              {/* TODO: 実際の widget.js を data-tenant-id で埋め込む */}
              {/* <script src="/widget.js" data-tenant-id={tenantId} async /> */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  color: "#4b5563",
                }}
              >
                <span style={{ fontSize: 40 }}>🔧</span>
                <p style={{ fontSize: 14, margin: 0 }}>{t("chat_test.widget_placeholder")}</p>
              </div>
            </div>
            <button
              onClick={() => setStarted(false)}
              style={{
                marginTop: 24,
                padding: "12px 24px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {t("chat_test.reset")}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
