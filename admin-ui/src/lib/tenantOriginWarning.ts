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

function isR2cOwnHost(origin: string): boolean {
  const host = extractHost(origin);
  return host !== null && R2C_OWN_HOSTS.has(host);
}

export function hasEmptyOrigins(allowedOrigins: string[]): boolean {
  return allowedOrigins.length === 0;
}

export function isR2cOwnDomainOnly(allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  return allowedOrigins.every(isR2cOwnHost);
}

/**
 * 保存直前に表示する警告文言を返す。専門用語を使わず「このままだと何が起きるか」を書く。
 * 警告対象でなければ null。
 */
export function buildOriginWarning(allowedOrigins: string[]): string | null {
  if (hasEmptyOrigins(allowedOrigins)) {
    return "許可ドメインが空です。このままだと、どのサイトに設置してもチャットが動いてしまいます。テナント様の実際のサイトのURLを入力することをおすすめします。";
  }
  if (isR2cOwnDomainOnly(allowedOrigins)) {
    return "許可ドメインに管理画面のURLしか入っていません。このままだと、テナント様の実際のサイトにウィジェットを設置してもチャットが表示されません。実際のサイトのURLを追加してください。";
  }
  return null;
}
