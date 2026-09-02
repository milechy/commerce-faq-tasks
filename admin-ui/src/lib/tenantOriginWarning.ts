// admin-ui/src/lib/tenantOriginWarning.ts
//
// P0-5 (GID 1217808301788163): 保存時に「許可ドメインの中身が誤っている可能性」を
// 警告するための純粋関数。保存はブロックしない(運用上、意図的に空にする場面がありうる
// ため)— 呼び出し側は警告を表示しつつ保存を続ける。
//
// 判定の考え方は src/lib/tenantConfigAudit.ts (バックエンドの点検スクリプト側) と同じだが、
// admin-ui はバックエンドの src/ を import しない構成(ビルド境界)のためここに複製する。
// SettingsTab.tsx のワイルドカード検証コメントと同じ事情。判定基準を変えるときは両方を
// 更新すること。

const R2C_OWN_HOSTS = new Set(["admin.r2c.biz", "api.r2c.biz", "r2c.biz"]);

function extractHost(origin: string): string | null {
  const m = /^https:\/\/([^/]+)$/.exec(origin.trim());
  return m ? m[1] : null;
}

// 末尾スラッシュ・大文字・既定ポートの表記揺れで判定を取りこぼさない。
// 判定基準は src/lib/tenantConfigAudit.ts と揃えること(両方更新が必要)。
function isR2cOwnHost(origin: string): boolean {
  const host = extractHost(origin.trim().replace(/\/+$/, "").toLowerCase());
  if (host === null) return false;
  return R2C_OWN_HOSTS.has(host.replace(/:443$/, ""));
}

export function hasEmptyOrigins(allowedOrigins: string[]): boolean {
  return allowedOrigins.every((o) => o.trim().length === 0);
}

export function isR2cOwnDomainOnly(allowedOrigins: string[]): boolean {
  if (allowedOrigins.every((o) => o.trim().length === 0)) return false;
  return allowedOrigins.every(isR2cOwnHost);
}

/**
 * A2A-0j: allowed_origins に R2C 自身の運用ドメインが1件以上含まれるが、
 * テナントの実サイトのドメインも含まれている(=全件一致ではない)場合に true を返す。
 * 全件が R2C 自身のみの致命的ケース(ウィジェットが1ページも動かない)は
 * isR2cOwnDomainOnly が担当する。こちらは「動きはするが不要なエントリが混ざっている」
 * 軽度のケース(例: Accept の実データ, 2026-09-02 実測)を拾う。
 * 判定基準は src/lib/tenantConfigAudit.ts と揃えること(両方更新が必要)。
 */
export function isR2cOwnDomainMixed(allowedOrigins: string[]): boolean {
  if (allowedOrigins.every((o) => o.trim().length === 0)) return false;
  const ownCount = allowedOrigins.filter(isR2cOwnHost).length;
  return ownCount > 0 && ownCount < allowedOrigins.length;
}

/** 保存直前に表示する警告の強度。null は警告対象でないことを表す。 */
export type OriginWarningLevel = "empty" | "r2c_own_only" | "r2c_own_mixed";

/**
 * 保存直前に表示する警告の強度を返す(表示文言は呼び出し側が i18n 辞書から引く)。
 * - "empty": fail-open。どのサイトに設置してもチャットが動いてしまう
 * - "r2c_own_only": 致命的。テナントの実ドメインが1つも無く、ウィジェットが1ページも動かない
 * - "r2c_own_mixed": 軽度。ウィジェット自体は動くが、R2C自身のドメインは
 *   サイト訪問者のブラウザが送る情報とは一致しない不要なエントリ
 * 警告対象でなければ null。
 */
export function buildOriginWarningLevel(allowedOrigins: string[]): OriginWarningLevel | null {
  if (hasEmptyOrigins(allowedOrigins)) return "empty";
  if (isR2cOwnDomainOnly(allowedOrigins)) return "r2c_own_only";
  if (isR2cOwnDomainMixed(allowedOrigins)) return "r2c_own_mixed";
  return null;
}
