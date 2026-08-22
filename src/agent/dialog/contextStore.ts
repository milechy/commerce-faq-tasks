// src/agent/dialog/contextStore.ts

import type { DialogMessage } from './types'

type SessionId = string
type TenantId = string

// MVP: インメモリのセッションストア。
// 将来 Redis 等に差し替えられるように、I/F はできるだけ単純に保つ。
// キーは `${tenantId}::${sessionId}` — テナントを跨いだ sessionId 衝突で
// 履歴が相互参照されないようにする（salesContextStore.ts と同じ方式）。
const sessions = new Map<string, DialogMessage[]>()

// 1 セッションあたり保持する最大メッセージ数（安全のため軽く絞っておく）
const MAX_HISTORY_LENGTH = 20

function toInternalKey(tenantId: TenantId, sessionId: SessionId): string {
  // tenantId は作成時バリデーション(/^[a-z0-9_-]+$/、tenants/routes.ts)により
  // コロンを含まない前提で、文字列中の最初の "::" が常に tenantId/sessionId の
  // 境界になる（sessionId は z.string().max(128) のみで文字種制限がなく "::" を
  // 含みうるが、それ自体は境界の一意性を壊さない）。
  // この前提が将来のバリデーション変更等で崩れると、異なる tenantId/sessionId の
  // 組み合わせが同一キーに衝突し履歴が混在しうるため、サイレントな衝突より
  // 明示的な失敗を優先する防御的アサーション。
  if (tenantId.includes('::')) {
    throw new Error(`contextStore: tenantId must not contain "::" (got: ${tenantId})`)
  }
  return `${tenantId}::${sessionId}`
}

export function getSessionHistory(tenantId: TenantId, sessionId: SessionId): DialogMessage[] {
  return sessions.get(toInternalKey(tenantId, sessionId)) ?? []
}


export function appendToSessionHistory(
  tenantId: TenantId,
  sessionId: SessionId,
  messages: DialogMessage[],
): DialogMessage[] {
  const key = toInternalKey(tenantId, sessionId)
  const prev = sessions.get(key) ?? []
  const merged = [...prev, ...messages]

  if (merged.length > MAX_HISTORY_LENGTH) {
    const trimmed = merged.slice(merged.length - MAX_HISTORY_LENGTH)
    sessions.set(key, trimmed)
    return trimmed
  }

  sessions.set(key, merged)
  return merged
}