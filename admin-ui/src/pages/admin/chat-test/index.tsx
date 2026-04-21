import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import { useAuth } from "../../../auth/useAuth";
import { API_BASE, authFetch } from "../../../lib/api";

interface AdminChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  checked: boolean; // user メッセージのみ有効
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

interface AvatarConfigOption {
  id: string;
  name: string;
  image_url: string | null;
  is_default: boolean;
  tenant_id: string;
}

interface QAPair {
  question: AdminChatMessage;
  answer: AdminChatMessage | null;
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

  // アバター選択
  const [availableAvatars, setAvailableAvatars] = useState<AvatarConfigOption[]>([]);
  const [selectedAvatarConfigId, setSelectedAvatarConfigId] = useState<string | null>(null);
  // avatar config fetch が完了するまで widget 注入を待機するフラグ
  const [avatarConfigsReady, setAvatarConfigsReady] = useState(false);

  // トークン状態
  const [token, setToken] = useState<string | null>(null);
  const [gettingToken, setGettingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const tokenExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ウィジェット
  const widgetScriptRef = useRef<HTMLScriptElement | null>(null);

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

  const cleanupWidget = useCallback(() => {
    // querySelectorAll で同一IDの重複ホストを全て削除（getElementById は先頭1件のみ）
    document.querySelectorAll("#faq-chat-widget-host").forEach((host) => host.remove());
    if (widgetScriptRef.current) {
      widgetScriptRef.current.remove();
      widgetScriptRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    setTenantFetchError(false);
    void authFetch(`${API_BASE}/v1/admin/tenants`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { tenants?: TenantOption[] }) => {
        setTenants(data.tenants ?? []);
        if (queryTenantId) setSelectedTenantId(queryTenantId);
      })
      .catch(() => { setTenantFetchError(true); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  useEffect(() => {
    setAvatarConfigsReady(false);
    if (!effectiveTenantId || scopeGlobal) {
      setAvailableAvatars([]);
      setSelectedAvatarConfigId(null);
      setAvatarConfigsReady(true);
      return;
    }
    const url = isSuperAdmin
      ? `${API_BASE}/v1/admin/avatar/configs?tenant=${encodeURIComponent(effectiveTenantId)}`
      : `${API_BASE}/v1/admin/avatar/configs`;
    void authFetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { configs?: AvatarConfigOption[] }) => {
        const configs = data.configs ?? [];
        setAvailableAvatars(configs);
        const urlMatch = configs.find((c) => c.id === queryAvatarConfigId);
        if (urlMatch) {
          setSelectedAvatarConfigId(urlMatch.id);
        } else {
          const firstCustom = configs.find((c) => !c.is_default);
          setSelectedAvatarConfigId(firstCustom?.id ?? configs[0]?.id ?? null);
        }
        setAvatarConfigsReady(true);
      })
      .catch(() => {
        setAvailableAvatars([]);
        setAvatarConfigsReady(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTenantId, scopeGlobal, queryAvatarConfigId]);

  useEffect(() => {
    if (!effectiveTenantId) return;
    cleanupWidget();
    setToken(null);
    setTokenError(null);
    if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);

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

    return () => {
      if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTenantId]);

  useEffect(() => {
    // avatar config fetch 完了まで待機（null→UUID 変化による二重注入を防止）
    if (!token || !effectiveTenantId || !avatarConfigsReady) return;
    cleanupWidget();
    const script = document.createElement("script");
    script.src = `${API_BASE}/widget.js`;
    script.setAttribute("data-tenant", effectiveTenantId);
    script.setAttribute("data-api-key", token);
    if (selectedAvatarConfigId) {
      script.setAttribute("data-avatar-config-id", selectedAvatarConfigId);
    }
    script.async = true;
    widgetScriptRef.current = script;
    document.body.appendChild(script);
    return cleanupWidget;
  }, [token, effectiveTenantId, cleanupWidget, selectedAvatarConfigId, avatarConfigsReady]);

  useEffect(() => {
    return () => {
      cleanupWidget();
      if (tokenExpiryRef.current) clearTimeout(tokenExpiryRef.current);
    };
  }, [cleanupWidget]);

  // ── Admin Chat ──────────────────────────────────────────────────────────
  const [adminChatOpen, setAdminChatOpen] = useState(false);
  const [adminMessages, setAdminMessages] = useState<AdminChatMessage[]>([]);
  const [adminInput, setAdminInput] = useState("");
  const [adminSending, setAdminSending] = useState(false);
  const [adminIsComposing, setAdminIsComposing] = useState(false);
  const [adminSessionId] = useState(() => `admin-chat-${Date.now()}`);

  // ── チューニングモーダル状態 ────────────────────────────────────────────
  const [tuningModalOpen, setTuningModalOpen] = useState(false);
  const [saveMode, setSaveMode] = useState<"combined" | "individual">("combined");
  const [combinedRuleName, setCombinedRuleName] = useState("");
  const [combinedBehavior, setCombinedBehavior] = useState("");
  const [pairRules, setPairRules] = useState<{ ruleName: string; behavior: string }[]>([]);
  const [tuningSaving, setTuningSaving] = useState(false);
  const [tuningSuccess, setTuningSuccess] = useState<string | null>(null);
  const [tuningError, setTuningError] = useState<string | null>(null);

  // ── 選択済みQ&Aペア（ユーザーメッセージ.checked=true のものとその直後のAI返答） ──
  const checkedPairs = useMemo<QAPair[]>(() => {
    const pairs: QAPair[] = [];
    for (let i = 0; i < adminMessages.length; i++) {
      const msg = adminMessages[i];
      if (msg.role === "user" && msg.checked) {
        const next = adminMessages[i + 1];
        pairs.push({ question: msg, answer: next?.role === "assistant" ? next : null });
      }
    }
    return pairs;
  }, [adminMessages]);

  // アシスタントメッセージが自動連動ハイライト対象かどうか
  const isAutoIncluded = useCallback((idx: number) => {
    if (idx === 0) return false;
    const prev = adminMessages[idx - 1];
    return prev?.role === "user" && prev.checked;
  }, [adminMessages]);

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
        const data = await res.json() as { data?: { content?: string }; reply?: string; message?: string };
        const reply = data.data?.content ?? data.reply ?? data.message ?? "";
        if (reply) {
          setAdminMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), role: "assistant", content: reply, checked: false }]);
        }
      }
    } catch { /* ignore */ } finally {
      setAdminSending(false);
    }
  };

  // ユーザーメッセージのチェックをトグル（AI返答は自動連動）
  const toggleCheck = (id: string) => {
    setAdminMessages((prev) => prev.map((m) => m.id === id && m.role === "user" ? { ...m, checked: !m.checked } : m));
  };

  const openTuningModal = () => {
    const pairs = checkedPairs;
    if (pairs.length === 0) return;
    const firstQ = pairs[0].question.content;
    setCombinedRuleName(firstQ.slice(0, 20) + "への対応");
    setCombinedBehavior("");
    setPairRules(pairs.map((p) => ({
      ruleName: p.question.content.slice(0, 20) + "への対応",
      behavior: "",
    })));
    setSaveMode("combined");
    setTuningSuccess(null);
    setTuningError(null);
    setTuningModalOpen(true);
  };

  const handleTuningSave = async () => {
    if (tuningSaving) return;
    setTuningSaving(true);
    setTuningError(null);
    try {
      if (saveMode === "combined") {
        if (!combinedRuleName.trim() || !combinedBehavior.trim()) {
          setTuningError("ルール名と内容を入力してください");
          return;
        }
        const context = checkedPairs.map((p) =>
          `Q: ${p.question.content}\nA: ${p.answer?.content ?? "(返答なし)"}`
        ).join("\n\n");
        const behavior = `${combinedBehavior.trim()}\n\n【参考会話】\n${context}`;
        const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: effectiveTenantId, trigger_pattern: combinedRuleName.trim(), expected_behavior: behavior }),
        });
        if (!res.ok) {
          const d = await res.json() as { error?: string };
          setTuningError(d.error ?? "保存に失敗しました");
          return;
        }
      } else {
        // 個別保存
        const errors: string[] = [];
        for (let i = 0; i < checkedPairs.length; i++) {
          const pair = checkedPairs[i];
          const rule = pairRules[i];
          if (!rule?.ruleName.trim() || !rule?.behavior.trim()) {
            errors.push(`ペア${i + 1}: ルール名と内容を入力してください`);
            continue;
          }
          const context = `Q: ${pair.question.content}\nA: ${pair.answer?.content ?? "(返答なし)"}`;
          const behavior = `${rule.behavior.trim()}\n\n【参考会話】\n${context}`;
          const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tenant_id: effectiveTenantId, trigger_pattern: rule.ruleName.trim(), expected_behavior: behavior }),
          });
          if (!res.ok) {
            const d = await res.json() as { error?: string };
            errors.push(`ペア${i + 1}: ${d.error ?? "保存に失敗"}`);
          }
        }
        if (errors.length > 0) {
          setTuningError(errors.join(" / "));
          return;
        }
      }

      setTuningSuccess("✅ AIの回答ルールを保存しました");
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
    setSelectedAvatarConfigId(null);
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
    <div style={{ minHeight: "100vh", background: "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)", color: "#e5e7eb", padding: "24px 20px", maxWidth: 900, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
        <button
          onClick={() => navigate("/admin")}
          style={{ padding: "10px 16px", minHeight: 44, borderRadius: 999, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 14, cursor: "pointer", fontWeight: 500 }}
        >
          {t("common.back_to_dashboard")}
        </button>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#f9fafb" }}>{t("chat_test.title")}</h1>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4, marginBottom: 0 }}>{t("chat_test.description")}</p>
        </div>
      </header>

      <section style={{ borderRadius: 16, border: "1px solid #1f2937", background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))", padding: "32px 24px" }}>
        {/* グローバルナレッジバナー */}
        {scopeGlobal && (
          <div style={{ marginBottom: 24, padding: "14px 18px", borderRadius: 12, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.4)", color: "#4ade80", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <span>🌐</span><span>グローバルナレッジでテスト中</span>
          </div>
        )}

        {/* Super Admin: テナント選択 */}
        {isSuperAdmin && !scopeGlobal && (
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 8 }}>{t("chat_test.select_tenant")}</label>
            {tenantFetchError ? (
              <div style={{ color: "#fca5a5", fontSize: 14, padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(248,113,113,0.3)", background: "rgba(127,29,29,0.3)" }}>
                ⚠️ テナント一覧の取得に失敗しました。ページを再読み込みしてください。
              </div>
            ) : (
              <select
                value={selectedTenantId}
                onChange={(e) => handleTenantChange(e.target.value)}
                style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.9)", color: "#e5e7eb", fontSize: 15, outline: "none", cursor: "pointer" }}
              >
                <option value="">— テナントを選択 —</option>
                {tenants.map((ten) => <option key={ten.id} value={ten.id}>{ten.name}</option>)}
              </select>
            )}
          </div>
        )}

        {/* アバター選択ドロップダウン */}
        {effectiveTenantId && !scopeGlobal && (
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 8 }}>
              🎭 テストするアバター
            </label>
            {availableAvatars.length === 0 ? (
              <p style={{ fontSize: 14, color: "#6b7280", padding: "8px 0", margin: 0 }}>
                このテナントにはアバターがありません。テキストチャットでテスト可能です。
              </p>
            ) : (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={selectedAvatarConfigId ?? ""}
                  onChange={(e) => setSelectedAvatarConfigId(e.target.value || null)}
                  style={{ flex: 1, minWidth: 200, padding: "12px 14px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "rgba(15,23,42,0.9)", color: "#e5e7eb", fontSize: 15, outline: "none", cursor: "pointer" }}
                >
                  <option value="">— アバターなし（テキストのみ）—</option>
                  {availableAvatars.map((av) => (
                    <option key={av.id} value={av.id}>
                      {av.name}{av.is_default ? " (R2Cデフォルト)" : " (カスタム)"}
                    </option>
                  ))}
                </select>
                {selectedAvatarConfigId && (() => {
                  const av = availableAvatars.find((a) => a.id === selectedAvatarConfigId);
                  if (!av) return null;
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.08)", flexShrink: 0 }}>
                      {av.image_url && (
                        <img src={av.image_url} alt="" width={40} height={40} style={{ borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                      )}
                      <span style={{ fontSize: 14, color: "#93c5fd", fontWeight: 600 }}>{av.name}</span>
                    </div>
                  );
                })()}
                {!selectedAvatarConfigId && (
                  <span style={{ fontSize: 13, color: "#6b7280" }}>テキストチャットのみ</span>
                )}
              </div>
            )}
          </div>
        )}

        {!effectiveTenantId && !scopeGlobal && (
          <p style={{ textAlign: "center", color: "#6b7280", fontSize: 15, padding: "32px 0" }}>{t("chat_test.select_tenant")}</p>
        )}

        {effectiveTenantId && (
          <>
            <p style={{ fontSize: 14, color: "#6b7280", marginBottom: 20 }}>
              {t("chat_test.tenant_label")}: <strong style={{ color: "#9ca3af" }}>{displayTenantName}</strong>
            </p>

            {gettingToken && (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#6b7280", fontSize: 15 }}>
                <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
                {t("chat_test.getting_token")}
              </div>
            )}

            {tokenError && (
              <div style={{ marginBottom: 20, padding: "16px 20px", borderRadius: 12, background: "rgba(127,29,29,0.4)", border: "1px solid rgba(248,113,113,0.3)", color: "#fca5a5", fontSize: 14 }}>
                <div style={{ marginBottom: 12 }}>⚠️ {tokenError}</div>
                <button onClick={handleReload} style={{ padding: "10px 18px", minHeight: 44, borderRadius: 8, border: "1px solid rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.1)", color: "#fca5a5", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  🔄 {t("common.retry")}
                </button>
              </div>
            )}

            {token && !gettingToken && (
              <>
                <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 15, marginBottom: 16 }}>👇 右下のボタンからチャットを開けます</p>
                <div style={{ textAlign: "center" }}>
                  <button onClick={handleReload} style={{ padding: "12px 24px", minHeight: 44, borderRadius: 10, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 14, cursor: "pointer" }}>
                    {t("chat_test.reset")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* ── Admin Chat Panel ── */}
      {token && effectiveTenantId && (
        <section style={{ marginTop: 24, borderRadius: 16, border: "1px solid #1f2937", background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))", padding: "20px 24px" }}>
          <button
            onClick={() => setAdminChatOpen((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: "#9ca3af", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            💬 管理者チャット（会話を選択→AIの回答を改善）
            <span style={{ fontSize: 12, color: "#6b7280" }}>{adminChatOpen ? "▲ 閉じる" : "▼ 開く"}</span>
          </button>

          {adminChatOpen && (
            <div style={{ marginTop: 16 }}>
              {/* 使い方ヒント */}
              <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 10, margin: "0 0 10px" }}>
                💡 質問の左にあるチェックボックスを選ぶと、その質問とAIの返答がセットで選択されます
              </p>

              {/* メッセージ一覧 */}
              <div style={{ minHeight: 100, maxHeight: 360, overflowY: "auto", marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {adminMessages.length === 0 && (
                  <p style={{ color: "#6b7280", fontSize: 14, textAlign: "center", padding: "24px 0" }}>メッセージを送信して会話を始めてください</p>
                )}
                {adminMessages.map((msg, idx) => {
                  const autoHighlight = msg.role === "assistant" && isAutoIncluded(idx);
                  const isChecked = msg.role === "user" && msg.checked;
                  const highlighted = isChecked || autoHighlight;
                  return (
                    <div
                      key={msg.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: 10,
                        border: highlighted ? "1px solid rgba(59,130,246,0.5)" : "1px solid #1f2937",
                        background: highlighted
                          ? "rgba(59,130,246,0.08)"
                          : (msg.role === "user" ? "rgba(37,99,235,0.1)" : "rgba(30,41,59,0.6)"),
                        cursor: msg.role === "user" ? "pointer" : "default",
                      }}
                      onClick={() => { if (msg.role === "user") toggleCheck(msg.id); }}
                    >
                      {/* チェックボックス: ユーザーメッセージのみ */}
                      {msg.role === "user" ? (
                        <input
                          type="checkbox"
                          checked={msg.checked}
                          onChange={() => toggleCheck(msg.id)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ width: 20, height: 20, minWidth: 20, minHeight: 20, marginTop: 2, cursor: "pointer", accentColor: "#3b82f6", flexShrink: 0 }}
                        />
                      ) : (
                        /* AI返答: チェックボックスなし、連動インジケーター */
                        <div style={{ width: 20, minWidth: 20, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 4, flexShrink: 0 }}>
                          {autoHighlight && (
                            <span style={{ fontSize: 10, color: "#3b82f6", fontWeight: 700 }} title="選択した質問とセット">↳</span>
                          )}
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{msg.role === "user" ? "あなた" : "AI"}</div>
                        <div style={{ fontSize: 14, color: "#e5e7eb", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
                      </div>
                    </div>
                  );
                })}
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
                  onCompositionStart={() => setAdminIsComposing(true)}
                  onCompositionEnd={() => setAdminIsComposing(false)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !adminIsComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void handleAdminSend(); } }}
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

      {/* ── フローティングバー（Q&Aペア選択時） ── */}
      {checkedPairs.length > 0 && (
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
          <span style={{ color: "#93c5fd", fontSize: 14, fontWeight: 600 }}>
            {checkedPairs.length}組の会話を選択中
          </span>
          <button
            onClick={openTuningModal}
            style={{ padding: "8px 20px", minHeight: 44, borderRadius: 999, border: "none", background: "linear-gradient(135deg, #3b82f6, #6366f1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            AIの回答を改善
          </button>
          <button
            onClick={() => setAdminMessages((prev) => prev.map((m) => ({ ...m, checked: false })))}
            style={{ padding: "8px 14px", minHeight: 44, borderRadius: 999, border: "1px solid #374151", background: "transparent", color: "#9ca3af", fontSize: 13, cursor: "pointer" }}
          >
            解除
          </button>
        </div>
      )}

      {/* ── AIの回答改善モーダル ── */}
      {tuningModalOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "100%", maxWidth: 580, borderRadius: 16, background: "#0f172a", border: "1px solid #1f2937", padding: "24px", maxHeight: "85vh", overflowY: "auto" }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#f9fafb", margin: "0 0 4px" }}>AIの回答を改善</h2>
            <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 16px" }}>選択した会話をもとに、AIの応答ルールを登録します</p>

            {/* 選択ペアのプレビュー */}
            <div style={{ marginBottom: 16, padding: "12px 14px", borderRadius: 10, background: "rgba(59,130,246,0.07)", border: "1px solid rgba(59,130,246,0.2)", fontSize: 13 }}>
              <div style={{ fontWeight: 600, color: "#93c5fd", marginBottom: 8 }}>
                選択した会話 ({checkedPairs.length}組):
              </div>
              {checkedPairs.map((pair, i) => (
                <div key={pair.question.id} style={{ marginBottom: i < checkedPairs.length - 1 ? 10 : 0 }}>
                  <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 2 }}>
                    <span style={{ background: "rgba(59,130,246,0.2)", borderRadius: 4, padding: "1px 6px", marginRight: 6 }}>Q</span>
                    {pair.question.content.slice(0, 80)}{pair.question.content.length > 80 ? "…" : ""}
                  </div>
                  {pair.answer && (
                    <div style={{ color: "#6b7280", fontSize: 12, paddingLeft: 8 }}>
                      <span style={{ background: "rgba(34,197,94,0.15)", borderRadius: 4, padding: "1px 6px", marginRight: 6, color: "#4ade80" }}>A</span>
                      {pair.answer.content.slice(0, 80)}{pair.answer.content.length > 80 ? "…" : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 複数ペア時: 保存モード切り替え */}
            {checkedPairs.length > 1 && (
              <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
                {(["combined", "individual"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setSaveMode(mode)}
                    style={{
                      padding: "8px 16px",
                      minHeight: 44,
                      borderRadius: 8,
                      border: saveMode === mode ? "1px solid rgba(99,102,241,0.6)" : "1px solid #374151",
                      background: saveMode === mode ? "rgba(99,102,241,0.15)" : "transparent",
                      color: saveMode === mode ? "#a5b4fc" : "#9ca3af",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {mode === "combined" ? "1つのルールにまとめる" : "ペアごとに個別保存"}
                  </button>
                ))}
              </div>
            )}

            {/* 保存フォーム: まとめて */}
            {saveMode === "combined" && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>ルール名</label>
                  <input
                    type="text"
                    value={combinedRuleName}
                    onChange={(e) => setCombinedRuleName(e.target.value)}
                    style={{ width: "100%", padding: "10px 12px", minHeight: 44, borderRadius: 8, border: "1px solid #374151", background: "rgba(30,41,59,0.8)", color: "#f9fafb", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                  />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#9ca3af", marginBottom: 6 }}>AIへの改善指示</label>
                  <textarea
                    value={combinedBehavior}
                    onChange={(e) => setCombinedBehavior(e.target.value)}
                    rows={4}
                    placeholder="この質問にAIがどう答えるべきか書いてください"
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #374151", background: "rgba(30,41,59,0.8)", color: "#f9fafb", fontSize: 14, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }}
                  />
                </div>
              </>
            )}

            {/* 保存フォーム: 個別 */}
            {saveMode === "individual" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
                {checkedPairs.map((pair, i) => (
                  <div key={pair.question.id} style={{ padding: "14px", borderRadius: 10, border: "1px solid #1f2937", background: "rgba(30,41,59,0.4)" }}>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
                      ペア {i + 1}: {pair.question.content.slice(0, 40)}{pair.question.content.length > 40 ? "…" : ""}
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>ルール名</label>
                      <input
                        type="text"
                        value={pairRules[i]?.ruleName ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPairRules((prev) => prev.map((r, ri) => ri === i ? { ...r, ruleName: v } : r));
                        }}
                        style={{ width: "100%", padding: "8px 10px", minHeight: 40, borderRadius: 8, border: "1px solid #374151", background: "rgba(15,23,42,0.9)", color: "#f9fafb", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>AIへの改善指示</label>
                      <textarea
                        value={pairRules[i]?.behavior ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPairRules((prev) => prev.map((r, ri) => ri === i ? { ...r, behavior: v } : r));
                        }}
                        rows={3}
                        placeholder="この質問にAIがどう答えるべきか書いてください"
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #374151", background: "rgba(15,23,42,0.9)", color: "#f9fafb", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

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
                disabled={tuningSaving}
                style={{ padding: "10px 24px", minHeight: 44, borderRadius: 10, border: "none", background: "linear-gradient(135deg, #3b82f6, #6366f1)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: tuningSaving ? "not-allowed" : "pointer", opacity: tuningSaving ? 0.6 : 1 }}
              >
                {tuningSaving ? "保存中..." : "保存する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
