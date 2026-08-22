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
    // ⚠️ jwtClaims.ts の isAdminUsableToken がその判定を担う想定だが、
    //    **現時点ではどの認証ミドルウェアからも呼ばれていない**（配線は未完了）。
    //    「この関数を通ったトークン = 管理面で使ってよいトークン」ではないことに注意。
    //    現状 widget/anon/chat-test トークンを管理面で弾いているのは
    //    (a) widget は別鍵(WIDGET_JWT_SECRET)署名なのでそもそも検証を通らない
    //    (b) roleAuthMiddleware が app_metadata.role 不在を 403 にする
    //    の2層であり、purpose クレームによる遮断は効いていない。
    return jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }) as SupabaseJwtPayload;
  } catch (err) {
    logger.warn("[verifySupabaseJwt] invalid token:", (err as Error).message);
    return null;
  }
}
