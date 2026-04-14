// admin-ui/src/components/AdminNavBar.tsx
// Phase52g: 全admin共通トップナビゲーション（ロール別メニュー・現在ページハイライト）

import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { NotificationBell } from "./common/NotificationBell";

interface NavItem {
  label: string;
  path: string;
  desc: string;
  superAdminOnly?: boolean;
}

interface NavGroup {
  id: string;
  icon: string;
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: "conversation",
    icon: "💬",
    label: "会話",
    items: [
      { label: "会話履歴", path: "/admin/chat-history", desc: "全チャットログを確認" },
    ],
  },
  {
    id: "operations",
    icon: "📋",
    label: "運用管理",
    items: [
      { label: "お客様の声", path: "/admin/feedback", desc: "フィードバック管理", superAdminOnly: true },
    ],
  },
  {
    id: "knowledge",
    icon: "📚",
    label: "ナレッジ",
    items: [
      { label: "ナレッジ管理", path: "/admin/knowledge", desc: "AIの回答データを管理" },
    ],
  },
  {
    id: "analytics",
    icon: "📈",
    label: "分析",
    items: [
      { label: "会話分析ダッシュボード", path: "/admin/analytics", desc: "KPI・トレンド・コンバージョン" },
    ],
  },
  {
    id: "engagement",
    icon: "💬",
    label: "声がけ",
    items: [
      { label: "声がけ設定", path: "/admin/engagement", desc: "お客様への自動メッセージ設定" },
    ],
  },
  {
    id: "conversion",
    icon: "📈",
    label: "成果管理",
    items: [
      { label: "コンバージョン分析", path: "/admin/conversion", desc: "CVの成果・A/Bテスト・AIからの改善提案" },
    ],
  },
  {
    id: "settings",
    icon: "⚙️",
    label: "設定",
    items: [
      { label: "アバター設定", path: "/admin/avatar", desc: "AIアバターの見た目と声" },
      { label: "チューニングルール", path: "/admin/tuning", desc: "AI回答の改善ルール" },
      { label: "テストチャット", path: "/admin/chat-test", desc: "AIの回答をテスト" },
      { label: "テナント管理", path: "/admin/tenants", desc: "テナント設定と管理", superAdminOnly: true },
      { label: "ご利用状況", path: "/admin/billing", desc: "使用量と請求情報" },
    ],
  },
];

export function AdminNavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isSuperAdmin, isClientAdmin, logout } = useAuth();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
        setMobileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Close on route change
  useEffect(() => {
    setOpenGroup(null);
    setMobileOpen(false);
  }, [location.pathname]);

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  const groupHasActivePage = (group: NavGroup) =>
    group.items.some((item) => isActive(item.path));

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const filteredGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.superAdminOnly || isSuperAdmin),
  }));

  // Don't render on login page
  if (location.pathname === "/login") return null;

  return (
    <nav
      ref={navRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        height: 52,
        background: "rgba(9,14,28,0.97)",
        borderBottom: "1px solid #1f2937",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 4,
      }}
    >
      {/* Logo */}
      <button
        onClick={() => navigate("/admin")}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "4px 10px",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginRight: 8,
          flexShrink: 0,
          minHeight: 44,
          minWidth: 44,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 800, color: "#f9fafb", letterSpacing: "-0.5px" }}>
          R2C
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#4ade80",
            background: "rgba(74,222,128,0.1)",
            border: "1px solid rgba(74,222,128,0.3)",
            padding: "1px 5px",
            borderRadius: 4,
          }}
        >
          Admin
        </span>
      </button>

      {/* Desktop Nav Groups */}
      <div
        style={{
          alignItems: "center",
          gap: 2,
          flex: 1,
        }}
        className="desktop-nav"
      >
        {filteredGroups.map((group) => {
          const isGroupActive = groupHasActivePage(group);
          const isOpen = openGroup === group.id;

          return (
            <div key={group.id} style={{ position: "relative" }}>
              <button
                onClick={() => setOpenGroup(isOpen ? null : group.id)}
                style={{
                  background: isOpen
                    ? "rgba(96,165,250,0.12)"
                    : isGroupActive
                    ? "rgba(255,255,255,0.05)"
                    : "none",
                  border: `1px solid ${isOpen ? "rgba(96,165,250,0.3)" : "transparent"}`,
                  borderRadius: 8,
                  padding: "5px 10px",
                  minHeight: 36,
                  cursor: "pointer",
                  color: isGroupActive ? "#f9fafb" : "#9ca3af",
                  fontSize: 13,
                  fontWeight: isGroupActive ? 600 : 400,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  whiteSpace: "nowrap",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: 14 }}>{group.icon}</span>
                {group.label}
                <span
                  style={{
                    fontSize: 9,
                    color: "#6b7280",
                    marginLeft: 2,
                    transform: isOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.15s",
                    display: "inline-block",
                  }}
                >
                  ▼
                </span>
              </button>

              {/* Dropdown */}
              {isOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    minWidth: 220,
                    background: "rgba(9,14,28,0.98)",
                    border: "1px solid #1f2937",
                    borderRadius: 10,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
                    overflow: "hidden",
                    zIndex: 1001,
                  }}
                >
                  {group.items.map((item) => {
                    const active = isActive(item.path);
                    return (
                      <button
                        key={item.path}
                        onClick={() => navigate(item.path)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "10px 14px",
                          background: active ? "rgba(96,165,250,0.1)" : "none",
                          border: "none",
                          borderLeft: `2px solid ${active ? "#60a5fa" : "transparent"}`,
                          cursor: "pointer",
                          borderBottom: "1px solid rgba(31,41,55,0.5)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: active ? 600 : 400,
                            color: active ? "#60a5fa" : "#e5e7eb",
                          }}
                        >
                          {item.label}
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                          {item.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Notification Bell */}
      {user && <NotificationBell />}

      {/* User area — hidden on mobile via CSS */}
      {user && (
        <div
          className="user-area-desktop"
          style={{
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              padding: "3px 8px",
              borderRadius: 999,
              background: isSuperAdmin ? "rgba(234,179,8,0.12)" : "rgba(59,130,246,0.12)",
              border: `1px solid ${isSuperAdmin ? "rgba(234,179,8,0.3)" : "rgba(59,130,246,0.3)"}`,
              color: isSuperAdmin ? "#fbbf24" : "#60a5fa",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {isSuperAdmin ? "Super Admin" : isClientAdmin ? (user.tenantName ?? "Client Admin") : ""}
          </span>
          <span
            style={{
              fontSize: 12,
              color: "#6b7280",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user.email}
          </span>
          <button
            onClick={() => void handleLogout()}
            style={{
              padding: "5px 12px",
              minHeight: 32,
              borderRadius: 6,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 12,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            ログアウト
          </button>
        </div>
      )}

      {/* Mobile hamburger — shown on mobile via CSS */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="メニュー"
        aria-expanded={mobileOpen}
        style={{
          background: "none",
          border: "none",
          color: "#9ca3af",
          cursor: "pointer",
          fontSize: 22,
          padding: "0 6px",
          marginLeft: 4,
          minHeight: 44,
          minWidth: 44,
          flexShrink: 0,
        }}
        className="mobile-hamburger"
      >
        {mobileOpen ? "✕" : "☰"}
      </button>

      {/* Mobile menu */}
      {mobileOpen && (
        <div
          style={{
            position: "fixed",
            top: 52,
            left: 0,
            right: 0,
            background: "rgba(9,14,28,0.98)",
            borderBottom: "1px solid #1f2937",
            padding: "12px 16px",
            maxHeight: "calc(100vh - 52px)",
            overflowY: "auto",
            zIndex: 999,
          }}
        >
          {filteredGroups.map((group) => (
            <div key={group.id} style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#6b7280",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "4px 0",
                  borderBottom: "1px solid #1f2937",
                  marginBottom: 8,
                }}
              >
                {group.icon} {group.label}
              </div>
              {group.items.map((item) => {
                const active = isActive(item.path);
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 12px",
                      background: active ? "rgba(96,165,250,0.1)" : "none",
                      border: "none",
                      borderRadius: 8,
                      cursor: "pointer",
                      color: active ? "#60a5fa" : "#e5e7eb",
                      fontSize: 14,
                      fontWeight: active ? 600 : 400,
                      minHeight: 44,
                      marginBottom: 4,
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
          {user && (
            <button
              onClick={() => void handleLogout()}
              style={{
                width: "100%",
                padding: "12px",
                minHeight: 44,
                borderRadius: 8,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 14,
                cursor: "pointer",
                marginTop: 8,
              }}
            >
              ログアウト
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
