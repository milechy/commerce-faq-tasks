// admin-ui/src/pages/admin/feedback/index.tsx
// Super Admin: テナント別フィードバック一覧 + チャット

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";

interface Message {
  id: number;
  tenant_id: string;
  sender_role: "client_admin" | "super_admin";
  sender_email: string | null;
  content: string;
  is_read: boolean;
  flagged_for_improvement: boolean;
  created_at: string;
}

interface Thread {
  tenant_id: string;
  tenant_name: string;
  last_message: string;
  last_message_at: string;
  unread_count: number;
}

const BG = "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)";

export default function FeedbackPage() {
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const locale = lang === "en" ? "en-US" : "ja-JP";

  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [search, setSearch] = useState("");
  const [flaggedFilter, setFlaggedFilter] = useState(false);
  const [flagging, setFlagging] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback/threads`);
      if (!res.ok) return;
      const data = await res.json() as { threads: Thread[] };
      setThreads(data.threads ?? []);
    } catch { /* silent */ } finally {
      setLoadingThreads(false);
    }
  }, []);

  const fetchMessages = useCallback(async (tenantId: string, flaggedOnly = false) => {
    setLoadingMessages(true);
    try {
      const url = `${API_BASE}/v1/admin/feedback?tenant=${encodeURIComponent(tenantId)}${flaggedOnly ? "&flagged=true" : ""}`;
      const res = await authFetch(url);
      if (!res.ok) return;
      const data = await res.json() as { messages: Message[] };
      setMessages(data.messages ?? []);
      if (!flaggedOnly) {
        setThreads((prev) => prev.map((th) =>
          th.tenant_id === tenantId ? { ...th, unread_count: 0 } : th
        ));
      }
    } catch { /* silent */ } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => { void fetchThreads(); }, [fetchThreads]);

  useEffect(() => {
    if (selectedTenant) void fetchMessages(selectedTenant, flaggedFilter);
  }, [selectedTenant, flaggedFilter, fetchMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!selectedTenant || !input.trim() || sending) return;
    setSending(true);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input.trim(), tenant_id: selectedTenant }),
      });
      if (!res.ok) return;
      setInput("");
      await fetchMessages(selectedTenant, flaggedFilter);
    } catch { /* silent */ } finally {
      setSending(false);
    }
  };

  const handleFlag = async (msg: Message) => {
    if (flagging === msg.id) return;
    const nextFlagged = !msg.flagged_for_improvement;
    setFlagging(msg.id);
    // Optimistic update
    setMessages((prev) => prev.map((m) =>
      m.id === msg.id ? { ...m, flagged_for_improvement: nextFlagged } : m
    ));
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/feedback/${msg.id}/flag`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: nextFlagged }),
      });
      if (!res.ok) {
        // Revert on failure
        setMessages((prev) => prev.map((m) =>
          m.id === msg.id ? { ...m, flagged_for_improvement: msg.flagged_for_improvement } : m
        ));
      } else if (flaggedFilter && !nextFlagged) {
        // フィルター中にフラグ解除 → リストから除去
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      }
    } catch {
      setMessages((prev) => prev.map((m) =>
        m.id === msg.id ? { ...m, flagged_for_improvement: msg.flagged_for_improvement } : m
      ));
    } finally {
      setFlagging(null);
    }
  };

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const filteredThreads = threads.filter((th) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return th.tenant_name.toLowerCase().includes(q) || th.tenant_id.toLowerCase().includes(q);
  });

  const selectedThread = threads.find((th) => th.tenant_id === selectedTenant);

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#e5e7eb", padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>
      {/* ヘッダー */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 14, cursor: "pointer", padding: 0, marginBottom: 8, display: "block" }}
          >
            {t("feedback.back")}
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            📬 {t("feedback.title")}
          </h1>
        </div>
        <LangSwitcher />
      </header>

      {/* 2カラムレイアウト */}
      <div style={{ display: "flex", gap: 16, height: "calc(100vh - 160px)", minHeight: 400 }}>
        {/* 左: スレッド一覧 */}
        <div style={{
          width: 280,
          flexShrink: 0,
          borderRadius: 14,
          border: "1px solid #1f2937",
          background: "rgba(15,23,42,0.95)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #1f2937" }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "#9ca3af", margin: "0 0 8px" }}>
              {t("feedback.threads")}
            </p>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={lang === "ja" ? "テナントを検索..." : "Search tenants..."}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: "rgba(0,0,0,0.3)",
                color: "#e5e7eb",
                fontSize: 13,
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingThreads ? (
              <p style={{ textAlign: "center", color: "#6b7280", padding: 20, fontSize: 13 }}>⏳</p>
            ) : filteredThreads.length === 0 ? (
              <p style={{ textAlign: "center", color: "#6b7280", padding: 20, fontSize: 13 }}>
                {t("feedback.no_messages")}
              </p>
            ) : filteredThreads.map((th) => (
              <button
                key={th.tenant_id}
                onClick={() => setSelectedTenant(th.tenant_id)}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  border: "none",
                  borderBottom: "1px solid #1f2937",
                  background: selectedTenant === th.tenant_id
                    ? "rgba(59,130,246,0.12)"
                    : "transparent",
                  borderLeft: selectedTenant === th.tenant_id
                    ? "3px solid #3b82f6"
                    : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb" }}>
                    {th.tenant_name || th.tenant_id}
                  </span>
                  {th.unread_count > 0 && (
                    <span style={{
                      padding: "2px 7px",
                      borderRadius: 999,
                      background: "#ef4444",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                    }}>
                      {th.unread_count}
                    </span>
                  )}
                </div>
                <span style={{
                  fontSize: 12,
                  color: "#6b7280",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  display: "block",
                  maxWidth: 230,
                }}>
                  {th.last_message}
                </span>
                <span style={{ fontSize: 11, color: "#4b5563" }}>
                  {formatTime(th.last_message_at)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 右: チャット */}
        <div style={{
          flex: 1,
          borderRadius: 14,
          border: "1px solid #1f2937",
          background: "rgba(15,23,42,0.95)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          {!selectedTenant ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280", fontSize: 15 }}>
              {t("feedback.select_tenant")}
            </div>
          ) : (
            <>
              {/* チャットヘッダー */}
              <div style={{ padding: "14px 18px", borderBottom: "1px solid #1f2937", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#f9fafb" }}>
                  🏢 {selectedThread?.tenant_name || selectedTenant}
                  <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 400, marginLeft: 8 }}>
                    ({selectedTenant})
                  </span>
                </span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {/* 改善フィルタートグル */}
                  <button
                    onClick={() => setFlaggedFilter((f) => !f)}
                    style={{
                      padding: "4px 12px",
                      borderRadius: 8,
                      border: flaggedFilter ? "1px solid #f59e0b" : "1px solid #374151",
                      background: flaggedFilter ? "rgba(245,158,11,0.15)" : "none",
                      color: flaggedFilter ? "#fbbf24" : "#9ca3af",
                      fontSize: 12,
                      fontWeight: flaggedFilter ? 700 : 400,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {lang === "ja" ? (flaggedFilter ? "★ 改善のみ" : "☆ 改善フィルター") : (flaggedFilter ? "★ Flagged only" : "☆ Filter flagged")}
                  </button>
                  <button
                    onClick={() => void fetchMessages(selectedTenant, flaggedFilter)}
                    style={{ background: "none", border: "1px solid #374151", borderRadius: 8, color: "#9ca3af", fontSize: 12, cursor: "pointer", padding: "4px 10px" }}
                  >
                    ↻
                  </button>
                </div>
              </div>

              {/* メッセージ一覧 */}
              <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                {loadingMessages ? (
                  <p style={{ textAlign: "center", color: "#6b7280", paddingTop: 40 }}>⏳</p>
                ) : messages.length === 0 ? (
                  <p style={{ textAlign: "center", color: "#6b7280", paddingTop: 40 }}>{t("feedback.no_messages")}</p>
                ) : messages.map((msg) => {
                  const isMe = msg.sender_role === "super_admin";
                  const isFlagged = msg.flagged_for_improvement;
                  return (
                    <div
                      key={msg.id}
                      style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}
                    >
                      {!isMe && (
                        <span style={{ fontSize: 11, color: "#6b7280", marginBottom: 3 }}>
                          {msg.sender_email ?? "client_admin"}
                        </span>
                      )}
                      <div style={{ display: "flex", justifyContent: isMe ? "flex-end" : "flex-start", width: "100%", alignItems: "flex-end", gap: 6 }}>
                        {/* クライアントメッセージ: 吹き出しの右にフラグボタン */}
                        {!isMe && (
                          <button
                            onClick={() => void handleFlag(msg)}
                            disabled={flagging === msg.id}
                            title={lang === "ja" ? (isFlagged ? "改善マークを解除" : "改善としてマーク") : (isFlagged ? "Remove improvement flag" : "Mark for improvement")}
                            style={{
                              background: "none",
                              border: "none",
                              cursor: flagging === msg.id ? "default" : "pointer",
                              fontSize: 16,
                              lineHeight: 1,
                              padding: "4px 2px",
                              opacity: flagging === msg.id ? 0.5 : 1,
                              color: isFlagged ? "#f59e0b" : "#4b5563",
                              flexShrink: 0,
                              transition: "color 0.15s",
                            }}
                          >
                            {isFlagged ? "★" : "☆"}
                          </button>
                        )}
                        <div style={{
                          maxWidth: "70%",
                          padding: "10px 14px",
                          borderRadius: isMe ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                          background: isFlagged
                            ? "rgba(245,158,11,0.12)"
                            : isMe ? "rgba(59,130,246,0.2)" : "rgba(55,65,81,0.5)",
                          border: isFlagged
                            ? "1px solid rgba(245,158,11,0.5)"
                            : isMe ? "1px solid rgba(59,130,246,0.4)" : "1px solid #374151",
                          color: "#f9fafb",
                          fontSize: 14,
                          lineHeight: 1.6,
                          wordBreak: "break-word",
                          textAlign: "left",
                        }}>
                          {msg.content}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, color: "#4b5563", marginTop: 2 }}>
                        {formatTime(msg.created_at)}
                        {isFlagged && (
                          <span style={{ marginLeft: 6, color: "#f59e0b", fontWeight: 600 }}>
                            {lang === "ja" ? "★ 改善" : "★ Flagged"}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* 返信入力 */}
              <div style={{ padding: "12px 16px", borderTop: "1px solid #1f2937", display: "flex", gap: 10 }}>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
                  }}
                  placeholder={t("feedback.placeholder")}
                  rows={2}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid #374151",
                    background: "rgba(0,0,0,0.3)",
                    color: "#e5e7eb",
                    fontSize: 14,
                    fontFamily: "inherit",
                    resize: "none",
                    outline: "none",
                  }}
                />
                <button
                  onClick={() => void handleSend()}
                  disabled={!input.trim() || sending}
                  style={{
                    padding: "10px 18px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "none",
                    background: input.trim() && !sending
                      ? "linear-gradient(135deg, #3b82f6, #6366f1)"
                      : "rgba(59,130,246,0.3)",
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: input.trim() && !sending ? "pointer" : "not-allowed",
                    alignSelf: "flex-end",
                  }}
                >
                  {sending ? "..." : t("feedback.send")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
