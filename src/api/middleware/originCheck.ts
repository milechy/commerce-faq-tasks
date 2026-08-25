// src/api/middleware/originCheck.ts
//
// Async per-tenant Origin enforcement backed by the DB tenants.allowed_origins column.
// Runs after authMiddleware (req.tenantId is set) in the apiStack.
// If allowed_origins is empty → allow all (backward-compatible).
// If non-empty → reject origins not in the list with 403.

import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

interface OriginCheckOptions {
  logger?: Logger;
}

/**
 * ワイルドカードを許可する唯一の形は「ホスト先頭ラベルを `*` に置き換えたサブドメイン指定」。
 *
 *   OK: https://*.example.com  → https://sub.example.com / https://a.b.example.com
 *   NG: https://*              → 全 https オリジンにマッチしてしまう
 *   NG: https://*evil.com      → https://notevil.com にもマッチしてしまう
 *   NG: https://*.a.*.com      → `*` は1個まで
 *   NG: https://*.com          → 任意の .com オリジン(https://evil.com 等)にマッチしてしまう
 *   NG: https://*.co.jp        → 任意の .co.jp オリジンにマッチしてしまう(下記 KNOWN_PUBLIC_SUFFIXES 参照)
 *
 * 形を縛る理由: allowedOrigins は tenant-context.ts の isOriginKnownToAnyTenant 経由で
 * CORS(cors.ts)にも使われる。1テナントが `https://*` を登録するだけで、全テナントに対して
 * 任意オリジンが Access-Control-Allow-Origin に反射される(しかも credentials 付き)。
 * 保存時バリデーション(admin/tenants/routes.ts)と二重に効かせることで、手動UPDATE等で
 * 入り込んだ危険なパターンも照合側で無効化する。
 *
 * `*.` の直後は最低2ラベル(例: example.com)を要求する。当初はラベル数を問わない形
 * だったため、`https://*.com` のような単一ラベルのジェネリックTLDが「安全な形」として
 * 保存・照合の両方を通過し、任意の .com オリジン(https://evil.com 含む)にマッチして
 * しまっていた(2026-08-25 実装確認で発覚)。
 */
const SAFE_WILDCARD_PATTERN = /^https:\/\/\*\.[^*/]+\.[^*/]+$/;

/**
 * 2ラベルであっても、誰でも取得できる「パブリックサフィックス」を直下ワイルドカードに
 * 置くと、そのサフィックスを持つ任意の企業ドメイン(https://rakuten.co.jp 等)に
 * マッチしてしまう。R2C は日本向けテナントが主体のため、代表的な日本のパブリック
 * サフィックスだけを狭く塞ぐ。フルの Public Suffix List(数千件規模)を正しく判定するには
 * 外部データセットへの依存追加が必要になり、このミドルウェアの役割(既知の危険な既定
 * パターンの排除)に対して過剰なため採用しない。新しい危険な既定値が見つかった場合は
 * ここに追加する。
 */
const KNOWN_PUBLIC_SUFFIXES = new Set<string>([
  "co.jp", "ne.jp", "or.jp", "ac.jp", "ad.jp", "ed.jp", "go.jp", "gr.jp", "lg.jp",
]);

/**
 * `https://*.<suffix>` の形として安全か。SAFE_WILDCARD_PATTERN(ラベル数)と
 * KNOWN_PUBLIC_SUFFIXES(既知の危険な2ラベル)の両方を満たす必要がある。
 * 保存時バリデーションと照合の双方から呼ぶ(定義を二重に持たない)。
 */
function isSafeWildcardPattern(pattern: string): boolean {
  if (!SAFE_WILDCARD_PATTERN.test(pattern)) return false;
  const suffix = pattern.slice("https://*.".length);
  return !KNOWN_PUBLIC_SUFFIXES.has(suffix);
}

/**
 * allowedOrigins に保存してよい形かどうか。保存時バリデーションと照合の双方で使う。
 * ワイルドカードを含まない値は https:// 始まりであれば許可する(既存データ互換)。
 */
export function isValidOriginPattern(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  if (!value.includes("*")) return true;
  return isSafeWildcardPattern(value);
}

/**
 * ワイルドカードパターンにOriginが一致するか確認。
 * 例: "https://*.example.com" → https://sub.example.com にマッチ
 */
function matchesPattern(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes("*")) return false;
  // 危険な形は照合対象にしない(保存時に弾いているが、過去データ・手動UPDATEへの保険)
  if (!isSafeWildcardPattern(pattern)) return false;
  // エスケープ(`.`→`\.`)を先に済ませてから `*` を展開する順序を保つ。
  // 展開先を `.*` ではなく `[^/]+` にして、空マッチとパス混入を防ぐ。
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(origin);
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((pattern) => matchesPattern(origin, pattern));
}

export function createOriginCheckMiddleware(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> } | null,
  opts: OriginCheckOptions = {}
) {
  return async function originCheckMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // chat-test tokens are admin-issued; skip per-tenant origin enforcement
    if ((req as any).isChatTestToken) {
      next();
      return;
    }

    if (!db) {
      next();
      return;
    }

    const tenantId = (req as any).tenantId as string | undefined;
    if (!tenantId) {
      next();
      return;
    }

    try {
      const result = await db.query(
        "SELECT allowed_origins FROM tenants WHERE id = $1",
        [tenantId]
      );
      const allowedOrigins: string[] = result.rows[0]?.allowed_origins ?? [];

      if (allowedOrigins.length > 0) {
        const origin = req.headers.origin;
        if (origin && !isOriginAllowed(origin, allowedOrigins)) {
          opts.logger?.warn(
            { tenantId, origin, allowedOrigins },
            "origin_rejected_db"
          );
          res.status(403).json({
            error: "origin_not_allowed",
            message: "このドメインからのアクセスは許可されていません。",
          });
          return;
        }
      }
    } catch (err) {
      // DB unavailable — fail open to avoid breaking the service
      opts.logger?.warn({ tenantId, err }, "origin_check_db_error");
    }

    next();
  };
}
