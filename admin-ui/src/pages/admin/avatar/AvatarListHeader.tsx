// admin-ui/src/pages/admin/avatar/AvatarListHeader.tsx
// index.tsx から抽出 — ページヘッダー（タイトル / 件数 / 新規作成ボタン）（機能変更なし）

import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import type { AvatarConfig } from "./types";

export function AvatarListHeader({
  loading,
  isSuperAdmin,
  displayedConfigs,
  total,
}: {
  loading: boolean;
  isSuperAdmin: boolean;
  displayedConfigs: AvatarConfig[];
  total: number;
}) {
  const navigate = useNavigate();
  const { lang } = useLang();

  return (
    <header style={{ marginBottom: 28 }}>
      <button
        onClick={() => navigate("/admin")}
        style={{ background: "none", border: "none", color: "var(--muted-foreground)", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 10, display: "block" }}
      >
        {lang === "ja" ? "← 管理画面に戻る" : "← Back to Admin"}
      </button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "var(--foreground)", display: "flex", alignItems: "center", gap: 8 }}>
            🎭 {lang === "ja" ? "アバター設定" : "Avatar Configs"}
          </h1>
          {!loading && (
            <p style={{ fontSize: 13, color: "var(--muted-foreground)", margin: "4px 0 0" }}>
              {isSuperAdmin
                ? (lang === "ja" ? `全テナント: ${displayedConfigs.length}/${total}件` : `All tenants: ${displayedConfigs.length}/${total}`)
                : (lang === "ja" ? `${total}件の設定` : `${total} config${total !== 1 ? "s" : ""}`)
              }
            </p>
          )}
        </div>
        {!isSuperAdmin && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={() => navigate("/admin/avatar/wizard")}
              style={{
                padding: "10px 20px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(245,158,11,0.4)",
                background: "rgba(245,158,11,0.12)",
                color: "#fcd34d",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              ✨ {lang === "ja" ? "AI生成" : "AI Generate"}
            </button>
            <button
              onClick={() => navigate("/admin/avatar/studio")}
              style={{
                padding: "10px 20px",
                minHeight: 44,
                borderRadius: 10,
                border: "none",
                background: "linear-gradient(135deg, #3b82f6, #6366f1)",
                color: "#fff",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {lang === "ja" ? "+ 新規作成" : "+ New Config"}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
