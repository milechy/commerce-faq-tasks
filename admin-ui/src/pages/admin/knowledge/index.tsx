import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../auth/useAuth";

export const KNOWLEDGE_TENANT_STORAGE_KEY = "knowledge_last_tenant";

export default function KnowledgePage() {
  const navigate = useNavigate();
  const { user, isSuperAdmin, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!isSuperAdmin && user?.tenantId) {
      navigate(`/admin/knowledge/${user.tenantId}`, { replace: true });
      return;
    }
    if (isSuperAdmin) {
      const last = localStorage.getItem(KNOWLEDGE_TENANT_STORAGE_KEY) ?? "global";
      navigate(`/admin/knowledge/${last}`, { replace: true });
    }
  }, [isLoading, isSuperAdmin, user, navigate]);

  return null;
}
