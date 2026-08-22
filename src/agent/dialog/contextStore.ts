// src/agent/dialog/contextStore.ts

import type { DialogMessage } from './types'
import { buildTenantSessionKey } from './sessionKey'

type SessionId = string
type TenantId = string

// MVP: インメモリのセッションストア。
// 将来 Redis 等に差し替えられるように、I/F はできるだけ単純に保つ。
// キー生成は sessionKey.ts に一本化（salesContextStore.ts と共有）。
const sessions = new Map<string, DialogMessage[]>()

// 1 セッションあたり保持する最大メッセージ数（安全のため軽く絞っておく）
const MAX_HISTORY_LENGTH = 20

export function getSessionHistory(tenantId: TenantId, sessionId: SessionId): DialogMessage[] {
  return sessions.get(buildTenantSessionKey(tenantId, sessionId)) ?? []
}


export function appendToSessionHistory(
  tenantId: TenantId,
  sessionId: SessionId,
  messages: DialogMessage[],
): DialogMessage[] {
  const key = buildTenantSessionKey(tenantId, sessionId)
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