import jwt from "jsonwebtoken";
import { logger } from '../lib/logger';


const jwtSecret = process.env.SUPABASE_JWT_SECRET;

export type SupabaseJwtPayload = jwt.JwtPayload & {
  // Supabase 標準
  sub: string; // user id
  email?: string;
  role?: string;

  // カスタムクレーム (top-level — 後方互換)
  tenant_id?: string;

  // Supabase JWT は app_metadata をペイロードに含める
  app_metadata?: {
    role?: string;
    tenant_id?: string;
    [key: string]: unknown;
  };
};

export function verifySupabaseJwt(
  token: string | undefined
): SupabaseJwtPayload | null {
  if (!token || !jwtSecret) return null;

  try {
    return jwt.verify(token, jwtSecret) as SupabaseJwtPayload;
  } catch (err) {
    logger.warn("[verifySupabaseJwt] invalid token:", (err as Error).message);
    return null;
  }
}
