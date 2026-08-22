// src/agent/dialog/sessionKey.ts
//
// テナントスコープのインメモリセッションストア（contextStore.ts / salesContextStore.ts）が
// 共通で使う内部キー生成。`${tenantId}::${sessionId}` 形式の連結ロジックが2ファイルに
// 別々に複製されており、片方（contextStore.ts）にだけ防御的アサーションが入っていた
// （CLAUDE.md禁止事項6「同じ関心事を2ファイルに複製したまま片方だけ直す」の実例）。

/**
 * tenantId は作成時バリデーション(/^[a-z0-9_-]+$/、tenants/routes.ts)により
 * コロンを含まない前提で、文字列中の最初の "::" が常に tenantId/sessionId の
 * 境界になる（sessionId は z.string().max(128) のみで文字種制限がなく "::" を
 * 含みうるが、それ自体は境界の一意性を壊さない）。
 * この前提が将来のバリデーション変更等で崩れると、異なる tenantId/sessionId の
 * 組み合わせが同一キーに衝突し履歴が混在しうるため、サイレントな衝突より
 * 明示的な失敗を優先する防御的アサーション。
 */
export function buildTenantSessionKey(tenantId: string, sessionId: string): string {
  if (tenantId.includes('::')) {
    throw new Error('session key: tenantId must not contain "::"')
  }
  return `${tenantId}::${sessionId}`
}
