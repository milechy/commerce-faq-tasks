// admin-ui/src/components/common/NotificationBell.tsx
// Phase52h: In-App通知センター — ベルアイコン + ドロップダウン

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch, API_BASE } from "../../lib/api";

interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  link?: string;
  is_read: boolean;
  created_at: string;
}

const TYPE_ICON: Record<string, string> = {
  ai_rule_suggested: "🤖",
  knowledge_gap_frequent: "🔍",
  low_score_alert: "⚠️",
  avatar_warning: "🚨",
  feedback_received: "📝",
  outcome_recorded: "✅",
  conversion_rate_change: "📈",
  outcome_reminder: "📋",
  high_conversion_pattern: "🎯",
  pdf_processed: "📄",
  // Phase63: オプション代行
  option_ordered: "🛒",
  option_scheduled: "📅",
  option_completed: "🎉",
  // Phase64: プレミアムアバター制作代行
  premium_avatar_ordered: "🎨",
  premium_avatar_completed: "✨",
  // Phase65-3: CV未発火アラート
  cv_unfired: "📉",
};

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "昨日";
  return `${days}日前`;
}

export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/notifications?is_read=false&limit=5`);
      if (!res.ok) return;
      const data = await res.json() as { items: NotificationItem[]; unread_count: number };
      setItems(data.items ?? []);
      setUnreadCount(data.unread_count ?? 0);
    } catch {
      // silent
    }
  }, []);

  // 初回ロード
  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // 30秒ポーリング
  useEffect(() => {
    const timer = setInterval(() => {
      void fetchNotifications();
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchNotifications]);

  // 外側クリックで閉じる
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await authFetch(`${API_BASE}/v1/admin/notifications/read-all`, { method: "PATCH" });
      setUnreadCount(0);
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    } catch {
      // silent
    }
  };

  const handleClickItem = async (item: NotificationItem) => {
    setOpen(false);
    if (!item.is_read) {
      try {
        await authFetch(`${API_BASE}/v1/admin/notifications/${item.id}/read`, { method: "PATCH" });
        setUnreadCount((c) => Math.max(0, c - 1));
        setItems((prev) => prev.map((n) => n.id === item.id ? { ...n, is_read: true } : n));
      } catch {
        // silent
      }
    }
    if (item.link) navigate(item.link);
  };

  const handleOpen = async () => {
    setOpen((o) => !o);
    if (!open) {
      setLoading(true);
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/notifications?limit=5`);
        if (res.ok) {
          const data = await res.json() as { items: NotificationItem[]; unread_count: number };
          setItems(data.items ?? []);
          setUnreadCount(data.unread_count ?? 0);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div ref={dropRef} style={{ position: "relative", flexShrink: 0 }}>
      {/* Bell button */}
      <button
        onClick={() => void handleOpen()}
        aria-label="通知"
        style={{
          position: "relative",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "6px 8px",
          minWidth: 44,
          minHeight: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
          color: "#9ca3af",
          fontSize: 18,
          transition: "background 0.15s",
        }}
      >
        🔔
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              background: "#ef4444",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 999,
              minWidth: 16,
              height: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 320,
            maxWidth: "calc(100vw - 16px)",
            background: "rgba(9,14,28,0.98)",
            border: "1px solid #1f2937",
            borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            zIndex: 1002,
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid #1f2937",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "#f9fafb" }}>
              通知
              {unreadCount > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    background: "#ef4444",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 700,
                    borderRadius: 999,
                    padding: "1px 5px",
                  }}
                >
                  {unreadCount}
                </span>
              )}
            </span>
            {unreadCount > 0 && (
              <button
                onClick={() => void handleMarkAllRead()}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  color: "#60a5fa",
                  padding: "2px 4px",
                }}
              >
                全て既読
              </button>
            )}
          </div>

          {/* Items */}
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: "20px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                読み込み中...
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center", color: "#6b7280", fontSize: 13 }}>
                新しい通知はありません
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => void handleClickItem(item)}
                  style={{
                    display: "flex",
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    gap: 10,
                    background: item.is_read ? "transparent" : "rgba(96,165,250,0.05)",
                    border: "none",
                    borderBottom: "1px solid rgba(31,41,55,0.5)",
                    cursor: "pointer",
                    alignItems: "flex-start",
                    minHeight: 44,
                  }}
                >
                  <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
                    {TYPE_ICON[item.type] ?? "🔔"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 2,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 8,
                          color: item.is_read ? "#4b5563" : "#60a5fa",
                        }}
                      >
                        {item.is_read ? "○" : "●"}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: item.is_read ? 400 : 600,
                          color: item.is_read ? "#9ca3af" : "#f9fafb",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.title}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#6b7280",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.message}
                    </div>
                    <div style={{ fontSize: 10, color: "#4b5563", marginTop: 3 }}>
                      {relativeTime(item.created_at)}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
