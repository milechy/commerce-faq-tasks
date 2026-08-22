import type { SupabaseJwtPayload } from "./verifySupabaseJwt";

// admin API (管理面) で使ってよいトークンかを判定する。
// verifySupabaseJwt は widget セッション/chat-test トークンの検証にも共用されているため、
// 「署名が正しい」ことと「管理面で使える」ことを分離する必要がある。
export function isAdminUsableToken(payload: SupabaseJwtPayload): boolean {
  const topLevelRole = payload.role;
  const metadataRole = payload.app_metadata?.role;

  if (topLevelRole === "anon" || metadataRole === "anon") return false;
  if ((payload as Record<string, unknown>).purpose) return false;

  return metadataRole === "super_admin" || metadataRole === "client_admin";
}
