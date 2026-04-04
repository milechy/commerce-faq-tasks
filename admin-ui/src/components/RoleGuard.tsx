import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

/** super_admin のみ表示。それ以外は何も描画しない */
export function SuperAdminOnly({ children }: { children: React.ReactNode }) {
  const { isSuperAdmin, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isSuperAdmin) return null;
  return <>{children}</>;
}

/** ログイン必須ルート。未ログインは /login へ、super_admin 専用ページは /admin へリダイレクト */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** super_admin 専用ルート。それ以外は /admin へリダイレクト */
export function SuperAdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isSuperAdmin } = useAuth();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isSuperAdmin) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

/** super_admin + client_admin 共通ルート。未ログインは /login へ */
export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
