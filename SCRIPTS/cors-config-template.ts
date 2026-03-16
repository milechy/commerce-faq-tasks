/**
 * cors-config-template.ts — テナント別CORSホワイトリスト設定テンプレート
 * (Phase33 Stream D — CDN・タイムゾーン対応)
 *
 * 【統合役（Stream Integration）への注意】
 * このファイルはテンプレートです。
 * TenantConfig 型に allowedOrigins フィールドを追加する際の参考として使用してください。
 *
 * 現状のCORS実装との差分:
 *   - src/lib/cors.ts: グローバル allowedOrigins（環境変数 ALLOWED_ORIGINS から設定）
 *   - src/lib/security-policy.ts: テナント別 securityPolicy による origin 検証
 *
 * この設計により、テナント別 CORS は既に securityPolicyEnforcer（ミドルウェア第4層）で
 * 処理されている。本テンプレートはその設定モデルをドキュメント化したものです。
 */

// -----------------------------------------------------------------------
// テナント別CORSホワイトリスト設定の型定義
// -----------------------------------------------------------------------

/**
 * テナントのCORS設定
 *
 * 既存の TenantConfig（src/lib/tenant-context.ts）に追加する想定のフィールド。
 *
 * @example
 * {
 *   tenantId: "tenant-a",
 *   allowedOrigins: [
 *     "https://client1.example.com",
 *     "https://client2.example.com",
 *     "https://cdn.rajiuce.com",
 *   ],
 *   cdnOrigins: [
 *     "https://cdn.rajiuce.com",       // RAJIUCE CDN
 *     "https://cdnjs.cloudflare.com",  // 外部CDN（読み取り専用）
 *   ],
 * }
 */
export interface TenantCorsConfig {
  /** テナントID */
  tenantId: string;

  /** 許可するオリジンリスト（完全一致） */
  allowedOrigins: string[];

  /**
   * CDNオリジンリスト（widget.js 配信元として許可するオリジン）
   * allowedOrigins と別管理することで、CDN側のキャッシュ設定変更時に
   * API側のCORS設定を変えずに済む
   */
  cdnOrigins?: string[];

  /**
   * ワイルドカードサブドメイン許可（例: "*.example.com"）
   * セキュリティリスクあり。信頼できるサブドメインのみ使用すること。
   */
  allowedWildcardDomains?: string[];
}

// -----------------------------------------------------------------------
// CORSオリジン検証ユーティリティ
// -----------------------------------------------------------------------

/**
 * リクエストオリジンがテナントのCORS設定に合致するか検証する
 *
 * 優先順位:
 *  1. allowedOrigins の完全一致
 *  2. cdnOrigins の完全一致
 *  3. allowedWildcardDomains のワイルドカードマッチ
 */
export function isOriginAllowed(
  origin: string,
  config: TenantCorsConfig
): boolean {
  // 1. 完全一致チェック
  if (config.allowedOrigins.includes(origin)) return true;

  // 2. CDNオリジンチェック
  if (config.cdnOrigins?.includes(origin)) return true;

  // 3. ワイルドカードサブドメインチェック
  if (config.allowedWildcardDomains) {
    for (const pattern of config.allowedWildcardDomains) {
      if (matchWildcardOrigin(origin, pattern)) return true;
    }
  }

  return false;
}

/**
 * "*.example.com" 形式のワイルドカードとオリジンをマッチする
 *
 * セキュリティ注意:
 *   - プロトコルも検証する（https のみ許可を推奨）
 *   - *.example.com は evil.example.com も許可するため慎重に使用すること
 */
function matchWildcardOrigin(origin: string, pattern: string): boolean {
  if (!pattern.startsWith("*.")) return origin === pattern;

  try {
    const originUrl = new URL(origin);
    const patternDomain = pattern.slice(2); // "*.example.com" → "example.com"

    // サブドメインのみ許可（example.com 自体は許可しない）
    const hostname = originUrl.hostname;
    return hostname.endsWith("." + patternDomain);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// デフォルトCORS設定（環境別）
// -----------------------------------------------------------------------

/** 環境別のデフォルトCORSオリジン */
export const DEFAULT_CORS_CONFIG = {
  development: {
    allowedOrigins: [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
    ],
    cdnOrigins: [],
  },
  production: {
    allowedOrigins: [
      "https://rajiuce.com",
      "https://www.rajiuce.com",
    ],
    cdnOrigins: [
      "https://cdn.rajiuce.com",
    ],
  },
  staging: {
    allowedOrigins: [
      "https://staging.rajiuce.com",
    ],
    cdnOrigins: [
      "https://cdn-staging.rajiuce.com",
    ],
  },
} as const;

// -----------------------------------------------------------------------
// Cache-Control ヘッダー設定（CDN連携用）
// -----------------------------------------------------------------------

/**
 * パスパターンに応じた Cache-Control ヘッダーを返す
 *
 * CDN（Cloudflare等）がこのヘッダーを尊重してキャッシュ制御を行う。
 */
export function getCacheControlHeader(path: string): string {
  // API エンドポイント — キャッシュ禁止
  if (
    path.startsWith("/api/") ||
    path.startsWith("/agent") ||
    path.startsWith("/dialog/") ||
    path.startsWith("/search") ||
    path.startsWith("/v1/") ||
    path.startsWith("/metrics") ||
    path.startsWith("/health")
  ) {
    return "no-store, no-cache, must-revalidate";
  }

  // widget.js バージョン付きファイル — 長期キャッシュ（immutable）
  if (/\/widget\.(v[\d.]+)\.min\.js(\.gz)?$/.test(path)) {
    return "public, max-age=31536000, immutable"; // 1年
  }

  // widget.js / widget.latest.min.js — 短期キャッシュ
  if (/\/widget(\.(latest|min))?\.js(\.gz)?$/.test(path)) {
    return "public, max-age=3600, stale-while-revalidate=300"; // 1時間
  }

  // 静的アセット（画像、フォント等）
  if (/\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot)$/.test(path)) {
    return "public, max-age=86400, stale-while-revalidate=3600"; // 24時間
  }

  // その他の静的ファイル（HTML, CSS, JS）
  if (/\.(html|css|js)$/.test(path)) {
    return "public, max-age=300"; // 5分
  }

  // デフォルト: キャッシュしない
  return "no-store";
}
