import { NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  MessageSquare,
  BookOpen,
  BarChart2,
  Palette,
  SlidersHorizontal,
  FlaskConical,
  Zap,
  TrendingUp,
  Building2,
  MessageCircleHeart,
  FileText,
  CreditCard,
  LogOut,
  Sun,
  Moon,
  Monitor,
  BellRing,
  X,
  GitBranch,
  Headset,
} from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { useTheme } from "../contexts/ThemeContext";
import { NotificationBell } from "./common/NotificationBell";
import AppSwitcher from "./AppSwitcher";
import { cn } from "../lib/utils";

// ─── Nav item types ───────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
  end?: boolean;
  superAdminOnly?: boolean;
}

interface NavSection {
  title?: string;
  items: NavItem[];
  superAdminOnly?: boolean;
}

const MAIN_SECTIONS: NavSection[] = [
  {
    items: [
      { label: "ダッシュボード", path: "/admin", icon: LayoutDashboard, end: true },
    ],
  },
  {
    title: "会話・ナレッジ",
    items: [
      { label: "会話履歴", path: "/admin/chat-history", icon: MessageSquare },
      { label: "対応中の会話", path: "/admin/escalations", icon: Headset },
      { label: "AIの知識データ", path: "/admin/knowledge", icon: BookOpen },
      { label: "AI学習・貢献分析", path: "/admin/knowledge-analytics", icon: BarChart2, superAdminOnly: true },
    ],
  },
  {
    title: "分析・成果",
    items: [
      { label: "会話分析", path: "/admin/analytics", icon: BarChart2 },
      { label: "成約・効果分析", path: "/admin/conversion", icon: TrendingUp },
      { label: "お客様への声がけ設定", path: "/admin/engagement", icon: Zap },
      { label: "フロー遷移分析", path: "/admin/analytics/flow", icon: GitBranch, superAdminOnly: true },
    ],
  },
  {
    title: "設定",
    items: [
      { label: "アバター設定", path: "/admin/avatar", icon: Palette },
      { label: "AIへの指示ルール", path: "/admin/tuning", icon: SlidersHorizontal },
      { label: "テストチャット", path: "/admin/chat-test", icon: FlaskConical },
    ],
  },
];

const SUPER_ADMIN_SECTION: NavSection = {
  title: "管理者",
  superAdminOnly: true,
  items: [
    { label: "テナント管理", path: "/admin/tenants", icon: Building2 },
    { label: "お客様の声", path: "/admin/feedback", icon: MessageCircleHeart },
    { label: "代行作業管理", path: "/admin/options", icon: FileText },
    { label: "請求・使用量", path: "/admin/billing", icon: CreditCard },
    { label: "システム稼働状況", path: "/admin/monitoring", icon: BellRing },
  ],
};

// ─── Theme toggle ─────────────────────────────────────────────────────

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options: { value: "light" | "dark" | "system"; icon: React.ElementType; label: string }[] = [
    { value: "light", icon: Sun, label: "ライト" },
    { value: "dark", icon: Moon, label: "ダーク" },
    { value: "system", icon: Monitor, label: "自動" },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: "var(--sidebar-accent)",
        borderRadius: "var(--radius-md)",
        padding: 2,
      }}
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          title={label}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "calc(var(--radius-md) - 2px)",
            border: "none",
            background: theme === value ? "var(--background)" : "transparent",
            color: theme === value ? "var(--foreground)" : "var(--muted-foreground)",
            cursor: "pointer",
            boxShadow: theme === value ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
            transition: "all 0.15s",
          }}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

// ─── Sidebar nav item ─────────────────────────────────────────────────

function SidebarItem({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "sidebar-nav-item",
          isActive && "active"
        )
      }
      style={({ isActive }) => ({
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: "var(--radius-md)",
        textDecoration: "none",
        fontSize: 13.5,
        fontWeight: isActive ? 600 : 400,
        color: isActive ? "var(--sidebar-primary)" : "var(--sidebar-foreground)",
        background: isActive ? "var(--sidebar-accent)" : "transparent",
        transition: "background 0.12s, color 0.12s",
      })}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        if (!el.classList.contains("active")) {
          el.style.background = "var(--sidebar-accent)";
        }
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        if (!el.classList.contains("active")) {
          el.style.background = "transparent";
        }
      }}
    >
      <Icon size={16} style={{ flexShrink: 0, opacity: 0.85 }} />
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {item.label}
      </span>
    </NavLink>
  );
}

// ─── Sidebar content (shared between desktop and mobile) ──────────────

interface SidebarContentProps {
  onClose?: () => void;
}

function SidebarContent({ onClose }: SidebarContentProps) {
  const { user, isSuperAdmin, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const knowledgePath = isSuperAdmin
    ? "/admin/knowledge"
    : `/admin/knowledge/${user?.tenantId ?? ""}`;

  // Override knowledge path in nav items
  const patchedSections = MAIN_SECTIONS.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => isSuperAdmin || !item.superAdminOnly)
      .map((item) =>
        item.path === "/admin/knowledge" ? { ...item, path: knowledgePath } : item
      ),
  }));

  const allSections = isSuperAdmin
    ? [...patchedSections, SUPER_ADMIN_SECTION]
    : patchedSections;

  return (
    <>
      {/* Brand */}
      <div
        style={{
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderBottom: "1px solid var(--sidebar-border)",
          flexShrink: 0,
        }}
      >
        <NavLink
          to="/admin"
          style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
        >
          <span style={{ fontSize: 15, fontWeight: 800, color: "var(--sidebar-foreground)", letterSpacing: "-0.4px" }}>
            R2C
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--sidebar-primary)",
              background: "var(--sidebar-accent)",
              padding: "1px 5px",
              borderRadius: "var(--radius-sm)",
              letterSpacing: "0.02em",
            }}
          >
            Admin
          </span>
        </NavLink>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <NotificationBell />
          {onClose && (
            <button
              onClick={onClose}
              style={{ background: "none", border: "none", color: "var(--muted-foreground)", cursor: "pointer", padding: 4, display: "flex" }}
              aria-label="メニューを閉じる"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* App Switcher (R2C ⇄ R2C2) */}
      <div style={{ padding: "10px 12px 0" }}>
        <AppSwitcher />
      </div>

      {/* Nav */}
      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {allSections.map((section, si) => (
          <div key={si} style={{ marginBottom: 4 }}>
            {section.title && (
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "var(--muted-foreground)",
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  padding: "8px 12px 4px",
                }}
              >
                {section.title}
              </div>
            )}
            {section.items.map((item) => (
              <SidebarItem key={item.path} item={item} />
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div
        style={{
          borderTop: "1px solid var(--sidebar-border)",
          padding: "12px 12px 16px",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {/* Theme toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>テーマ</span>
          <ThemeToggle />
        </div>

        {/* User info */}
        {user && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                background: "var(--sidebar-accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                color: "var(--sidebar-primary)",
                flexShrink: 0,
              }}
            >
              {user.email?.charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: isSuperAdmin ? "oklch(74% 0.16 80)" : "var(--sidebar-primary)",
                  lineHeight: 1.2,
                }}
              >
                {isSuperAdmin ? "Super Admin" : (user.tenantName ?? "Admin")}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--muted-foreground)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {user.email}
              </div>
            </div>
            <button
              onClick={() => void handleLogout()}
              title="ログアウト"
              style={{
                background: "none",
                border: "none",
                color: "var(--muted-foreground)",
                cursor: "pointer",
                padding: 4,
                borderRadius: "var(--radius-sm)",
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Desktop sidebar ──────────────────────────────────────────────────

export function AppSidebar() {
  return (
    <aside className="app-sidebar">
      <SidebarContent />
    </aside>
  );
}

// ─── Mobile sidebar + header ──────────────────────────────────────────

import { useState } from "react";
import { Menu } from "lucide-react";

export function MobileHeader() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mobile-header">
        <NavLink
          to="/admin"
          style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
        >
          <span style={{ fontSize: 15, fontWeight: 800, color: "var(--sidebar-foreground)", letterSpacing: "-0.4px" }}>
            R2C
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--sidebar-primary)",
              background: "var(--sidebar-accent)",
              padding: "1px 5px",
              borderRadius: "var(--radius-sm)",
            }}
          >
            Admin
          </span>
        </NavLink>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <NotificationBell />
          <button
            onClick={() => setOpen(true)}
            aria-label="メニューを開く"
            aria-expanded={open}
            style={{
              background: "none",
              border: "none",
              color: "var(--sidebar-foreground)",
              cursor: "pointer",
              padding: 8,
              display: "flex",
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Menu size={20} />
          </button>
        </div>
      </div>

      {/* Mobile overlay sidebar */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 45,
            }}
          />
          {/* Drawer */}
          <aside
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              bottom: 0,
              width: 280,
              background: "var(--sidebar)",
              borderRight: "1px solid var(--sidebar-border)",
              display: "flex",
              flexDirection: "column",
              zIndex: 50,
            }}
          >
            <SidebarContent onClose={() => setOpen(false)} />
          </aside>
        </>
      )}
    </>
  );
}

// ─── Mobile bottom bar ────────────────────────────────────────────────

const BOTTOM_NAV: { path: string; icon: React.ElementType; label: string; end?: boolean }[] = [
  { path: "/admin", icon: LayoutDashboard, label: "ホーム", end: true },
  { path: "/admin/chat-history", icon: MessageSquare, label: "会話" },
  { path: "/admin/knowledge", icon: BookOpen, label: "知識データ" },
  { path: "/admin/analytics", icon: BarChart2, label: "分析" },
  { path: "/admin/tuning", icon: SlidersHorizontal, label: "設定" },
];

export function MobileBottomBar() {
  const location = useLocation();

  return (
    <nav
      style={{
        display: "none",
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: 60,
        background: "var(--sidebar)",
        borderTop: "1px solid var(--sidebar-border)",
        zIndex: 40,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
      className="mobile-bottom-bar"
    >
      {BOTTOM_NAV.map(({ path, icon: Icon, label, end }) => {
        const isActive = end ? location.pathname === path : location.pathname.startsWith(path);
        return (
          <NavLink
            key={path}
            to={path}
            end={end}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              textDecoration: "none",
              color: isActive ? "var(--sidebar-primary)" : "var(--muted-foreground)",
              fontSize: 10,
              fontWeight: isActive ? 600 : 400,
              minHeight: 44,
              transition: "color 0.12s",
            }}
          >
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
