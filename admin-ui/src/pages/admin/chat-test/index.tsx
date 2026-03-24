import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";
import { API_BASE, authFetch } from "../../../lib/api";

interface AdminChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  checked: boolean;
}

interface TenantOption {
  id: string;
  name: string;
}

interface ChatTestToken {
  token: string;
  tenantId: string;
  expiresIn: number;
}

async function fetchChatTestToken(tenantId: string): Promise<ChatTestToken> {
  const res = await authFetch(
    `${API_BASE}/v1/admin/chat-test/token?tenantId=${encodeURIComponent(tenantId)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<ChatTestToken>;
}

export default function ChatTestPage() {
  const navigate = useNavigate();
  const { t } = useLang();
  const { user, isSuperAdmin, previewMode, previewTenantId, previewTenantName } = useAuth();
  const [searchParams] = useSearchParams();

  // URLクエリパラメータ（アバター一覧からの遷移）
  const queryTenantId = searchParams.get("tenantId") ?? "";
  const queryAvatarConfigId = searchParams.get("avatarConfigId") ?? "";
  const scopeGlobal = searchParams.get("scope") === "global";

  // テナント選択 (Super Admin 用)
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantFetchError, setTenantFetchError] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string>(
    isSuperAdmin && queryTenantId ? queryTenantId : ""
  );

  // トークン状態
  const [token, setToken] = useState<string | null>(null);
  const [gettingToken, setGettingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const tokenExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ウィジェット
  const widgetScriptRef = useRef<HTMLScriptElement | null>(null);

  // プレビューモード中は previewTenantId を使用（super_admin の role が client_admin に上書きされるため）
  // scope=global の場合は特殊値 'global' を使用
  const effectiveTenantId = scopeGlobal
    ? "global"
    : isSuperAdmin
      ? selectedTenantId
      : (user?.tenantId ?? (previewMode ? (previewTenantId ?? "") : ""));
  const displayTenantName = scopeGlobal
    ? "グローバルナレッジ"
    : isSuperAdmin
      ? (tenants.find((ten) => ten.id === selectedTenantId)?.name ?? selectedTenantId)
      : (previewMode ? (previewTenantName ?? effectiveTenantId) : (user?.tenantName ?? effectiveTenantId));

  // ウィジェット cleanup
  const cleanupWidget = useCallback(() => {
    const host = document.getElementById("faq-chat-widget-host");
    if (host) host.remove();
    if (widgetScriptRef.current) {
      widgetScriptRef.current.remove();
      widgetScriptRef.current = null;
    }
  }, []);

  // Super Admin: テナント一覧取得 + URLパラメータからの初期テナント選択
  useEffect(() => {
    if (!isSuperAdmin) return;
    setTenantFetchError(false);
    void authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { tenants?: TenantOption[] }) => {
        setTenants(data.tenants ?? []);
        // URLパラメータにtenantIdがある場合は自動選択
        if (queryTenantId) {
          setSelectedTenantId(queryTenantId);
        }
      })
      .catch(() => { setTenantFetchError(true); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  // テナントが確定したら自動でトークン取得
  useEffect(() => {
    if (!effectiveTenantId) return;

    // クリーンアップ
    cleanupWidget();
    setToken(null);
    setTokenError(null);
    if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);

    setGettingToken(true);
    void fetchChatTestToken(effectiveTenantId)
      .then((result) => {
        setToken(result.token);
        setGettingToken(false);
        // 期限切れタイマー（expiresIn 秒後に警告）
        tokenExpiryRef.current = setTimeout(() => {
          setToken(null);
          setTokenError(t("chat_test.token_expired"));
          cleanupWidget();
        }, result.expiresIn * 1000);
      })
      .catch((err: Error) => {
        setTokenError(err.message || t("chat_test.token_error"));
        setGettingToken(false);
      });

    return () => {
      if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTenantId]);

  // トークン取得後にウィジェット起動
  useEffect(() => {
    if (!token || !effectiveTenantId) return;

    cleanupWidget();

    const script = document.createElement("script");
    script.src = `${API_BASE}/widget.js`;
    script.setAttribute("data-tenant", effectiveTenantId);
    script.setAttribute("data-api-key", token);
    script.async = true;
    widgetScriptRef.current = script;
    document.body.appendChild(script);

    return cleanupWidget;
  }, [token, effectiveTenantId, cleanupWidget]);

  // アンマウント時クリーンアップ
  useEffect(() => {
    return () => {
      cleanupWidget();
      if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    };
  }, [cleanupWidget]);

  // ── Admin Chat (direct API call with checkboxes) ──────────────────────────
  const [adminChatOpen, setAdminChatOpen] = useState(false);
  const [adminMessages, setAdminMessages] = useState<AdminChatMessage[]>([]);
  const [adminInput, setAdminInput] = useState("");
  const [adminSending, setAdminSending] = useState(false);
  const [adminSessionId] = useState(() => `admin-chat-${Date.now()}`);

  // チューニングルール作成モーダル
  const [tuningModalOpen, setTuningModalOpen] = useState(false);
  const [tuningPattern, setTuningPattern] = useState("");
  const [tuningBehavior, setTuningBehavior] = useState("");
  const [tuningSaving, setTuningSaving] = useState(false);
  const [tuningSuccess, setTuningSuccess] = useState<string | null>(null);
  const [tuningError, setTuningError] = useState<string | null>(null);

  const checkedMessages = adminMessages.filter((m) => m.checked);

  const handleAdminSend = async () => {
    if (!adminInput.trim() || adminSending || !token) return;
    const userMsg: AdminChatMessage = { id: Date.now().toString(), role: "user", content: adminInput.trim(), checked: false };
    setAdminMessages((prev) => [...prev, userMsg]);
    setAdminInput("");
    setAdminSending(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": token },
        body: JSON.stringify({ message: userMsg.content, sessionId: adminSessionId }),
      });
      if (res.ok) {
        const data = await res.json() as { reply?: string; message?: string };
        const reply = data.reply ?? data.message ?? "";
        if (reply) {
          setAdminMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: "assistant", content: reply, checked: false }]);
        }
      }
    } catch { /* ignore */ } finally {
      setAdminSending(false);
    }
  };

  const toggleCheck = (id: string) => {
    setAdminMessages((prev) => prev.map((m) => m.id === id ? { ...m, checked: !m.checked } : m));
  };

  const openTuningModal = () => {
    const selectedText = checkedMessages.map((m) => `[${m.role === "user" ? "ユーザー" : "AI"}] ${m.content}`).join("\n");
    setTuningPattern(checkedMessages.find((m) => m.role === "user")?.content ?? "");
    setTuningBehavior(`以下の会話を参考に、適切な応答をしてください:\n\n${selectedText}`);
    setTuningSuccess(null);
    setTuningError(null);
    setTuningModalOpen(true);
  };

  const handleTuningSave = async () => {
    if (!tuningPattern.trim() || !tuningBehavior.trim() || tuningSaving) return;
    setTuningSaving(true);
    setTuningError(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: effectiveTenantId, trigger_pattern: tuningPattern, expected_behavior: tuningBehavior }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setTuningError(d.error ?? "保存に失敗しました");
        return;
      }
      setTuningSuccess("✅ チューニングルールを追加しました");
      setAdminMessages((prev) => prev.map((m) => ({ ...m, checked: false })));
      setTimeout(() => { setTuningModalOpen(false); setTuningSuccess(null); }, 1500);
    } catch {
      setTuningError("ネットワークエラーが発生しました");
    } finally {
      setTuningSaving(false);
    }
  };

  const handleTenantChange = (newTenantId: string) => {
    setSelectedTenantId(newTenantId);
    setAdminMessages([]);
  };

  const handleReload = () => {
    if (!effectiveTenantId) return;
    setToken(null);
    setTokenError(null);
    if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    cleanupWidget();

    setGettingToken(true);
    void fetchChatTestToken(effectiveTenantId)
      .then((result) => {
        setToken(result.token);
        setGettingToken(false);
        tokenExpiryRef.current = setTimeout(() => {
          setToken(null);
          setTokenError(t("chat_test.token_expired"));
          cleanupWidget();
        }, result.expiresIn * 1000);
      })
      .catch((err: Error) => {
        setTokenError(err.message || t("chat_test.token_error"));
        setGettingToken(false);
      });
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
        <button
          onClick={() => navigate("/admin")}
          style={{
            padding: "10px 16px",
            minHeight: 44,
            borderRadius: 999,
            border: "1px solid #374151",
            background: "transparent",
            color: "#9ca3af",
            fontSize: 14,
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {t("common.back_to_dashboard")}
        </button>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            {t("chat_test.title")}
          </h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>
            {t("chat_test.description")}
          </p>
        </div>
      </header>

      <section
        style={{
          borderRadius: 16,
          border: "1px solid #1f2937",
          background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          padding: "32px 24px",
        }}
      >
        {/* ─── グローバルナレッジモードバナー ─── */}
        {scopeGlobal && (
          <div style={{
            marginBottom: 24,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(34,197,94,0.15)",
            border: "1px solid rgba(34,197,94,0.4)",
            color: "#4ade80",
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span>🌐</span>
            <span>グローバルナレッジでテスト中</span>
          </div>
        )}

        {/* ─── Super Admin: テナント選択ドロップダウン ─── */}
        {isSuperAdmin && !scopeGlobal && (
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 8 }}>
              {t("chat_test.select_tenant")}
            </label>
            {tenantFetchError ? (
              <div style={{ color: "#fca5a5", fontSize: 14, padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(248,113,113,0.3)", background: "rgba(127,29,29,0.3)" }}>
                ⚠️ テナント一覧の取得に失敗しました。ページを再読み込みしてください。
              </div>
            ) : (
              <select
                value={selectedTenantId}
                onChange={(e) => handleTenantChange(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "rgba(15,23,42,0.9)",
                  color: "#e5e7eb",
                  fontSize: 15,
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="">— テナントを選択 —</option>
                {tenants.map((ten) => (
                  <option key={ten.id} value={ten.id}>
                    {ten.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* ─── テナント未選択 ─── */}
        {!effectiveTenantId && !scopeGlobal && (
          <p style={{ textAlign: "center", color: "#6b7280", fontSize: 15, padding: "32px 0" }}>
            {t("chat_test.select_tenant")}
          </p>
        )}

        {/* ─── テナント選択済み ─── */}
        {effectiveTenantId && (
          <>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: queryAvatarConfigId ? 8 : 20 }}>
              {t("chat_test.tenant_label")}:{" "}
              <strong style={{ color: "#9ca3af" }}>{displayTenantName}</strong>
            </p>
            {/* アバター設定ID表示（アバター一覧からの遷移時） */}
            {queryAvatarConfigId && (
              <div style={{
                marginBottom: 20,
                padding: "10px 14px",
                borderRadius: 8,
                background: "rgba(59,130,246,0.1)",
                border: "1px solid rgba(59,130,246,0.3)",
                fontSize: 13,
                color: "#93c5fd",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}>
                <span>🎭</span>
                <span>
                  {t ? "アバター設定をテスト中: " : "Testing avatar config: "}
                  <code style={{ fontFamily: "monospace", fontSize: 11, opacity: 0.8 }}>{queryAvatarConfigId}</code>
                </span>
              </div>
            )}

            {/* トークン取得中 */}
            {gettingToken && (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#6b7280", fontSize: 15 }}>
                <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
                {t("chat_test.getting_token")}
              </div>
            )}

            {/* エラー（期限切れ含む） */}
            {tokenError && (
              <div
                style={{
                  marginBottom: 20,
                  padding: "16px 20px",
                  borderRadius: 12,
                  background: "rgba(127,29,29,0.4)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  color: "#fca5a5",
                  fontSize: 14,
                }}
              >
                <div style={{ marginBottom: 12 }}>⚠️ {tokenError}</div>
                <button
                  onClick={handleReload}
                  style={{
                    padding: "10px 18px",
                    minHeight: 44,
                    borderRadius: 8,
                    border: "1px solid rgba(248,113,113,0.4)",
                    background: "rgba(248,113,113,0.1)",
                    color: "#fca5a5",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  🔄 {t("common.retry")}
                </button>
              </div>
            )}

            {/* ウィジェット起動済み */}
            {token && !gettingToken && (
              <>
                <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 15, marginBottom: 16 }}>
                  👇 右下のボタンからチャットを開けます
                </p>
                <div style={{ textAlign: "center" }}>
                  <button
                    onClick={handleReload}
                    style={{
                      padding: "12px 24px",
                      minHeight: 44,
                      borderRadius: 10,
                      border: "1px solid #374151",
                      background: "transparent",
                      color: "#9ca3af",
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    {t("chat_test.reset")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* ── Admin Chat Panel (チェックボックス付き) ── */}
      {token && effectiveTenantId && (
        <section style={{ marginTop: 24, borderRadius: 16, border: "1px solid #1f2937", background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))", padding: "20px 24px" }}>
          <button
            onClick={() => setAdminChatOpen((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: "#9ca3af", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            💬 管理者チャット（メッセージ選択→チューニング追加）
            <span style={{ fontSize: 12, color: "#6b7280" }}>{adminChatOpen ? "▲ 閉じる" : "▼ 開く"}</span>
          </button>

          {adminChatOpen && (
            <div style={{ marginTop: 16 }}>
              {/* メッセージ一覧 */}
              <div style={{ minHeight: 100, maxHeight: 360, overflowY: "auto", marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {adminMessages.length === 0 && (
                  <p style={{ color: "#6b7280", fontSize: 14, textAlign: "center", padding: "24px 0" }}>メッセージを送信して会話を始めてください</p>
                )}
                {adminMessages.map((msg) => (
                  <label
                    key={msg.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: msg.checked ? "1px solid rgba(59,130,246,0.5)" : "1px solid #1f2937",
                      background: msg.checked ? "rgba(59,130,246,0.08)" : (msg.role === "user" ? "rgba(37,99,235,0.1)" : "rgba(30,41,59,0.6)"),
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={msg.checked}
                      onChange={() => toggleCheck(msg.id)}
                      style={{ width: 20, height: 20, minWidth: 20, minHeight: 20, marginTop: 2, cursor: "pointer", accentColor: "#3b82f6" }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{msg.role === "user" ? "あなた" : "AI"}</div>
                      <div style={{ fontSize: 14, color: "#e5e7eb", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
                    </div>
                  </label>
                ))}
                {adminSending && (
                  <div style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #1f2937", background: "rgba(30,41,59,0.6)", color: "#6b7280", fontSize: 14 }}>AI応答中...</div>
                )}
              </div>

              {/* 入力欄 */}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={adminInput}
                  onChange={(e) => setAdminInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleAdminSend(); } }}
                  placeholder="メッセージを入力..."
                  disabled={adminSending}
                  style={{ flex: 1, padding: "10px 14px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.9)", color: "#e5e7eb", fontSize: 14, outline: "none" }}
                />
                <button
                  onClick={() => void handleAdminSend()}
                  disabled={adminSending || !adminInput.trim()}
                  style={{ padding: "10px 20px", minHeight: 44, borderRadius: 10, border: "none", background: "linear-gradient(135deg, #3b82f6, #6366f1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: adminSending || !adminInput.trim() ? "not-allowed" : "pointer", opacity: adminSending || !adminInput.trim() ? 0.5 : 1 }}
                >
                  送信
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── フローティングバー（チェック時） ── */}
      {checkedMessages.length > 0 && (
        <div style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 20px",
          borderRadius: 999,
          background: "rgba(15,23,42,0.95)",
          border: "1px solid rgba(59,130,246,0.5)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          zIndex: 1000,
          minHeight: 56,
        }}>
          <span style={{ color: "#93c5fd", fontSize: 14, fontWeight: 600 }}>{checkedMessages.length}件選択中</span>
          <button
            onClick={openTuningModal}
            style={{ padding: "8px 20px", minHeight: 44, borderRadius: 999, border: "none", background: "linear-gradient(135deg, #3b82f6, #6366f1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            チューニングに追加
          </button>
          <button
            onClick={() => setAdminMessages((prev) => prev.map((m) => ({ ...m, checked: false })))}
            style={{ padding: "8px 14px", minHeight: 44, borderRadius: 999, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
          >
            解除
          </button>
        </div>
      )}

      {/* ── チューニングルール作成モーダル ── */}
      {tuningModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "100%", maxWidth: 560, borderRadius: 16, background: "#0f172a", border: "1px solid #1f2937", padding: "24px 24px", maxHeight: "80vh", overflowY: "auto" }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: "0 0 16px" }}>チューニングルールを追加</h2>

            {/* 参考メッセージ */}
            <div style={{ marginBottom: 16, padding: "12px 14px", borderRadius: 10, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", fontSize: 13, color: "#93c5fd" }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>参考メッセージ ({checkedMessages.length}件):</div>
              {checkedMessages.map((m) => (
                <div key={m.id} style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>
                  <span style={{ color: "#9ca3af" }}>[{m.role === "user" ? "ユーザー" : "AI"}]</span> {m.content.slice(0, 80)}{m.content.length > 80 ? "…" : ""}
                </div>
              ))}
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>トリガーパターン（どんな質問に適用するか）</label>
              <input
                type="text"
                value={tuningPattern}
                onChange={(e) => setTuningPattern(e.target.value)}
                style={{ width: "100%", padding: "10px 12px", minHeight: 44, borderRadius: 8, border: "1px solid #374151", background: "rgba(30,41,59,0.8)", color: "#f9fafb", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>期待される動作（AIへの指示）</label>
              <textarea
                value={tuningBehavior}
                onChange={(e) => setTuningBehavior(e.target.value)}
                rows={5}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #374151", background: "rgba(30,41,59,0.8)", color: "#f9fafb", fontSize: 14, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }}
              />
            </div>

            {tuningSuccess && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(34,197,94,0.1)", color: "#4ade80", fontSize: 14 }}>{tuningSuccess}</div>}
            {tuningError && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "#fca5a5", fontSize: 14 }}>{tuningError}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setTuningModalOpen(false)}
                style={{ padding: "10px 20px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 14, cursor: "pointer" }}
              >
                キャンセル
              </button>
              <button
                onClick={() => void handleTuningSave()}
                disabled={tuningSaving || !tuningPattern.trim() || !tuningBehavior.trim()}
                style={{ padding: "10px 24px", minHeight: 44, borderRadius: 10, border: "none", background: "linear-gradient(135deg, #3b82f6, #6366f1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: tuningSaving ? "not-allowed" : "pointer", opacity: tuningSaving ? 0.6 : 1 }}
              >
                {tuningSaving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
