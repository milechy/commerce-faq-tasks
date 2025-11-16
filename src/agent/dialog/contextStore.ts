// src/agent/dialog/contextStore.ts

import type { DialogMessage } from './types'

type SessionId = string

// MVP: インメモリのセッションストア。
// 将来 Redis 等に差し替えられるように、I/F はできるだけ単純に保つ。
const sessions = new Map<SessionId, DialogMessage[]>()

// 1 セッションあたり保持する最大メッセージ数（安全のため軽く絞っておく）
const MAX_HISTORY_LENGTH = 20

export function getSessionHistory(sessionId: SessionId): DialogMessage[] {
  return sessions.get(sessionId) ?? []
}

export function overwriteSessionHistory(
  sessionId: SessionId,
  history: DialogMessage[],
): void {
  if (history.length > MAX_HISTORY_LENGTH) {
    sessions.set(
      sessionId,
      history.slice(history.length - MAX_HISTORY_LENGTH),
    )
  } else {
    sessions.set(sessionId, history)
  }
}

export function appendToSessionHistory(
  sessionId: SessionId,
  messages: DialogMessage[],
): DialogMessage[] {
  const prev = sessions.get(sessionId) ?? []
  const merged = [...prev, ...messages]

  if (merged.length > MAX_HISTORY_LENGTH) {
    const trimmed = merged.slice(merged.length - MAX_HISTORY_LENGTH)
    sessions.set(sessionId, trimmed)
    return trimmed
  }

  sessions.set(sessionId, merged)
  return merged
}