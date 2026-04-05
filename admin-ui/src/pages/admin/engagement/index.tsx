// admin-ui/src/pages/admin/engagement/index.tsx
// Phase56: お客様への声がけ設定ページ

import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import { useLang } from "../../../i18n/LangContext";

// ------------------------------------------------------------------ //
// Types
// ------------------------------------------------------------------ //
type TriggerType = "scroll_depth" | "idle_time" | "exit_intent" | "page_url_match";

interface TriggerRule {
  id: number;
  tenant_id: string;
  trigger_type: TriggerType;
  trigger_config: Record<string, unknown>;
  message_template: string;
  is_active: boolean;
  priority: number;
  created_at: string;
}

interface ModalState {
  step: 1 | 2 | 3;
  triggerType: TriggerType | null;
  triggerConfig: Record<string, unknown>;
  messageTemplate: string;
  priority: number;
  editId: number | null;
}

// ------------------------------------------------------------------ //
// Styles (inline — consistent with other admin pages)
// ------------------------------------------------------------------ //
const PAGE: CSSProperties = {
  padding: "80px 24px 48px",
  maxWidth: 900,
  margin: "0 auto",
  color: "#f9fafb",
  fontFamily: "system-ui, sans-serif",
};

const CARD: CSSProperties = {
  background: "rgba(15,23,42,0.8)",
  border: "1px solid #1f2937",
  borderRadius: 12,
  padding: "20px 24px",
  marginBottom: 16,
};

const BTN_PRIMARY: CSSProperties = {
  padding: "10px 20px",
  minHeight: 44,
  background: "#3b82f6",
  border: "none",
  borderRadius: 8,
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const BTN_GHOST: CSSProperties = {
  padding: "8px 14px",
  minHeight: 44,
  background: "none",
  border: "1px solid #374151",
  borderRadius: 8,
  color: "#9ca3af",
  fontSize: 13,
  cursor: "pointer",
};

const BTN_DANGER: CSSProperties = {
  padding: "8px 14px",
  minHeight: 44,
  background: "none",
  border: "1px solid #ef4444",
  borderRadius: 8,
  color: "#ef4444",
  fontSize: 13,
  cursor: "pointer",
};

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
  padding: 16,
};

const MODAL: CSSProperties = {
  background: "#0f172a",
  border: "1px solid #1f2937",
  borderRadius: 16,
  width: "100%",
  maxWidth: 560,
  maxHeight: "90vh",
  overflowY: "auto",
  padding: 28,
};

// ------------------------------------------------------------------ //
// Trigger type metadata
// ------------------------------------------------------------------ //
const TRIGGER_META: Record<TriggerType, { icon: string; labelKey: string }> = {
  scroll_depth: { icon: "📜", labelKey: "engagement.trigger_scroll" },
  idle_time:    { icon: "⏱️", labelKey: "engagement.trigger_idle" },
  exit_intent:  { icon: "🚪", labelKey: "engagement.trigger_exit" },
  page_url_match: { icon: "🔗", labelKey: "engagement.trigger_url" },
};

function triggerLabel(type: TriggerType, t: (key: string) => string): string {
  return t(TRIGGER_META[type].labelKey);
}

function configSummary(rule: TriggerRule): string {
  const cfg = rule.trigger_config;
  switch (rule.trigger_type) {
    case "scroll_depth":    return `スクロール ${cfg["threshold"]}% 以上`;
    case "idle_time":       return `${cfg["seconds"]} 秒以上滞在`;
    case "exit_intent":     return "離脱検知";
    case "page_url_match":  return `URL: ${cfg["pattern"]}`;
    default:                return "";
  }
}

// ------------------------------------------------------------------ //
// Toast
// ------------------------------------------------------------------ //
function Toast({ msg, type }: { msg: string; type: "success" | "error" }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 32,
        right: 24,
        background: type === "success" ? "#16a34a" : "#dc2626",
        color: "#fff",
        padding: "12px 20px",
        borderRadius: 10,
        fontSize: 14,
        fontWeight: 600,
        zIndex: 3000,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        maxWidth: 320,
      }}
    >
      {msg}
    </div>
  );
}

// ------------------------------------------------------------------ //
// Config form for step 2
// ------------------------------------------------------------------ //
function ConfigForm({
  triggerType,
  config,
  onChange,
}: {
  triggerType: TriggerType;
  config: Record<string, unknown>;
  onChange: (cfg: Record<string, unknown>) => void;
}) {
  if (triggerType === "scroll_depth") {
    const v = (config["threshold"] as number) ?? 75;
    return (
      <div>
        <label style={{ fontSize: 13, color: "#9ca3af" }}>スクロール深度のしきい値</label>
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          {[25, 50, 75, 100].map((t) => (
            <button
              key={t}
              onClick={() => onChange({ threshold: t })}
              style={{
                padding: "10px 20px",
                minHeight: 44,
                borderRadius: 8,
                border: `2px solid ${v === t ? "#3b82f6" : "#374151"}`,
                background: v === t ? "rgba(59,130,246,0.15)" : "none",
                color: v === t ? "#60a5fa" : "#9ca3af",
                fontWeight: v === t ? 700 : 400,
                cursor: "pointer",
                fontSize: 15,
              }}
            >
              {t}%
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (triggerType === "idle_time") {
    const v = (config["seconds"] as number) ?? 30;
    const opts = [
      { label: "10秒", value: 10 },
      { label: "30秒", value: 30 },
      { label: "1分", value: 60 },
      { label: "2分", value: 120 },
      { label: "5分", value: 300 },
    ];
    return (
      <div>
        <label style={{ fontSize: 13, color: "#9ca3af" }}>滞在時間のしきい値</label>
        <select
          value={v}
          onChange={(e) => onChange({ seconds: Number(e.target.value) })}
          style={{
            display: "block",
            marginTop: 10,
            width: "100%",
            padding: "12px 14px",
            minHeight: 44,
            background: "#1e293b",
            border: "1px solid #374151",
            borderRadius: 8,
            color: "#f9fafb",
            fontSize: 14,
          }}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (triggerType === "exit_intent") {
    return (
      <div
        style={{
          background: "rgba(59,130,246,0.07)",
          border: "1px solid rgba(59,130,246,0.2)",
          borderRadius: 10,
          padding: "16px 18px",
        }}
      >
        <p style={{ color: "#93c5fd", fontSize: 14, margin: 0 }}>
          🚪 お客様がページを離れようとした瞬間（マウスがブラウザ上端に移動した時）に声がけします。追加設定は不要です。
        </p>
      </div>
    );
  }

  if (triggerType === "page_url_match") {
    const v = (config["pattern"] as string) ?? "";
    return (
      <div>
        <label style={{ fontSize: 13, color: "#9ca3af" }}>URLパターン（globで指定）</label>
        <input
          type="text"
          value={v}
          placeholder="/products/*"
          onChange={(e) => onChange({ pattern: e.target.value, match_type: "glob" })}
          style={{
            display: "block",
            marginTop: 10,
            width: "100%",
            padding: "12px 14px",
            minHeight: 44,
            background: "#1e293b",
            border: "1px solid #374151",
            borderRadius: 8,
            color: "#f9fafb",
            fontSize: 14,
            boxSizing: "border-box",
          }}
        />
        <p style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
          例: <code>/products/*</code>（商品一覧）、<code>/products/shoes/**</code>（靴カテゴリ以下全て）
        </p>
      </div>
    );
  }

  return null;
}

// ------------------------------------------------------------------ //
// Widget preview
// ------------------------------------------------------------------ //
function WidgetPreview({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "#0f172a",
        border: "1px solid #1f2937",
        borderRadius: 12,
        padding: 16,
        marginTop: 16,
      }}
    >
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>お客様への表示イメージ</p>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
          }}
        >
          🤖
        </div>
        <div
          style={{
            background: "#1e293b",
            border: "1px solid #374151",
            borderRadius: "4px 12px 12px 12px",
            padding: "10px 14px",
            fontSize: 14,
            color: "#f9fafb",
            maxWidth: 280,
            lineHeight: 1.5,
          }}
        >
          {message || "メッセージをここに入力してください"}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ //
// Main Page
// ------------------------------------------------------------------ //
export default function EngagementPage() {
  const { t } = useLang();
  const { isSuperAdmin, user, previewMode, previewTenantId } = useAuth();

  const [rules, setRules] = useState<TriggerRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [modal, setModal] = useState<ModalState>({
    step: 1,
    triggerType: null,
    triggerConfig: {},
    messageTemplate: "",
    priority: 0,
    editId: null,
  });
  const [saving, setSaving] = useState(false);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (!isSuperAdmin && user?.tenantId) {
        params.set("tenant_id", user.tenantId);
      }
      const res = await authFetch(`${API_BASE}/v1/admin/engagement/rules?${params}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRules(data.rules ?? []);
    } catch {
      showToast(t("engagement.save_error"), "error");
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, user?.tenantId, t]);

  useEffect(() => { void loadRules(); }, [loadRules]);

  const openCreate = () => {
    setModal({ step: 1, triggerType: null, triggerConfig: {}, messageTemplate: "", priority: 0, editId: null });
    setShowModal(true);
  };

  const openEdit = (rule: TriggerRule) => {
    setModal({
      step: 2,
      triggerType: rule.trigger_type,
      triggerConfig: rule.trigger_config,
      messageTemplate: rule.message_template,
      priority: rule.priority,
      editId: rule.id,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!modal.triggerType || !modal.messageTemplate.trim()) return;
    // Effective tenant: preview mode uses previewTenantId, client_admin uses own tenantId
    // Super_admin without preview has no tenant context → block
    const effectiveTenantId = previewMode ? previewTenantId : user?.tenantId;
    const isTrueSuperAdmin = user?.role === 'super_admin' && !previewMode;
    if (!isTrueSuperAdmin && !effectiveTenantId) {
      showToast("テナントが特定できません。もう一度ログインしてください。", "error");
      return;
    }
    setSaving(true);
    try {
      const body = {
        trigger_type: modal.triggerType,
        trigger_config: modal.triggerConfig,
        message_template: modal.messageTemplate,
        priority: modal.priority,
        is_active: true,
        ...(isTrueSuperAdmin ? {} : { tenant_id: effectiveTenantId }),
      };
      let res: Response;
      if (modal.editId) {
        res = await authFetch(`${API_BASE}/v1/admin/engagement/rules/${modal.editId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      } else {
        res = await authFetch(`${API_BASE}/v1/admin/engagement/rules`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) throw new Error();
      showToast(t("engagement.save_success"), "success");
      setShowModal(false);
      await loadRules();
    } catch {
      showToast(t("engagement.save_error"), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: TriggerRule) => {
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/engagement/rules/${rule.id}/toggle`,
        { method: "PATCH" },
      );
      if (!res.ok) throw new Error();
      await loadRules();
    } catch {
      showToast(t("engagement.save_error"), "error");
    }
  };

  const handleDelete = async (rule: TriggerRule) => {
    if (!window.confirm(t("engagement.delete_confirm"))) return;
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/engagement/rules/${rule.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error();
      showToast(t("engagement.delete_success"), "success");
      await loadRules();
    } catch {
      showToast(t("engagement.delete_error"), "error");
    }
  };

  const defaultConfig = (type: TriggerType): Record<string, unknown> => {
    switch (type) {
      case "scroll_depth":    return { threshold: 75 };
      case "idle_time":       return { seconds: 30 };
      case "exit_intent":     return {};
      case "page_url_match":  return { pattern: "/products/*", match_type: "glob" };
    }
  };

  const canSave =
    modal.triggerType &&
    modal.messageTemplate.trim().length > 0 &&
    (modal.triggerType !== "page_url_match" ||
      (modal.triggerConfig["pattern"] as string | undefined)?.trim());

  return (
    <div style={PAGE}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: "#f9fafb" }}>
          💬 {t("engagement.title")}
        </h1>
        <p style={{ color: "#6b7280", fontSize: 14, marginTop: 6 }}>
          {t("engagement.description")}
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button style={BTN_PRIMARY} onClick={openCreate}>
          ＋ {t("engagement.create")}
        </button>
      </div>

      {/* Rules list */}
      {loading ? (
        <p style={{ color: "#6b7280" }}>{t("common.loading")}</p>
      ) : rules.length === 0 ? (
        <div
          style={{
            ...CARD,
            textAlign: "center",
            padding: "48px 24px",
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 12 }}>🌟</div>
          <p style={{ color: "#9ca3af", fontSize: 15, marginBottom: 20 }}>
            {t("engagement.empty")}
          </p>
          <button style={BTN_PRIMARY} onClick={openCreate}>
            ＋ {t("engagement.create")}
          </button>
        </div>
      ) : (
        rules.map((rule) => (
          <div key={rule.id} style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {/* Icon + trigger info */}
              <span style={{ fontSize: 24 }}>{TRIGGER_META[rule.trigger_type].icon}</span>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb" }}>
                  {triggerLabel(rule.trigger_type, t)}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {configSummary(rule)}
                </div>
              </div>

              {/* Message preview */}
              <div
                style={{
                  flex: 2,
                  minWidth: 140,
                  fontSize: 13,
                  color: "#d1d5db",
                  background: "#1e293b",
                  borderRadius: 8,
                  padding: "8px 12px",
                  maxWidth: 320,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={rule.message_template}
              >
                {rule.message_template.slice(0, 60)}
                {rule.message_template.length > 60 ? "…" : ""}
              </div>

              {/* Priority badge */}
              <span
                style={{
                  fontSize: 11,
                  color: "#9ca3af",
                  background: "#1e293b",
                  padding: "3px 8px",
                  borderRadius: 6,
                  whiteSpace: "nowrap",
                }}
              >
                優先度 {rule.priority}
              </span>

              {/* Toggle */}
              <button
                onClick={() => void handleToggle(rule)}
                style={{
                  padding: "8px 16px",
                  minHeight: 44,
                  borderRadius: 8,
                  border: `1px solid ${rule.is_active ? "#16a34a" : "#374151"}`,
                  background: rule.is_active ? "rgba(22,163,74,0.12)" : "none",
                  color: rule.is_active ? "#4ade80" : "#6b7280",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {rule.is_active ? t("engagement.active") : t("engagement.inactive")}
              </button>

              {/* Edit */}
              <button style={BTN_GHOST} onClick={() => openEdit(rule)}>
                編集
              </button>

              {/* Delete */}
              <button style={BTN_DANGER} onClick={() => void handleDelete(rule)}>
                削除
              </button>
            </div>
          </div>
        ))
      )}

      {/* Modal */}
      {showModal && (
        <div style={OVERLAY} onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div style={MODAL}>
            {/* Step indicator */}
            <div style={{ display: "flex", gap: 8, marginBottom: 24, alignItems: "center" }}>
              {([1, 2, 3] as const).map((s) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: modal.step >= s ? "#3b82f6" : "#374151",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {s}
                  </div>
                  <span style={{ fontSize: 12, color: modal.step >= s ? "#93c5fd" : "#6b7280" }}>
                    {s === 1 ? t("engagement.step1_label") : s === 2 ? t("engagement.step2_label") : t("engagement.step3_label")}
                  </span>
                  {s < 3 && <span style={{ color: "#374151" }}>›</span>}
                </div>
              ))}
            </div>

            {/* Step 1: trigger type selection */}
            {modal.step === 1 && (
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: "#f9fafb" }}>
                  どんな時に声をかけますか？
                </h2>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {(Object.keys(TRIGGER_META) as TriggerType[]).map((type) => {
                    const meta = TRIGGER_META[type];
                    const selected = modal.triggerType === type;
                    return (
                      <button
                        key={type}
                        onClick={() =>
                          setModal((m) => ({
                            ...m,
                            triggerType: type,
                            triggerConfig: defaultConfig(type),
                          }))
                        }
                        style={{
                          padding: "18px 14px",
                          minHeight: 90,
                          borderRadius: 12,
                          border: `2px solid ${selected ? "#3b82f6" : "#374151"}`,
                          background: selected ? "rgba(59,130,246,0.1)" : "#1e293b",
                          color: selected ? "#93c5fd" : "#9ca3af",
                          cursor: "pointer",
                          textAlign: "left",
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 28 }}>{meta.icon}</span>
                        <span style={{ fontSize: 13, fontWeight: selected ? 600 : 400 }}>
                          {t(meta.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20, gap: 10 }}>
                  <button style={BTN_GHOST} onClick={() => setShowModal(false)}>
                    {t("common.cancel")}
                  </button>
                  <button
                    style={{ ...BTN_PRIMARY, opacity: modal.triggerType ? 1 : 0.4 }}
                    disabled={!modal.triggerType}
                    onClick={() => setModal((m) => ({ ...m, step: 2 }))}
                  >
                    次へ →
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: config */}
            {modal.step === 2 && modal.triggerType && (
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: "#f9fafb" }}>
                  {TRIGGER_META[modal.triggerType].icon} {t(TRIGGER_META[modal.triggerType].labelKey)}
                </h2>
                <ConfigForm
                  triggerType={modal.triggerType}
                  config={modal.triggerConfig}
                  onChange={(cfg) => setModal((m) => ({ ...m, triggerConfig: cfg }))}
                />
                <div style={{ marginTop: 16 }}>
                  <label style={{ fontSize: 13, color: "#9ca3af" }}>優先度（高いほど先にチェック）</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={modal.priority}
                    onChange={(e) => setModal((m) => ({ ...m, priority: Number(e.target.value) }))}
                    style={{
                      display: "block",
                      marginTop: 8,
                      width: "100px",
                      padding: "10px 12px",
                      minHeight: 44,
                      background: "#1e293b",
                      border: "1px solid #374151",
                      borderRadius: 8,
                      color: "#f9fafb",
                      fontSize: 14,
                    }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
                  <button style={BTN_GHOST} onClick={() => setModal((m) => ({ ...m, step: 1 }))}>
                    ← 戻る
                  </button>
                  <button
                    style={BTN_PRIMARY}
                    onClick={() => setModal((m) => ({ ...m, step: 3 }))}
                  >
                    次へ →
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: message */}
            {modal.step === 3 && (
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: "#f9fafb" }}>
                  どんなメッセージを送りますか？
                </h2>
                <textarea
                  value={modal.messageTemplate}
                  onChange={(e) => setModal((m) => ({ ...m, messageTemplate: e.target.value }))}
                  placeholder={t("engagement.message_placeholder")}
                  rows={4}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    background: "#1e293b",
                    border: "1px solid #374151",
                    borderRadius: 8,
                    color: "#f9fafb",
                    fontSize: 14,
                    resize: "vertical",
                    boxSizing: "border-box",
                    lineHeight: 1.6,
                  }}
                />
                <WidgetPreview message={modal.messageTemplate} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24, gap: 10 }}>
                  <button style={BTN_GHOST} onClick={() => setModal((m) => ({ ...m, step: 2 }))}>
                    ← 戻る
                  </button>
                  <button
                    style={{ ...BTN_PRIMARY, opacity: canSave ? 1 : 0.4 }}
                    disabled={!canSave || saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? "保存中..." : t("engagement.save")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <Toast msg={toast.msg} type={toast.type} />}
    </div>
  );
}
