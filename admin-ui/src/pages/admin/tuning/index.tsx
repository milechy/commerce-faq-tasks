import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { useAuth } from "../../../auth/useAuth";
import TuningRuleModal, {
  type TuningRule,
  type TuningRuleInput,
  type SourceConversation,
} from "../../../components/tuning/TuningRuleModal";

// ─── Mock data ────────────────────────────────────────────────────────────────
const MOCK_RULES: TuningRule[] = [
  {
    id: 1,
    tenant_id: "global",
    trigger_pattern: "値引き, 割引, 安く",
    expected_behavior:
      "来店を促し、店長との直接相談をご案内してください。値引きの具体的な金額は提示しないでください。",
    priority: 10,
    is_active: true,
    created_by: "admin@example.com",
    created_at: "2026-03-16T10:00:00Z",
  },
  {
    id: 2,
    tenant_id: "carnation",
    trigger_pattern: "在庫確認, 在庫はありますか, 何台",
    expected_behavior:
      "具体的な台数を回答した後、必ず「最新情報はお電話またはご来店でご確認ください」と添えてください。",
    priority: 8,
    is_active: true,
    created_by: "admin@carnation.com",
    created_at: "2026-03-15T09:30:00Z",
  },
  {
    id: 3,
    tenant_id: "carnation",
    trigger_pattern: "",
    expected_behavior:
      "すべての返答の末尾に「ご不明な点はお気軽にお問い合わせください。」を追加してください。",
    priority: 1,
    is_active: true,
    created_by: "admin@carnation.com",
    created_at: "2026-03-14T14:00:00Z",
  },
  {
    id: 4,
    tenant_id: "demo-tenant",
    trigger_pattern: "保証, 保証期間, 保証内容",
    expected_behavior:
      "保証内容の詳細は車種・年式によって異なるため、「担当スタッフにお問い合わせください」とご案内してください。具体的な保証内容は回答しないでください。",
    priority: 7,
    is_active: false,
    created_by: "demo@example.com",
    created_at: "2026-03-10T11:00:00Z",
  },
];

// ─── Tenant options (mock) ────────────────────────────────────────────────────
const MOCK_TENANTS = [
  { value: "carnation", label: "カーネーション自動車" },
  { value: "demo-tenant", label: "デモテナント" },
];

// ─── API-ready fetch/save/delete ──────────────────────────────────────────────
async function fetchRules(tenantId?: string): Promise<TuningRule[]> {
  // TODO: Replace with actual API call
  // const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules?tenant=${tenantId}`);
  // if (!res.ok) throw new Error("load_error");
  // return (await res.json()).rules as TuningRule[];
  void tenantId;
  return MOCK_RULES;
}

let _nextId = MOCK_RULES.length + 1;

async function createRule(
  input: TuningRuleInput
): Promise<TuningRule> {
  // TODO: Replace with actual API call
  // const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify(input),
  // });
  // if (!res.ok) throw new Error("save_error");
  // return (await res.json()) as TuningRule;
  await new Promise((r) => setTimeout(r, 0));
  return {
    ...input,
    id: _nextId++,
    created_by: "current_user@example.com",
    created_at: new Date().toISOString(),
  };
}

async function updateRule(id: number, input: TuningRuleInput): Promise<TuningRule> {
  // TODO: Replace with actual API call
  // const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules/${id}`, {
  //   method: "PUT",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify(input),
  // });
  // if (!res.ok) throw new Error("save_error");
  // return (await res.json()) as TuningRule;
  await new Promise((r) => setTimeout(r, 0));
  const existing = MOCK_RULES.find((r) => r.id === id)!;
  return { ...existing, ...input };
}

async function deleteRule(id: number): Promise<void> {
  // TODO: Replace with actual API call
  // const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules/${id}`, { method: "DELETE" });
  // if (!res.ok) throw new Error("delete_error");
  await new Promise((r) => setTimeout(r, 0));
  void id;
}

async function toggleActive(id: number, is_active: boolean): Promise<void> {
  // TODO: Replace with actual API call
  // const res = await authFetch(`${API_BASE}/v1/admin/tuning-rules/${id}`, {
  //   method: "PATCH",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ is_active }),
  // });
  // if (!res.ok) throw new Error("save_error");
  await new Promise((r) => setTimeout(r, 0));
  void id; void is_active;
}

// ─── Scope badge ──────────────────────────────────────────────────────────────
function ScopeBadge({ tenantId }: { tenantId: string }) {
  if (tenantId === "global") {
    return (
      <span
        style={{
          padding: "2px 10px",
          borderRadius: 999,
          background: "rgba(139,92,246,0.15)",
          border: "1px solid rgba(139,92,246,0.3)",
          color: "#c4b5fd",
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        🌐 グローバル
      </span>
    );
  }
  const label =
    MOCK_TENANTS.find((t) => t.value === tenantId)?.label ?? tenantId;
  return (
    <span
      style={{
        padding: "2px 10px",
        borderRadius: 999,
        background: "rgba(34,197,94,0.1)",
        border: "1px solid rgba(34,197,94,0.2)",
        color: "#4ade80",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      🏢 {label}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function TuningRulesPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, lang } = useLang();
  const { user, isSuperAdmin } = useAuth();

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const tenantId = user?.tenantId ?? "carnation";

  // ─── List state ─────────────────────────────────────────────────────────────
  const [rules, setRules] = useState<TuningRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ─── Modal state ────────────────────────────────────────────────────────────
  const [createMode, setCreateMode] = useState(false);
  const [editTarget, setEditTarget] = useState<TuningRule | null>(null);
  const [sourceConversation, setSourceConversation] =
    useState<SourceConversation | null>(null);

  // ─── Delete state ───────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    pattern: string;
    deleting: boolean;
    error?: string;
  } | null>(null);

  // ─── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // ─── Load rules ─────────────────────────────────────────────────────────────
  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRules(isSuperAdmin ? undefined : tenantId);
      // Client admin: filter to own tenant only
      setRules(
        isSuperAdmin
          ? data
          : data.filter(
              (r) => r.tenant_id === tenantId || r.tenant_id === "global"
            )
      );
    } catch {
      setError(t("tuning.load_error"));
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, tenantId, t]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  // ─── Auto-open create modal from URL params (from chat-history) ─────────────
  useEffect(() => {
    if (searchParams.get("create") === "1") {
      const userMsg = searchParams.get("userMsg") ?? "";
      const assistantMsg = searchParams.get("assistantMsg") ?? "";
      if (userMsg || assistantMsg) {
        setSourceConversation({ userMsg, assistantMsg });
      }
      setCreateMode(true);
      // Clean URL without reload
      window.history.replaceState({}, "", "/admin/tuning");
    }
  }, [searchParams]);

  // ─── Modal success ──────────────────────────────────────────────────────────
  const handleModalSuccess = (
    msg: string,
    payload: TuningRuleInput & { id?: number }
  ) => {
    if (payload.id != null) {
      // Update existing
      void (async () => {
        const updated = await updateRule(payload.id!, payload as TuningRuleInput);
        setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      })();
    } else {
      // Create new
      void (async () => {
        const created = await createRule(payload as TuningRuleInput);
        setRules((prev) => [created, ...prev]);
      })();
    }
    setEditTarget(null);
    setCreateMode(false);
    setSourceConversation(null);
    showToast(msg);
  };

  // ─── Toggle active ──────────────────────────────────────────────────────────
  const handleToggleActive = (rule: TuningRule) => {
    const newActive = !rule.is_active;
    setRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, is_active: newActive } : r))
    );
    void toggleActive(rule.id, newActive);
    showToast(t("tuning.toggle_active"));
  };

  // ─── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteTarget((prev) => (prev ? { ...prev, deleting: true } : null));
    try {
      await deleteRule(deleteTarget.id);
      setRules((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      setDeleteTarget(null);
      showToast(t("tuning.deleted"));
    } catch {
      setDeleteTarget((prev) =>
        prev ? { ...prev, deleting: false, error: t("tuning.delete_error") } : null
      );
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
    });

  const tenantOptions = MOCK_TENANTS;

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 32,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <button
            onClick={() => navigate("/admin")}
            style={{
              background: "none",
              border: "none",
              color: "#9ca3af",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              marginBottom: 8,
              display: "block",
            }}
          >
            {t("tuning.back")}
          </button>
          <h1
            style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}
          >
            {t("tuning.title")}
          </h1>
          <p
            style={{
              fontSize: 14,
              color: "#9ca3af",
              marginTop: 4,
              marginBottom: 0,
            }}
          >
            {t("tuning.subtitle")}
          </p>
        </div>
        <LangSwitcher />
      </header>

      {/* Mock notice */}
      <div
        style={{
          marginBottom: 20,
          padding: "10px 16px",
          borderRadius: 10,
          background: "rgba(234,179,8,0.1)",
          border: "1px solid rgba(234,179,8,0.3)",
          color: "#fbbf24",
          fontSize: 13,
        }}
      >
        {t("tuning.mock_notice")}
      </div>

      {/* Add button */}
      <button
        onClick={() => {
          setSourceConversation(null);
          setCreateMode(true);
        }}
        style={{
          width: "100%",
          padding: "18px 24px",
          minHeight: 60,
          borderRadius: 14,
          border: "none",
          background:
            "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
          color: "#022c22",
          fontSize: 18,
          fontWeight: 700,
          cursor: "pointer",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: "0 8px 24px rgba(34,197,94,0.25)",
        }}
      >
        <span style={{ fontSize: 22 }}>＋</span>
        {t("tuning.add_rule")}
      </button>

      {/* Error */}
      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(127,29,29,0.4)",
            border: "1px solid rgba(248,113,113,0.3)",
            color: "#fca5a5",
            fontSize: 15,
          }}
        >
          {error}
        </div>
      )}

      {/* Section heading */}
      {!loading && rules.length > 0 && (
        <h2
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "#9ca3af",
            marginBottom: 12,
          }}
        >
          {t("tuning.count").replace("{n}", String(rules.length))}
        </h2>
      )}

      {/* List */}
      {loading ? (
        <div
          style={{ padding: 40, textAlign: "center", color: "#6b7280" }}
        >
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>
            ⏳
          </span>
          {t("common.loading")}
        </div>
      ) : rules.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            borderRadius: 14,
            border: "1px dashed #374151",
            background: "rgba(15,23,42,0.4)",
          }}
        >
          <span
            style={{ display: "block", fontSize: 40, marginBottom: 12 }}
          >
            🎛️
          </span>
          <p
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: "#d1d5db",
              margin: 0,
            }}
          >
            {t("tuning.no_rules")}
          </p>
          <p
            style={{
              fontSize: 13,
              color: "#6b7280",
              marginTop: 6,
              marginBottom: 0,
            }}
          >
            {t("tuning.no_rules_sub")}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                borderRadius: 14,
                border: `1px solid ${rule.is_active ? "#1f2937" : "#374151"}`,
                background: rule.is_active
                  ? "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))"
                  : "rgba(15,23,42,0.4)",
                padding: "18px 20px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                opacity: rule.is_active ? 1 : 0.65,
                transition: "opacity 0.2s",
              }}
            >
              {/* Top row: badges + priority + active toggle */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                  flexWrap: "wrap",
                }}
              >
                <ScopeBadge tenantId={rule.tenant_id} />

                {/* Priority badge */}
                <span
                  style={{
                    padding: "2px 10px",
                    borderRadius: 999,
                    background: "rgba(251,191,36,0.1)",
                    border: "1px solid rgba(251,191,36,0.25)",
                    color: "#fbbf24",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  優先度 {rule.priority}
                </span>

                <span
                  style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}
                >
                  {formatDate(rule.created_at)}
                </span>

                {/* Active toggle */}
                <button
                  onClick={() => handleToggleActive(rule)}
                  style={{
                    padding: "4px 12px",
                    minHeight: 28,
                    borderRadius: 999,
                    border: `1px solid ${rule.is_active ? "rgba(34,197,94,0.4)" : "#374151"}`,
                    background: rule.is_active
                      ? "rgba(34,197,94,0.1)"
                      : "transparent",
                    color: rule.is_active ? "#4ade80" : "#6b7280",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {rule.is_active
                    ? `✅ ${t("tuning.is_active")}`
                    : `⬜ ${t("tuning.is_inactive")}`}
                </button>
              </div>

              {/* Trigger pattern */}
              <div style={{ marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#9ca3af",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  {t("tuning.trigger_pattern")}
                </span>
                {rule.trigger_pattern ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {rule.trigger_pattern.split(",").map((kw) => (
                      <span
                        key={kw}
                        style={{
                          padding: "2px 10px",
                          borderRadius: 999,
                          background: "rgba(59,130,246,0.1)",
                          border: "1px solid rgba(59,130,246,0.2)",
                          color: "#93c5fd",
                          fontSize: 13,
                        }}
                      >
                        {kw.trim()}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span
                    style={{
                      fontSize: 13,
                      color: "#6b7280",
                      fontStyle: "italic",
                    }}
                  >
                    常時適用 (always apply)
                  </span>
                )}
              </div>

              {/* Expected behavior */}
              <div style={{ marginBottom: 14 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#9ca3af",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  {t("tuning.expected_behavior")}
                </span>
                <p
                  style={{
                    fontSize: 14,
                    color: "#e5e7eb",
                    margin: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {rule.expected_behavior}
                </p>
              </div>

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setEditTarget(rule)}
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #1d4ed8",
                    background: "rgba(29,78,216,0.15)",
                    color: "#93c5fd",
                    fontSize: 14,
                    cursor: "pointer",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("tuning.edit")}
                </button>
                <button
                  onClick={() =>
                    setDeleteTarget({
                      id: rule.id,
                      pattern: rule.trigger_pattern || "(常時適用)",
                      deleting: false,
                    })
                  }
                  style={{
                    padding: "10px 16px",
                    minHeight: 44,
                    borderRadius: 10,
                    border: "1px solid #7f1d1d",
                    background: "rgba(127,29,29,0.2)",
                    color: "#fca5a5",
                    fontSize: 14,
                    cursor: "pointer",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("tuning.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {createMode && (
        <TuningRuleModal
          mode="create"
          sourceConversation={sourceConversation ?? undefined}
          tenantId={tenantId}
          isSuperAdmin={isSuperAdmin}
          tenantOptions={tenantOptions}
          onClose={() => {
            setCreateMode(false);
            setSourceConversation(null);
          }}
          onSuccess={handleModalSuccess}
        />
      )}

      {/* Edit modal */}
      {editTarget && (
        <TuningRuleModal
          mode="edit"
          initialData={editTarget}
          tenantId={tenantId}
          isSuperAdmin={isSuperAdmin}
          tenantOptions={tenantOptions}
          onClose={() => setEditTarget(null)}
          onSuccess={handleModalSuccess}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 20,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleteTarget.deleting)
              setDeleteTarget(null);
          }}
        >
          <div
            style={{
              background: "#0f172a",
              border: "1px solid #1f2937",
              borderRadius: 16,
              padding: "28px 24px",
              maxWidth: 420,
              width: "100%",
              boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
            }}
          >
            <h3
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#f9fafb",
                margin: "0 0 12px",
              }}
            >
              {t("tuning.delete_confirm_title")}
            </h3>
            <p
              style={{
                fontSize: 14,
                color: "#d1d5db",
                margin: "0 0 6px",
              }}
            >
              {deleteTarget.pattern}
            </p>
            <p
              style={{
                fontSize: 13,
                color: "#9ca3af",
                margin: "0 0 20px",
                lineHeight: 1.6,
              }}
            >
              {t("tuning.delete_confirm_body")}
            </p>
            {deleteTarget.error && (
              <div
                style={{
                  marginBottom: 16,
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "rgba(127,29,29,0.4)",
                  color: "#fca5a5",
                  fontSize: 14,
                }}
              >
                {deleteTarget.error}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleteTarget.deleting}
                style={{
                  flex: 1,
                  padding: "14px",
                  minHeight: 56,
                  borderRadius: 10,
                  border: "1px solid #374151",
                  background: "transparent",
                  color: "#e5e7eb",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("tuning.cancel_delete")}
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={deleteTarget.deleting}
                style={{
                  flex: 1,
                  padding: "14px",
                  minHeight: 56,
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg, #991b1b, #dc2626)",
                  color: "#fee2e2",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: deleteTarget.deleting ? "not-allowed" : "pointer",
                }}
              >
                {deleteTarget.deleting
                  ? t("common.deleting")
                  : t("tuning.confirm_delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2000,
            padding: "16px 28px",
            borderRadius: 12,
            background: "rgba(5,46,22,0.95)",
            border: "1px solid rgba(74,222,128,0.4)",
            color: "#86efac",
            fontSize: 16,
            fontWeight: 600,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
