// src/api/widget/wpSiteUrl.ts
//
// WordPress プラグインが申告する site_url を、tenants.allowed_origins に保存できる
// origin 文字列へ正規化する純関数。
//
// ★ここでオリジンの「妥当性」を再定義しない。
//   保存してよい形かどうかの判定は既に src/api/middleware/originCheck.ts の
//   isValidOriginPattern が唯一の情報源であり、保存時(admin/tenants/routes.ts の
//   allowedOriginsSchema)と照合時(originCheck / security-policy / tenant-context)の
//   双方から共有されている。第3の緩い判定を作ると、片方だけ緩い状態ができる。
//   このファイルの責務は「WordPress が名乗る URL を origin の形に揃える」ことだけで、
//   最終的な可否は isValidOriginPattern に委ねる。
//
// 正規化が必要な理由: WordPress の site_url() はサイトの設置形態によって
// https://example.com / https://example.com/blog / https://example.com:8443 など
// パス付き・ポート付きを返す。allowed_origins が期待するのはパスを含まない origin。

import { isValidOriginPattern } from "../middleware/originCheck";

export type WpSiteUrlRejection =
  /** URL として解釈できない(空文字・スキーム無し・不正な文字を含む等)。 */
  | "invalid_url"
  /** https 以外。http のサイトは allowed_origins に保存できない。 */
  | "not_https"
  /** localhost / 内部IP / 予約TLD。R2C からサイト所有証明のために到達できない。 */
  | "not_public_host"
  /** 正規化はできたが isValidOriginPattern を通らなかった。 */
  | "rejected_pattern";

export type WpSiteUrlResult =
  | { ok: true; origin: string }
  | { ok: false; reason: WpSiteUrlRejection };

/**
 * 到達不能・検証不能なホスト名の判定。
 *
 * これを弾かないと「ローカル開発環境で接続を試み、サイト所有証明のHTTP取得が
 * タイムアウトするまで待たされ、原因も分からない」という体験になる
 * (要件書 §12.3 I-9)。事前に判定して「公開サイトが必要」と伝えるための関数。
 */
export function isNonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // RFC 6761 / 8375 の予約TLDと、WordPress のローカル開発で慣習的に使われるもの。
  const RESERVED_TLDS = [".local", ".test", ".invalid", ".example", ".localdomain"];
  if (RESERVED_TLDS.some((tld) => host.endsWith(tld))) return true;

  // IPv6 は URL.hostname で角括弧付きのまま返る。ループバックとユニークローカルを弾く。
  if (host.startsWith("[")) {
    const inner = host.slice(1, -1);
    if (inner === "::1" || inner === "::") return true;
    // fc00::/7 (ユニークローカル) と fe80::/10 (リンクローカル)
    if (/^f[cd][0-9a-f]{2}:/.test(inner)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(inner)) return true;
    return false;
  }

  // IPv4 リテラル。数値でないホスト名(通常のドメイン)はここを通らない。
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;          // loopback / private / this-host
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                    // link-local
    return false;
  }

  // ドットを含まない単一ラベル(イントラネットのホスト名)は公開サイトではない。
  if (!host.includes(".")) return true;

  return false;
}

/**
 * WordPress の site_url を allowed_origins へ保存できる origin に正規化する。
 *
 * パスとクエリとフラグメントは捨てる(サブディレクトリ設置でも origin は同じ)。
 * ポートは URL.origin の規則に従い、標準ポート(443)なら省略され、非標準なら残る。
 * ホスト名は URL パーサが小文字化・punycode 変換まで済ませてくれる。
 */
export function normalizeWpSiteUrl(raw: string): WpSiteUrlResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "") return { ok: false, reason: "invalid_url" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  // http:// のサイトを弾くのは isValidOriginPattern より前。理由を区別して
  // 返さないと、利用者に「httpsにしてください」と伝えられない(→ 禁止21)。
  if (parsed.protocol !== "https:") return { ok: false, reason: "not_https" };

  if (isNonPublicHostname(parsed.hostname)) {
    return { ok: false, reason: "not_public_host" };
  }

  const origin = parsed.origin;

  // 最終判定は既存の唯一の情報源に委ねる。ここで通らない形(ワイルドカードを
  // 含む site_url 等)は、そもそも WordPress が名乗る値としてありえない。
  if (!isValidOriginPattern(origin)) {
    return { ok: false, reason: "rejected_pattern" };
  }

  return { ok: true, origin };
}

/**
 * origin から tenants.id 用のラベルを決定的に組み立てる。
 * createTenantSchema の id 形式(3〜50字、`^[a-z0-9_-]+$`)に必ず収まる。
 *
 * ランダムサフィックスは呼び出し側が用意する(このファイルは乱数を持たない)。
 * 衝突耐性は呼び出し側の再試行 + tenants.id の PRIMARY KEY 制約に委ねる —
 * ここでは「同じ入力からは同じ ID が組み立てられる」ことだけを保証する。
 */
export function buildWpTenantId(origin: string, randomSuffix: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    host = "site";
  }
  // 先頭ラベルだけを使う(サブドメインを含めるとID長が伸びやすく、
  // "www" のような無意味な接頭辞が混ざるのを避ける)。
  const firstLabel = host.split(".")[0] ?? "";
  const sanitized = firstLabel
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const base = sanitized.length > 0 ? sanitized : "site";

  const suffix =
    (typeof randomSuffix === "string" ? randomSuffix : "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16) || "0";

  return `wp-${base}-${suffix}`;
}
