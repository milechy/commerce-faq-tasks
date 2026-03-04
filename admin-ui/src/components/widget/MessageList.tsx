import { useEffect, useRef } from 'react'

export interface WidgetMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface MessageListProps {
  messages: WidgetMessage[]
  isLoading: boolean
}

const styles = {
  container: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  bubbleWrapper: (role: 'user' | 'assistant') => ({
    display: 'flex',
    justifyContent: role === 'user' ? 'flex-end' : 'flex-start',
  }),
  bubble: (role: 'user' | 'assistant') => ({
    maxWidth: '80%',
    padding: '10px 14px',
    borderRadius: role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
    backgroundColor: role === 'user' ? '#2563eb' : '#f1f5f9',
    color: role === 'user' ? '#ffffff' : '#1e293b',
    fontSize: '16px',
    lineHeight: '1.5',
    wordBreak: 'break-word' as const,
    whiteSpace: 'pre-wrap' as const,
  }),
  timestamp: {
    fontSize: '11px',
    color: '#94a3b8',
    marginTop: '4px',
    textAlign: 'center' as const,
  },
  loadingWrapper: {
    display: 'flex',
    justifyContent: 'flex-start',
  },
  loadingBubble: {
    padding: '10px 14px',
    borderRadius: '18px 18px 18px 4px',
    backgroundColor: '#f1f5f9',
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  },
  dot: (delay: string, prefersReducedMotion: boolean) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#94a3b8',
    animation: prefersReducedMotion ? 'none' : `bounce 1.2s ${delay} infinite`,
  }),
  emptyState: {
    textAlign: 'center' as const,
    color: '#94a3b8',
    fontSize: '16px',
    padding: '32px 16px',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
} as const

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

export default function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (prefersReducedMotion) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isLoading, prefersReducedMotion])

  if (messages.length === 0 && !isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <span>ご質問をどうぞ。お気軽にお聞きください。</span>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container} role="log" aria-live="polite" aria-label="チャット履歴">
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>

      {messages.map((msg) => (
        <div key={msg.id} style={styles.bubbleWrapper(msg.role)}>
          <div>
            <div
              style={styles.bubble(msg.role)}
              role="article"
              aria-label={msg.role === 'user' ? 'あなたのメッセージ' : 'アシスタントの返答'}
            >
              {msg.content}
            </div>
            <div style={styles.timestamp}>{formatTime(msg.timestamp)}</div>
          </div>
        </div>
      ))}

      {isLoading && (
        <div style={styles.loadingWrapper} aria-label="返答を生成中" role="status">
          <div style={styles.loadingBubble}>
            <div style={styles.dot('0s', prefersReducedMotion)} />
            <div style={styles.dot('0.2s', prefersReducedMotion)} />
            <div style={styles.dot('0.4s', prefersReducedMotion)} />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}
