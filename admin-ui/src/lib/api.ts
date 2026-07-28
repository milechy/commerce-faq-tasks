// admin-ui/src/lib/api.ts
import { supabase } from "./supabaseClient";

export const API_BASE: string =
  import.meta.env.VITE_API_BASE || "http://localhost:3100";

/** Supabase SDK からアクセストークンを取得（自動リフレッシュ付き） */
async function getSessionToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  const { data: refreshed } = await supabase.auth.refreshSession();
  return refreshed.session?.access_token ?? null;
}

/**
 * 認証済み fetch ラッパー。
 * Authorization: Bearer <token> を自動付与する。
 * トークンが取得できない場合は Error("__AUTH_REQUIRED__") をスローする。
 */
export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getSessionToken();
  if (!token) throw new Error("__AUTH_REQUIRED__");
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });
}
