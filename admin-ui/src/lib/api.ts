// src/lib/api.ts
export const API_BASE: string =
  import.meta.env.VITE_API_BASE || "http://localhost:3100";

export async function adminFetch(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem("admin_token");

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
