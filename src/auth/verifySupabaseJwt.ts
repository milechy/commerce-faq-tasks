import jwt from "jsonwebtoken";

const jwtSecret = process.env.SUPABASE_JWT_SECRET;

export type SupabaseJwtPayload = jwt.JwtPayload & {
  // Supabase 標準
  sub: string; // user id
  email?: string;
  role?: string;

  // 将来カスタムクレームに tenant_id を入れる想定
  tenant_id?: string;
};

export function verifySupabaseJwt(
  token: string | undefined
): SupabaseJwtPayload | null {
  if (!token || !jwtSecret) return null;

  try {
    return jwt.verify(token, jwtSecret) as SupabaseJwtPayload;
  } catch (err) {
    console.warn("[verifySupabaseJwt] invalid token:", (err as Error).message);
    return null;
  }
}
