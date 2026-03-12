// src/lib/api.ts
export const API_BASE: string =
  import.meta.env.VITE_API_BASE || "http://localhost:3100";

/** supabaseSession から access_token を返す */
function getSessionToken(): string | null {
  try {
    const raw = localStorage.getItem("supabaseSession");
    if (!raw) return null;
    return (JSON.parse(raw) as { access_token?: string })?.access_token ?? null;
  } catch {
    localStorage.removeItem("supabaseSession");
    return null;
  }
}

/** supabaseSession の JWT から app_metadata.tenant_id を返す */
export function getTenantIdFromSession(): string | null {
  try {
    const raw = localStorage.getItem("supabaseSession");
    if (!raw) return null;
    const token = (JSON.parse(raw) as { access_token?: string })?.access_token;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1])) as {
      app_metadata?: { tenant_id?: string };
    };
    return payload?.app_metadata?.tenant_id ?? null;
  } catch {
    return null;
  }
}

export async function adminFetch(path: string, options: RequestInit = {}) {
  const token = getSessionToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API error: ${res.status} - ${txt}`);
  }

  return res.json();
}
