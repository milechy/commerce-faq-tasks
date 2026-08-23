// src/agent/dialog/contextStore.ts

import type { DialogMessage } from './types'
import { buildTenantSessionKey } from './sessionKey'

type SessionId = string
type TenantId = string

interface SessionEntry {
  messages: DialogMessage[]
  lastAccessedAt: number
}

// MVP: インメモリのセッションストア。
// 将来 Redis 等に差し替えられるように、I/F はできるだけ単純に保つ。
// キー生成は sessionKey.ts に一本化（salesContextStore.ts と共有）。
const sessions = new Map<string, SessionEntry>()

// 1 セッションあたり保持する最大メッセージ数（安全のため軽く絞っておく）
const MAX_HISTORY_LENGTH = 20

// widget は会話IDをページロードごとに新規発行する（public/widget.js）ため、
// エントリ数はページビュー数とともに単調増加する。1件あたりは MAX_HISTORY_LENGTH で
// 頭打ちでも、件数に上限が無いと max_memory_restart(512M) による PM2 再起動を招き、
// 進行中の全会話が文脈を失う（dialogAgent はこのストアを唯一の履歴ソースにしている）。
// スイープ方式・TTL値は middleware/inputSanitizer.ts, middleware/topicGuard.ts と揃える。
const SESSION_ENTRY_TTL_MS = 30 * 60 * 1000 // 30 minutes

export function getSessionHistory(tenantId: TenantId, sessionId: SessionId): DialogMessage[] {
  const entry = sessions.get(buildTenantSessionKey(tenantId, sessionId))
  if (!entry) return []
  // 継続中の会話が TTL で消えないよう、読み取りでも最終アクセス時刻を更新する。
  // dialogAgent は毎ターン getSessionHistory を呼ぶため、これが会話の生存signalになる。
  entry.lastAccessedAt = Date.now()
  return entry.messages
}


export function appendToSessionHistory(
  tenantId: TenantId,
  sessionId: SessionId,
  messages: DialogMessage[],
): DialogMessage[] {
  const key = buildTenantSessionKey(tenantId, sessionId)
  const prev = sessions.get(key)?.messages ?? []
  const merged = [...prev, ...messages]

  const next =
    merged.length > MAX_HISTORY_LENGTH
      ? merged.slice(merged.length - MAX_HISTORY_LENGTH)
      : merged

  sessions.set(key, { messages: next, lastAccessedAt: Date.now() })
  return next
}

/**
 * TTL を超過したエントリを掃き出す。戻り値は削除件数（監視・テスト用）。
 * inputSanitizer.evictExpiredSessions と同じ責務・同じ作法。
 */
export function evictExpiredSessionHistories(): number {
  const now = Date.now()
  let evicted = 0
  for (const [key, entry] of sessions.entries()) {
    if (now - entry.lastAccessedAt > SESSION_ENTRY_TTL_MS) {
      sessions.delete(key)
      evicted++
    }
  }
  return evicted
}

/** 現在保持しているセッション数（メモリ蓄積の観測用）。 */
export function sessionHistoryCount(): number {
  return sessions.size
}

// Set up periodic eviction at module level
// .unref() は必須（プロセス終了 / jest をブロックしないため）
setInterval(evictExpiredSessionHistories, SESSION_ENTRY_TTL_MS).unref?.()
