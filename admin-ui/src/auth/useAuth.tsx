import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export interface AuthUser {
  id: string;
  email: string;
  role: "super_admin" | "client_admin" | "anonymous";
  tenantId: string | null;
  tenantName: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isSuperAdmin: boolean;
  isClientAdmin: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isSuperAdmin: false,
  isClientAdmin: false,
  logout: async () => {},
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
      const meta = (supaUser.app_metadata ?? {}) as Record<string, unknown>;
      const role = parseRole(meta);
      const tenantId = (meta.tenant_id as string | undefined) ?? null;
      const tenantName = (meta.tenant_name as string | undefined) ?? null;

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

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
  }, []);

  const isSuperAdmin = user?.role === "super_admin";
  const isClientAdmin = user?.role === "client_admin";

  return (
    <AuthContext.Provider value={{ user, isLoading, isSuperAdmin, isClientAdmin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
