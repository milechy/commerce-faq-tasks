import { useState, useEffect } from "react";
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
  KeyRound,
  BellRing,
  X,
  GitBranch,
  Headset,
  HelpCircle,
  Sparkles,
  Menu,
} from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { NotificationBell } from "./common/NotificationBell";
import { ThemeToggle } from "./common/ThemeToggle";
import AppSwitcher from "./AppSwitcher";
import { cn } from "../lib/utils";
import { planHasFeature, type GatedFeature } from "../lib/planFeatures";

// ─── Nav item types ───────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
  end?: boolean;
  superAdminOnly?: boolean;
  /** GID: LP料金表に基づくplan制限。指定時、そのプラン以上でないと非表示(super_adminの自身の集約ビューは対象外)。 */
  requiresPlan?: GatedFeature;
}

interface NavSection {
  title?: string;
  items: NavItem[];
  superAdminOnly?: boolean;
}

// 旧UIから新UI(チャット)へ戻るリンクの遷移先。SidebarContentのNavLink `to` と、
// window.close()が無視された場合のフォールバック navigate() の両方で使う(値を1箇所にする)。
const COPILOT_PREVIEW_FROM_LEGACY_PATH = "/copilot-preview?from=legacy";

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
      { label: "未回答質問", path: "/admin/knowledge-gaps", icon: HelpCircle },
      { label: "AI学習・貢献分析", path: "/admin/knowledge-analytics", icon: BarChart2, superAdminOnly: true },
    ],
  },
  {
    title: "分析・成果",
    items: [
      { label: "会話分析", path: "/admin/analytics", icon: BarChart2, requiresPlan: "analytics" },
      { label: "成約・効果分析", path: "/admin/conversion", icon: TrendingUp, requiresPlan: "conversion" },
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
      // GID: 旧UIでは全admin可視だったご利用状況・お支払いを復元。
      // ルート自体は元々 AdminRoute (super/client 両方許可) だったが、
      // サイドバーからはsuper_admin専用セクションに置かれていたためclient_adminから辿れなかった
      { label: "ご利用状況・お支払い", path: "/admin/billing", icon: CreditCard },
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
    { label: "システム稼働状況", path: "/admin/monitoring", icon: BellRing },
  ],
};

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
  const { user, isSuperAdmin, isClientAdmin, previewMode, previewTenantId, tenantPlan, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  // super_adminの「クライアントビューで見る」プレビュー中は isSuperAdmin が
  // client_admin相当にフォールバックするが、実ログインユーザー(super_admin)の
  // user?.tenantId は常にnullのため、previewTenantId を優先する必要がある
  // （pages/admin/index.tsx の knowledgePath と同パターン）。
  const knowledgePath = isSuperAdmin
    ? "/admin/knowledge"
    : `/admin/knowledge/${previewMode ? (previewTenantId ?? "") : (user?.tenantId ?? "")}`;

  // Override knowledge path in nav items
  const patchedSections = MAIN_SECTIONS.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => isSuperAdmin || !item.superAdminOnly)
      .filter((item) => isSuperAdmin || !item.requiresPlan || planHasFeature(tenantPlan, item.requiresPlan))
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
          {/* onClose はモバイルドロワー呼び出し時のみ渡される。ドロワー展開中は
              MobileHeader 自身の上部バーに既にベルがあるため、ここでは出さない
              (両方出すと同一画面に2個同時表示・二重ポーリングになる)。 */}
          {!onClose && <NotificationBell />}
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
        {/* 新UI(チャット)への復帰導線。
            target="_blank" を無視する環境(アプリ内ブラウザ等)や、チャット・ファースト
            既定がOFFのユーザーは旧UIから新UIへ戻る手段が無くなるため、常設リンクを置く。
            条件は App.tsx の showAIChat と同じ isClientAdmin — テナントが解決できない
            素のsuper_adminにとってはチャットが機能しないため意図的に非表示にする。 */}
        {isClientAdmin && (
          <NavLink
            to={COPILOT_PREVIEW_FROM_LEGACY_PATH}
            onClick={(e) => {
              // rel="opener"付きの内部リンクで開かれた新規タブならopenerが渡っている。
              // SPA遷移せずタブごと閉じることで、元の会話が残っているタブへそのまま戻す。
              // openerが無い(通常のブラウザ内遷移)場合は従来どおりNavLinkで遷移する。
              if (window.opener) {
                e.preventDefault();
                window.close();
                // ブラウザはタブ内で複数ページ遷移した後などclose()を無視することがある
                // (script非開設扱いになるため)。閉じられなかった場合は「詰み」を避け、
                // 通常のSPA遷移にフォールバックする。close()が成功していればこのタブ自体が
                // 消えるため到達しない。
                window.setTimeout(() => {
                  if (!window.closed) navigate(COPILOT_PREVIEW_FROM_LEGACY_PATH);
                }, 150);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: "var(--radius-md)",
              textDecoration: "none",
              fontSize: 13.5,
              fontWeight: 600,
              color: "var(--sidebar-primary)",
              background: "var(--sidebar-accent)",
              transition: "opacity 0.12s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "0.85";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "1";
            }}
          >
            <Sparkles size={16} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              AIチャットに戻る
            </span>
          </NavLink>
        )}

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
              onClick={() => navigate("/admin/account")}
              title="アカウント設定"
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
              <KeyRound size={15} />
            </button>
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

// admin-ui/src/index.css の @media (max-width: 767px) と同じブレークポイント。
// .app-sidebar は CSS の transform で画面外に押し出されるだけでDOMには残るため、
// NotificationBell のようなポーリングを持つ子がオフスクリーンでもマウントされ続ける
// (デスクトップrail + MobileHeader + モバイルドロワーの最大3重マウント)。
// JS側でも早期returnし、非表示側を実際に非マウントにする。
const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const handleChange = () => setIsMobile(mql.matches);
    handleChange();
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}

// ─── Desktop sidebar ──────────────────────────────────────────────────

export function AppSidebar() {
  const isMobile = useIsMobileViewport();
  if (isMobile) return null;

  return (
    <aside className="app-sidebar">
      <SidebarContent />
    </aside>
  );
}

// ─── Mobile sidebar + header ──────────────────────────────────────────

export function MobileHeader() {
  const isMobile = useIsMobileViewport();
  const [open, setOpen] = useState(false);
  if (!isMobile) return null;

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

// client_adminのモバイル下部バーは、plan(starter/growth)を問わず一律「分析」の代わりに
// AIチャットへの導線を出す(デスクトップ側 MAIN_SECTIONS の analytics 項目のような
// requiresPlan によるプラン別出し分けはここでは行わない — チャット導線を優先する設計判断)。
// analytics自体はgrowth以上のプラン制限がありstarterテナントには意味の無い枠だったことが
// この置き換えの動機だが、growthテナントでも下部バーからは無くなる(ハンバーガーメニュー
// 経由のanalyticsアクセスは従来どおり残る)。isClientAdminはpreviewMode中のsuper_adminも
// 真になるため、previewModeでない素のsuper_adminには従来どおりanalyticsを出す。
const BOTTOM_NAV_CLIENT_ADMIN: typeof BOTTOM_NAV = BOTTOM_NAV.map((item) =>
  item.path === "/admin/analytics" ? { path: "/copilot-preview", icon: Sparkles, label: "AIチャット" } : item,
);

export function MobileBottomBar() {
  const location = useLocation();
  const { isClientAdmin } = useAuth();
  const navItems = isClientAdmin ? BOTTOM_NAV_CLIENT_ADMIN : BOTTOM_NAV;

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
      {navItems.map(({ path, icon: Icon, label, end }) => {
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
