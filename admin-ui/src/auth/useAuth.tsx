import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { authFetch, API_BASE } from "../lib/api";

export interface AuthUser {
  id: string;
  email: string;
  role: "super_admin" | "client_admin" | "anonymous";
  tenantId: string | null;
  tenantName: string | null;
}

// LP(r2c.biz)料金表のプラン。backendのplanValues(src/api/admin/tenants/routes.ts)と一致させること。
export type TenantPlan = "starter" | "growth" | "enterprise";

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  isClientAdmin: boolean;
  logout: () => Promise<void>;
  previewMode: boolean;
  previewTenantId: string | null;
  previewTenantName: string | null;
  enterPreview: (tenantId: string, tenantName: string) => void;
  exitPreview: () => void;
  /**
   * 表示対象テナントの現在のプラン。
   * - client_admin(プレビュー含む): 自テナント/プレビュー先テナントのプラン
   * - super_adminの集約ビュー(プレビュー無し): 特定テナントに紐付かないため null
   * - 未取得時は null（機能表示側はnullを「制限あり(未確認)」として扱うこと）
   */
  tenantPlan: TenantPlan | null;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isSuperAdmin: false,
  isClientAdmin: false,
  logout: async () => {},
  previewMode: false,
  previewTenantId: null,
  previewTenantName: null,
  enterPreview: () => {},
  exitPreview: () => {},
  tenantPlan: null,
});

function parseRole(meta: Record<string, unknown>): AuthUser["role"] {
  const r = meta?.role;
  if (r === "super_admin") return "super_admin";
  if (r === "client_admin") return "client_admin";
  return "anonymous";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [previewMode, setPreviewMode] = useState(false);
  const [previewTenantId, setPreviewTenantId] = useState<string | null>(null);
  const [previewTenantName, setPreviewTenantName] = useState<string | null>(null);
  const [tenantPlan, setTenantPlan] = useState<TenantPlan | null>(null);

  const loadUser = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session) {
        setUser(null);
        return;
      }

      // TODO: Replace with GET /v1/auth/me when Stream A API is available
      const supaUser = session.user;
      const appMeta = (supaUser.app_metadata ?? {}) as Record<string, unknown>;
      const userMeta = (supaUser.user_metadata ?? {}) as Record<string, unknown>;
      const role = parseRole(appMeta);
      const tenantId =
        (appMeta.tenant_id as string | undefined) ??
        (userMeta.tenant_id as string | undefined) ??
        null;
      const tenantName =
        (appMeta.tenant_name as string | undefined) ??
        (userMeta.tenant_name as string | undefined) ??
        null;

      setUser({
        id: supaUser.id,
        email: supaUser.email ?? "",
        role,
        tenantId,
        tenantName,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      void loadUser();
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [loadUser]);

  // 表示対象テナントのプランを取得する。プレビュー中はプレビュー先テナント、
  // 通常のclient_adminは自テナント、それ以外(super_adminの集約ビュー)はnullのまま。
  useEffect(() => {
    let cancelled = false;

    async function loadTenantPlan() {
      try {
        if (previewMode && previewTenantId) {
          const res = await authFetch(`${API_BASE}/v1/admin/tenants/${previewTenantId}`);
          if (!res.ok) { if (!cancelled) setTenantPlan(null); return; }
          const data = (await res.json()) as { plan?: TenantPlan };
          if (!cancelled) setTenantPlan(data.plan ?? "starter");
          return;
        }
        if (!previewMode && user?.role === "client_admin") {
          const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`);
          if (!res.ok) { if (!cancelled) setTenantPlan(null); return; }
          const data = (await res.json()) as { plan?: TenantPlan };
          if (!cancelled) setTenantPlan(data.plan ?? "starter");
          return;
        }
        if (!cancelled) setTenantPlan(null);
      } catch {
        if (!cancelled) setTenantPlan(null);
      }
    }

    void loadTenantPlan();
    return () => { cancelled = true; };
  }, [user, previewMode, previewTenantId]);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setPreviewMode(false);
    setPreviewTenantId(null);
    setPreviewTenantName(null);
  }, []);

  const enterPreview = useCallback((tenantId: string, tenantName: string) => {
    setPreviewMode(true);
    setPreviewTenantId(tenantId);
    setPreviewTenantName(tenantName);
  }, []);

  const exitPreview = useCallback(() => {
    setPreviewMode(false);
    setPreviewTenantId(null);
    setPreviewTenantName(null);
  }, []);

  const effectiveRole = previewMode ? "client_admin" : (user?.role ?? "anonymous");
  const isSuperAdmin = effectiveRole === "super_admin";
  const isClientAdmin = effectiveRole === "client_admin";

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      isSuperAdmin,
      isClientAdmin,
      logout,
      previewMode,
      previewTenantId,
      previewTenantName,
      enterPreview,
      exitPreview,
      tenantPlan,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
