// admin-ui/src/pages/admin/avatar/AvatarCard.tsx
// index.tsx から抽出 — アバター設定カード（サムネイル / バッジ / アクション）（機能変更なし）

import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import type { AvatarConfig, WarningTarget } from "./types";

export function AvatarCard({
  cfg,
  isSuperAdmin,
  avatarEnabled,
  activating,
  deleting,
  handleActivate,
  handleDelete,
  setWarningTarget,
  formatDate,
}: {
  cfg: AvatarConfig;
  isSuperAdmin: boolean;
  avatarEnabled: boolean;
  activating: string | null;
  deleting: string | null;
  handleActivate: (id: string) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  setWarningTarget: (t: WarningTarget | null) => void;
  formatDate: (iso: string) => string;
}) {
  const navigate = useNavigate();
  const { lang } = useLang();

  return (
    <div
      key={cfg.id}
      className="av-card"
      style={{
        borderRadius: 14,
        border: cfg.is_active ? "1px solid rgba(34,197,94,0.5)" : "1px solid var(--border)",
        background: "var(--card)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {/* テナント名 / R2Cデフォルトバッジ（Super Adminのみ） */}
      {isSuperAdmin && (cfg.tenant_name || cfg.is_default) && (
        <div style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 10,
          padding: "3px 8px",
          borderRadius: 6,
          background: cfg.is_default
            ? "rgba(99,102,241,0.85)"
            : "rgba(0,0,0,0.75)",
          border: cfg.is_default
            ? "1px solid rgba(165,180,252,0.5)"
            : "1px solid rgba(255,255,255,0.15)",
          color: cfg.is_default ? "#e0e7ff" : "#d1d5db",
          fontSize: 11,
          fontWeight: 600,
          maxWidth: 140,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {cfg.is_default ? "R2C デフォルト" : cfg.tenant_name}
        </div>
      )}

      {/* サムネイル */}
      {cfg.image_url ? (
        <div className="av-img-wrap">
          <img
            src={cfg.image_url}
            alt={cfg.name}
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="av-img-overlay" />
        </div>
      ) : (
        <div className="av-img-placeholder">👤</div>
      )}

      {/* コンテンツ */}
      <div style={{ padding: "14px 16px", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
        {/* 名前 + バッジ */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="av-name" style={{ color: cfg.name ? "#f9fafb" : "#6b7280", fontStyle: cfg.name ? "normal" : "italic", flex: 1, minWidth: 0 }}>
            {cfg.name || (lang === "ja" ? "名前なし" : "Unnamed")}
          </span>
          {cfg.is_active && (isSuperAdmin || avatarEnabled) ? (
            <span style={{
              padding: "2px 9px",
              borderRadius: 999,
              background: "rgba(34,197,94,0.15)",
              border: "1px solid rgba(34,197,94,0.5)",
              color: "#4ade80",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}>
              {lang === "ja" ? "アクティブ" : "Active"}
            </span>
          ) : cfg.is_active && !avatarEnabled && !isSuperAdmin ? (
            <span style={{
              padding: "2px 9px",
              borderRadius: 999,
              background: "rgba(107,114,128,0.15)",
              border: "1px solid rgba(107,114,128,0.4)",
              color: "var(--muted-foreground)",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}>
              {lang === "ja" ? "無効" : "Inactive"}
            </span>
          ) : null}
          {cfg.is_default && (
            <span style={{
              background: '#dbeafe',
              color: '#1d4ed8',
              padding: '2px 8px',
              borderRadius: '9999px',
              fontSize: '12px',
              fontWeight: 500,
              marginLeft: '8px',
              flexShrink: 0,
            }}>
              {lang === "ja" ? "デフォルト" : "Default"}
            </span>
          )}
        </div>

        {/* 作成日 */}
        <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {lang === "ja" ? "作成日: " : "Created: "}{formatDate(cfg.created_at)}
        </span>

        {/* アクションボタン */}
        <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap" }}>
          {!isSuperAdmin && !cfg.is_active && (
            <button
              className="av-btn-sm"
              onClick={() => void handleActivate(cfg.id)}
              disabled={activating === cfg.id}
              style={{
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid rgba(34,197,94,0.4)",
                background: activating === cfg.id ? "rgba(34,197,94,0.05)" : "rgba(34,197,94,0.1)",
                color: "#4ade80",
                fontWeight: 600,
                cursor: activating === cfg.id ? "not-allowed" : "pointer",
                opacity: activating === cfg.id ? 0.6 : 1,
              }}
            >
              {activating === cfg.id
                ? (lang === "ja" ? "処理中..." : "Activating...")
                : (lang === "ja" ? "有効化" : "Activate")}
            </button>
          )}
          {!isSuperAdmin && (
            <button
              className="av-btn-sm"
              onClick={() => navigate(`/admin/avatar/studio/${cfg.id}`)}
              style={{
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--muted-foreground)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {lang === "ja" ? "編集" : "Edit"}
            </button>
          )}
          {!isSuperAdmin && !cfg.is_default && avatarEnabled && (
            <button
              className="av-btn-sm"
              onClick={() => navigate(
                `/admin/chat-test?tenantId=${encodeURIComponent(cfg.tenant_id)}&avatarConfigId=${encodeURIComponent(cfg.id)}`
              )}
              title="このアバターでテストチャットを開く"
              style={{
                minHeight: 44,
                borderRadius: 8,
                border: "none",
                background: "linear-gradient(135deg, #3b82f6, #6366f1)",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              💬 {lang === "ja" ? "テストチャット" : "Test Chat"}
            </button>
          )}
          {!isSuperAdmin && !cfg.is_active && (
            <button
              className="av-btn-sm"
              onClick={() => void handleDelete(cfg.id)}
              disabled={deleting === cfg.id}
              style={{
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid rgba(239,68,68,0.3)",
                background: deleting === cfg.id ? "rgba(239,68,68,0.05)" : "transparent",
                color: "#f87171",
                fontWeight: 600,
                cursor: deleting === cfg.id ? "not-allowed" : "pointer",
                opacity: deleting === cfg.id ? 0.6 : 1,
                marginLeft: "auto",
              }}
            >
              {deleting === cfg.id
                ? (lang === "ja" ? "削除中..." : "Deleting...")
                : (lang === "ja" ? "削除" : "Delete")}
            </button>
          )}
          {/* Super Admin アクション */}
          {isSuperAdmin && (
            <>
              <button
                className="av-btn-sm"
                onClick={() => navigate(`/admin/avatar/studio/${cfg.id}`)}
                style={{ minHeight: 44, borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", fontWeight: 600, cursor: "pointer" }}
              >
                編集
              </button>
              <button
                className="av-btn-sm"
                onClick={() => void handleDelete(cfg.id)}
                disabled={deleting === cfg.id}
                style={{ minHeight: 44, borderRadius: 8, border: "1px solid rgba(239,68,68,0.3)", background: deleting === cfg.id ? "rgba(239,68,68,0.05)" : "transparent", color: "#f87171", fontWeight: 600, cursor: deleting === cfg.id ? "not-allowed" : "pointer", opacity: deleting === cfg.id ? 0.6 : 1 }}
              >
                {deleting === cfg.id ? "削除中..." : "削除"}
              </button>
              <button
                className="av-btn-sm"
                onClick={() => navigate(
                  `/admin/chat-test?tenantId=${encodeURIComponent(cfg.tenant_id)}&avatarConfigId=${encodeURIComponent(cfg.id)}`
                )}
                title="このアバターでテストチャットを開く"
                style={{ minHeight: 44, borderRadius: 8, border: "none", background: "linear-gradient(135deg, #3b82f6, #6366f1)", color: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                💬 テスト
              </button>
              {!cfg.is_default && (
                <button
                  className="av-btn-sm"
                  onClick={() => setWarningTarget({ id: cfg.id, tenantId: cfg.tenant_id, name: cfg.name })}
                  style={{ minHeight: 44, borderRadius: 8, border: "1px solid rgba(251,191,36,0.4)", background: "rgba(251,191,36,0.08)", color: "#fbbf24", fontWeight: 600, cursor: "pointer", marginLeft: "auto" }}
                >
                  ⚠️ 警告
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
