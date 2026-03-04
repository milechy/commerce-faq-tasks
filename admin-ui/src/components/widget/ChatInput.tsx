import { useRef, useState } from 'react'

interface ChatInputProps {
  onSend: (message: string) => void
  isLoading: boolean
  disabled?: boolean
}

const styles = {
  form: {
    display: 'flex',
    gap: '8px',
    padding: '12px 16px',
    borderTop: '1px solid #e2e8f0',
    backgroundColor: '#ffffff',
    alignItems: 'flex-end',
  },
  textareaWrapper: {
    flex: 1,
    position: 'relative' as const,
  },
  textarea: {
    width: '100%',
    minHeight: '44px',
    maxHeight: '120px',
    padding: '10px 14px',
    fontSize: '16px',
    lineHeight: '1.5',
    border: '1px solid #cbd5e1',
    borderRadius: '22px',
    resize: 'none' as const,
    outline: 'none',
    fontFamily: 'inherit',
    backgroundColor: '#f8fafc',
    color: '#1e293b',
    boxSizing: 'border-box' as const,
    overflowY: 'auto' as const,
    display: 'block',
    transition: 'border-color 0.15s',
  },
  textareaFocus: {
    borderColor: '#2563eb',
    backgroundColor: '#ffffff',
  },
  sendButton: (canSend: boolean) => ({
    minWidth: '44px',
    minHeight: '44px',
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    border: 'none',
    backgroundColor: canSend ? '#2563eb' : '#cbd5e1',
    color: '#ffffff',
    cursor: canSend ? 'pointer' : 'not-allowed',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'background-color 0.15s, transform 0.1s',
    padding: 0,
  }),
} as const

const SEND_ICON = (
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
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
)

export default function ChatInput({ onSend, isLoading, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSend = value.trim().length > 0 && !isLoading && !disabled

  function autoResize() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    autoResize()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSend) return
    const trimmed = value.trim()
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    onSend(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) {
        const trimmed = value.trim()
        setValue('')
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
        onSend(trimmed)
      }
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={styles.form}
      role="search"
      aria-label="メッセージ入力フォーム"
    >
      <div style={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="メッセージを入力… (Shift+Enterで改行)"
          disabled={disabled || isLoading}
          rows={1}
          maxLength={2000}
          aria-label="メッセージ"
          style={{
            ...styles.textarea,
            ...(isFocused ? styles.textareaFocus : {}),
            opacity: disabled || isLoading ? 0.6 : 1,
          }}
        />
      </div>

      <button
        type="submit"
        disabled={!canSend}
        aria-label="送信"
        style={styles.sendButton(canSend)}
      >
        {SEND_ICON}
      </button>
    </form>
  )
}
