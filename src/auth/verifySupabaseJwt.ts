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
    // アルゴリズム混同攻撃 (alg:none 等) を防ぐため HS256 に固定する。
    // audience は固定しない — この関数は Supabase 発行トークンだけでなく、
    // widget セッション/chat-test トークン (同じ secret で署名、aud クレーム無し) の検証にも
    // 共用されているため、ここでの検証は署名の正当性確認に限定する。
    // 用途ごとの許可判定 (purpose/role) は本関数では行わない。
    // jwtClaims.ts の isAdminUsableToken がその判定を担う。
    // 管理面の共通認証入口 src/admin/http/supabaseAuthMiddleware.ts の
    // jwt.verify 成功パスで isAdminUsableToken を呼び、purpose クレーム保持
    // トークン・role='anon'・super_admin/client_admin以外のroleを403で拒否する。
    // 「この関数(verifySupabaseJwt)を通った」だけでは管理面で使える保証にならない点は変わらない
    // （本関数は署名の正当性確認に限定し、用途判定は呼び出し側の責務）。
    return jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as SupabaseJwtPayload;
  } catch (err) {
    logger.warn("[verifySupabaseJwt] invalid token:", (err as Error).message);
    return null;
  }
}
