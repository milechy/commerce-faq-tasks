import { useCallback, useEffect, useRef, useState } from 'react'
import ChatInput from './ChatInput'
import MessageList, { type WidgetMessage } from './MessageList'

interface ApiChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  tenantId: string
}

interface ApiResponse {
  data?: ApiChatMessage
  error?: string
  requestId: string
  tenantId: string
}

interface ChatWidgetProps {
  tenantId: string
  apiBaseUrl?: string
  allowedOrigins?: string[]
  title?: string
}

const WIDGET_WIDTH = 390
const WIDGET_HEIGHT = 560

const styles = {
  root: {
    position: 'fixed' as const,
    bottom: '24px',
    right: '24px',
    zIndex: 9999,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  panel: (isOpen: boolean, prefersReducedMotion: boolean) => ({
    position: 'absolute' as const,
    bottom: '64px',
    right: 0,
    width: `min(${WIDGET_WIDTH}px, calc(100vw - 32px))`,
    height: `${WIDGET_HEIGHT}px`,
    maxHeight: 'calc(100vh - 120px)',
    backgroundColor: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    opacity: isOpen ? 1 : 0,
    transform: isOpen ? 'scale(1) translateY(0)' : 'scale(0.9) translateY(16px)',
    transformOrigin: 'bottom right',
    transition: prefersReducedMotion ? 'none' : 'opacity 0.2s, transform 0.2s',
    pointerEvents: isOpen ? ('auto' as const) : ('none' as const),
  }),
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: '16px',
    fontWeight: 600,
    margin: 0,
  },
  headerMeta: {
    fontSize: '12px',
    opacity: 0.8,
    marginTop: '2px',
  },
  closeButton: {
    minWidth: '44px',
    minHeight: '44px',
    width: '44px',
    height: '44px',
    border: 'none',
    background: 'rgba(255,255,255,0.2)',
    borderRadius: '50%',
    color: '#ffffff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    padding: 0,
  },
  fab: (isOpen: boolean, prefersReducedMotion: boolean) => ({
    minWidth: '56px',
    minHeight: '56px',
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    border: 'none',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(37,99,235,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: prefersReducedMotion ? 'none' : 'transform 0.15s, box-shadow 0.15s',
    transform: isOpen ? 'scale(0.95)' : 'scale(1)',
    padding: 0,
  }),
  errorBanner: {
    padding: '10px 16px',
    backgroundColor: '#fef2f2',
    color: '#dc2626',
    fontSize: '14px',
    borderBottom: '1px solid #fecaca',
    flexShrink: 0,
  },
} as const

const CHAT_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const CLOSE_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export default function ChatWidget({
  tenantId,
  apiBaseUrl = '',
  allowedOrigins = [],
  title = 'サポートチャット',
}: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<WidgetMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conversationIdRef = useRef<string>(generateId())
  const abortControllerRef = useRef<AbortController | null>(null)

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // postMessage: ホストサイトへイベントを通知
  const emitToHost = useCallback(
    (type: string, payload: Record<string, unknown>) => {
      const targetOrigin = allowedOrigins[0] ?? window.location.origin
      try {
        window.postMessage({ source: 'faq-widget', type, ...payload }, targetOrigin)
      } catch {
        // origin mismatch は無視（host origin が不明な場合もある）
      }
    },
    [allowedOrigins],
  )

  // postMessage: ホストサイトからの制御コマンドを受信
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // origin 検証：allowedOrigins が設定されている場合のみ許可
      if (allowedOrigins.length > 0 && !allowedOrigins.includes(event.origin)) {
        return
      }

      const data = event.data as { source?: string; type?: string; message?: string }
      if (data?.source !== 'faq-widget-host') return

      switch (data.type) {
        case 'open':
          setIsOpen(true)
          break
        case 'close':
          setIsOpen(false)
          break
        case 'toggle':
          setIsOpen((prev) => !prev)
          break
        default:
          break
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [allowedOrigins])

  // ウィジェット開閉時にホストへ通知
  useEffect(() => {
    emitToHost(isOpen ? 'widget:opened' : 'widget:closed', {})
  }, [isOpen, emitToHost])

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return

      setError(null)

      const userMessage: WidgetMessage = {
        id: generateId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, userMessage])
      setIsLoading(true)

      // ホストへメッセージ送信を通知
      emitToHost('user:message', { messageLength: text.length })

      abortControllerRef.current?.abort()
      abortControllerRef.current = new AbortController()

      try {
        const historyForApi = messages.slice(-20).map((m) => ({
          role: m.role,
          content: m.content,
        }))

        const res = await fetch(`${apiBaseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // tenantId は body ではなくヘッダで送信（CLAUDE.md Anti-Slop）
            'X-Tenant-ID': tenantId,
          },
          body: JSON.stringify({
            message: text,
            conversationId: conversationIdRef.current,
            history: historyForApi,
          }),
          signal: abortControllerRef.current.signal,
        })

        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(json.error ?? `HTTP ${res.status}`)
        }

        const json: ApiResponse = await res.json()

        if (json.error) {
          throw new Error(json.error)
        }

        const assistantMessage: WidgetMessage = {
          id: json.data?.id ?? generateId(),
          role: 'assistant',
          content:
            json.data?.content ??
            '申し訳ありません。現在回答を生成できませんでした。再度お試しください。',
          timestamp: json.data?.timestamp ?? Date.now(),
        }
        setMessages((prev) => [...prev, assistantMessage])

        emitToHost('assistant:message', { messageLength: assistantMessage.content.length })
      } catch (err) {
        if ((err as Error).name === 'AbortError') return

        const friendlyMsg =
          '通信エラーが発生しました。しばらくしてから再試行してください。'
        setError(friendlyMsg)

        emitToHost('widget:error', { error: (err as Error).message })
      } finally {
        setIsLoading(false)
      }
    },
    [messages, isLoading, tenantId, apiBaseUrl, emitToHost],
  )

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev)
  }, [])

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return (
    <div style={styles.root} aria-label="FAQチャットウィジェット">
      {/* チャットパネル */}
      <div
        style={styles.panel(isOpen, prefersReducedMotion)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!isOpen}
      >
        {/* ヘッダ */}
        <div style={styles.header}>
          <div>
            <p style={styles.headerTitle}>{title}</p>
            <p style={styles.headerMeta}>ご質問はお気軽にどうぞ</p>
          </div>
          <button
            onClick={handleClose}
            style={styles.closeButton}
            aria-label="チャットを閉じる"
            type="button"
          >
            {CLOSE_ICON}
          </button>
        </div>

        {/* エラーバナー */}
        {error && (
          <div style={styles.errorBanner} role="alert" aria-live="assertive">
            <span>{error}</span>
            <button
              onClick={dismissError}
              style={{
                marginLeft: '8px',
                background: 'none',
                border: 'none',
                color: '#dc2626',
                cursor: 'pointer',
                padding: '0 4px',
                fontSize: '14px',
              }}
              aria-label="エラーを閉じる"
              type="button"
            >
              ✕
            </button>
          </div>
        )}

        {/* メッセージ一覧 */}
        <MessageList messages={messages} isLoading={isLoading} />

        {/* 入力フォーム */}
        <ChatInput onSend={handleSend} isLoading={isLoading} />
      </div>

      {/* FABボタン */}
      <button
        onClick={handleToggle}
        style={styles.fab(isOpen, prefersReducedMotion)}
        aria-label={isOpen ? 'チャットを閉じる' : 'チャットを開く'}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        type="button"
      >
        {isOpen ? CLOSE_ICON : CHAT_ICON}
      </button>
    </div>
  )
}
