import { useState, useEffect } from "react";
import { useLang } from "../../i18n/LangContext";
import { authFetch, API_BASE } from "../../lib/api";

export interface TuningRule {
  id: number;
  tenant_id: string;
  trigger_pattern: string;
  expected_behavior: string;
  priority: number;
  is_active: boolean;
  created_by: string;
  created_at: string;
}

export type TuningRuleInput = Omit<TuningRule, "id" | "created_by" | "created_at">;

export interface SourceConversation {
  userMsg: string;
  assistantMsg: string;
}

interface Props {
  mode: "create" | "edit";
  initialData?: TuningRule;
  sourceConversation?: SourceConversation;
  tenantId: string; // caller's tenant; "global" if super_admin
  isSuperAdmin: boolean;
  tenantOptions: { value: string; label: string }[];
  onClose: () => void;
  onSuccess: (message: string, rule: TuningRuleInput & { id?: number }) => void;
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 10,
  border: "1px solid #374151",
  background: "rgba(15,23,42,0.8)",
  color: "#e5e7eb",
  fontSize: 16,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  resize: "vertical",
  lineHeight: 1.6,
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 15,
  fontWeight: 600,
  color: "#d1d5db",
  marginBottom: 8,
};

const HINT_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "#6b7280",
  margin: "0 0 8px",
  lineHeight: 1.5,
};

export default function TuningRuleModal({
  mode,
  initialData,
  sourceConversation,
  tenantId,
  isSuperAdmin,
  tenantOptions,
  onClose,
  onSuccess,
}: Props) {
  const { t } = useLang();

  const [triggerPattern, setTriggerPattern] = useState(
    initialData?.trigger_pattern ?? ""
  );
  const [expectedBehavior, setExpectedBehavior] = useState(
    initialData?.expected_behavior ?? ""
  );
  const [scope, setScope] = useState(initialData?.tenant_id ?? tenantId);
  const [priority, setPriority] = useState(initialData?.priority ?? 0);
  const [isActive, setIsActive] = useState(initialData?.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [aiSuggested, setAiSuggested] = useState(false);
  const [suggestReason, setSuggestReason] = useState<string | null>(null);

  // AI提案: モーダルが開いた時点でsourceConversationがあれば自動実行
  useEffect(() => {
    if (mode !== "create" || !sourceConversation) return;
    let cancelled = false;

    const suggest = async () => {
      setSuggesting(true);
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tuning/suggest-rule`, {
          method: "POST",
          body: JSON.stringify({
            userMessage: sourceConversation.userMsg,
            aiMessage: sourceConversation.assistantMsg,
          }),
        });
        if (cancelled) return;
        if (!res.ok) return; // 失敗時は手動入力にフォールバック
        const data = (await res.json()) as {
          trigger_pattern: string;
          instruction: string;
          priority: number;
          reason: string;
        };
        if (data.trigger_pattern || data.instruction) {
          setTriggerPattern(data.trigger_pattern ?? "");
          setExpectedBehavior(data.instruction ?? "");
          setPriority(data.priority ?? 0);
          setSuggestReason(data.reason ?? null);
          setAiSuggested(true);
        }
      } catch {
        // 失敗時は空欄のまま（手動入力）
      } finally {
        if (!cancelled) setSuggesting(false);
      }
    };

    void suggest();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title =
    mode === "edit" ? t("tuning.edit_title") : t("tuning.create_title");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!expectedBehavior.trim()) {
      setError(t("tuning.behavior_required"));
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // TODO: Replace with actual API call
      // const url = mode === "edit"
      //   ? `${API_BASE}/v1/admin/tuning-rules/${initialData!.id}?tenant=${scope}`
      //   : `${API_BASE}/v1/admin/tuning-rules?tenant=${scope}`;
      // const res = await authFetch(url, {
      //   method: mode === "edit" ? "PUT" : "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify(payload),
      // });
      // if (!res.ok) throw new Error(t("tuning.save_error"));

      // Simulate async save with mock
      await new Promise((resolve) => setTimeout(resolve, 400));

      const payload: TuningRuleInput & { id?: number } = {
        id: initialData?.id,
        tenant_id: scope,
        trigger_pattern: triggerPattern.trim(),
        expected_behavior: expectedBehavior.trim(),
        priority,
        is_active: isActive,
      };

      onSuccess(
        mode === "edit" ? t("tuning.saved") : t("tuning.added"),
        payload
      );
    } catch {
      setError(t("tuning.save_error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 1000,
        padding: "20px 16px",
        overflowY: "auto",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #1f2937",
          borderRadius: 18,
          width: "100%",
          maxWidth: 600,
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          overflow: "hidden",
          marginTop: 8,
          marginBottom: 8,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div
          style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid #1f2937",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2
            style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f9fafb" }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              border: "1px solid #374151",
              background: "transparent",
              color: "#9ca3af",
              fontSize: 20,
              cursor: saving ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {error && (
            <div
              style={{
                padding: "14px 18px",
                borderRadius: 12,
                background: "rgba(127,29,29,0.5)",
                border: "1px solid rgba(248,113,113,0.4)",
                color: "#fca5a5",
                fontSize: 15,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          {/* AI提案バナー */}
          {suggesting && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                background: "rgba(37,99,235,0.08)",
                border: "1px solid rgba(59,130,246,0.3)",
                color: "#93c5fd",
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  border: "2px solid rgba(147,197,253,0.4)",
                  borderTopColor: "#93c5fd",
                  borderRadius: "50%",
                  display: "inline-block",
                  animation: "spin 0.8s linear infinite",
                  flexShrink: 0,
                }}
              />
              🤖 AIがルール提案を生成中...
            </div>
          )}
          {aiSuggested && !suggesting && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                background: "rgba(37,99,235,0.08)",
                border: "1px solid rgba(59,130,246,0.3)",
                color: "#93c5fd",
                fontSize: 14,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span>
                🤖 AIが提案を作成しました。内容を確認して、必要に応じて編集してください。
                {suggestReason && (
                  <span style={{ display: "block", fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                    理由: {suggestReason}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => {
                  setTriggerPattern("");
                  setExpectedBehavior("");
                  setPriority(0);
                  setSuggestReason(null);
                  setAiSuggested(false);
                }}
                style={{
                  flexShrink: 0,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid rgba(107,114,128,0.4)",
                  background: "transparent",
                  color: "#6b7280",
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                リセット
              </button>
            </div>
          )}

          {/* 元の会話（会話履歴から作成時のみ） */}
          {sourceConversation && (
            <div
              style={{
                borderRadius: 12,
                border: "1px solid #374151",
                background: "rgba(15,23,42,0.6)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid #374151",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#9ca3af",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                💬 {t("tuning.source_conversation")}
              </div>
              <div style={{ padding: "14px" }}>
                {/* ユーザー */}
                <div style={{ marginBottom: 10 }}>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#60a5fa",
                      fontWeight: 600,
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    User
                  </span>
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "rgba(37,99,235,0.15)",
                      border: "1px solid rgba(37,99,235,0.2)",
                      color: "#bfdbfe",
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  >
                    {sourceConversation.userMsg}
                  </div>
                </div>
                {/* AI */}
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#9ca3af",
                      fontWeight: 600,
                      display: "block",
                      marginBottom: 4,
                    }}
                  >
                    AI
                  </span>
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "rgba(31,41,55,0.8)",
                      border: "1px solid #374151",
                      color: "#d1d5db",
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  >
                    {sourceConversation.assistantMsg.slice(0, 200)}
                    {sourceConversation.assistantMsg.length > 200 ? "…" : ""}
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: "#6b7280",
                    marginTop: 8,
                    marginBottom: 0,
                    fontStyle: "italic",
                  }}
                >
                  （この回答を改善するためにルールを作成しています）
                </p>
              </div>
            </div>
          )}

          {/* トリガーパターン */}
          <div>
            <label style={LABEL_STYLE}>{t("tuning.trigger_pattern")}</label>
            <p style={HINT_STYLE}>{t("tuning.trigger_pattern_hint")}</p>
            {suggesting ? (
              <div
                style={{
                  ...INPUT_STYLE,
                  minHeight: 52,
                  background: "rgba(37,99,235,0.08)",
                  border: "1px solid rgba(59,130,246,0.2)",
                }}
              />
            ) : (
              <input
                type="text"
                value={triggerPattern}
                onChange={(e) => setTriggerPattern(e.target.value)}
                placeholder={t("tuning.trigger_pattern_placeholder")}
                style={{
                  ...INPUT_STYLE,
                  ...(aiSuggested && triggerPattern
                    ? { background: "rgba(37,99,235,0.08)", border: "1px solid rgba(59,130,246,0.35)" }
                    : {}),
                }}
              />
            )}
          </div>

          {/* 期待する応答方針 */}
          <div>
            <label style={LABEL_STYLE}>
              {t("tuning.expected_behavior")}
              <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
            </label>
            {suggesting ? (
              <div
                style={{
                  ...TEXTAREA_STYLE,
                  minHeight: 100,
                  background: "rgba(37,99,235,0.08)",
                  border: "1px solid rgba(59,130,246,0.2)",
                }}
              />
            ) : (
              <textarea
                required
                value={expectedBehavior}
                onChange={(e) => setExpectedBehavior(e.target.value)}
                rows={4}
                placeholder={t("tuning.expected_behavior_placeholder")}
                style={{
                  ...TEXTAREA_STYLE,
                  ...(aiSuggested && expectedBehavior
                    ? { background: "rgba(37,99,235,0.08)", border: "1px solid rgba(59,130,246,0.35)" }
                    : {}),
                }}
              />
            )}
          </div>

          {/* 適用範囲 */}
          <div>
            <label style={LABEL_STYLE}>{t("tuning.scope")}</label>
            {isSuperAdmin ? (
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                style={{ ...INPUT_STYLE, minHeight: 52, appearance: "auto" }}
              >
                <option value="global">{t("tuning.scope_global")}</option>
                {tenantOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    🏢 {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "rgba(15,23,42,0.4)",
                  color: "#9ca3af",
                  fontSize: 15,
                }}
              >
                🏢 {tenantOptions.find((o) => o.value === tenantId)?.label ?? tenantId}
              </div>
            )}
          </div>

          {/* 優先度 */}
          <div>
            <label style={LABEL_STYLE}>
              {t("tuning.priority")}:{" "}
              <span style={{ color: "#4ade80", fontWeight: 700 }}>{priority}</span>
            </label>
            <p style={HINT_STYLE}>{t("tuning.priority_hint")}</p>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              style={{
                width: "100%",
                accentColor: "#22c55e",
                cursor: "pointer",
                height: 24,
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "#6b7280",
                marginTop: 4,
              }}
            >
              <span>0</span>
              <span>5</span>
              <span>10</span>
            </div>
          </div>

          {/* 有効/無効トグル */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "18px 20px",
              borderRadius: 12,
              border: `1px solid ${isActive ? "rgba(34,197,94,0.3)" : "#374151"}`,
              background: isActive
                ? "rgba(5,46,22,0.4)"
                : "rgba(15,23,42,0.6)",
              transition: "all 0.2s",
              cursor: "pointer",
            }}
            onClick={() => setIsActive((v) => !v)}
          >
            <div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: isActive ? "#4ade80" : "#9ca3af",
                }}
              >
                {isActive ? `✅ ${t("tuning.is_active")}` : `⬜ ${t("tuning.is_inactive")}`}
              </div>
              <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
                {isActive
                  ? "このルールはAIに適用されます"
                  : "保存されますが、AIには適用されません"}
              </div>
            </div>
            {/* トグルスイッチ */}
            <div
              style={{
                width: 52,
                height: 30,
                borderRadius: 999,
                background: isActive ? "#22c55e" : "#374151",
                position: "relative",
                flexShrink: 0,
                transition: "background 0.2s",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 3,
                  left: isActive ? 25 : 3,
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.2s",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
                }}
              />
            </div>
          </div>

          {/* ボタン */}
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                flex: 1,
                padding: "16px",
                minHeight: 56,
                borderRadius: 12,
                border: "1px solid #374151",
                background: "transparent",
                color: "#9ca3af",
                fontSize: 16,
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                flex: 2,
                padding: "16px",
                minHeight: 56,
                borderRadius: 12,
                border: "none",
                background: saving
                  ? "#1e3a5f"
                  : "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 50%, #1d4ed8 100%)",
                color: "#fff",
                fontSize: 17,
                fontWeight: 700,
                cursor: saving ? "not-allowed" : "pointer",
                boxShadow: saving ? "none" : "0 8px 24px rgba(59,130,246,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                transition: "opacity 0.15s",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? (
                <>
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      border: "2px solid rgba(255,255,255,0.4)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  {t("tuning.saving")}
                </>
              ) : (
                t("tuning.save")
              )}
            </button>
          </div>
        </form>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
