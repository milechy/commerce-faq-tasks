import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";
import type { SuggestedRule, Evaluation, Message, DeleteStep } from "./types";

const DEFAULT_CONVERSION_TYPES = ["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"];

// ─── 型定義 (SuggestedRule, Evaluation, Message, DeleteStep は ./types に移動) ─

interface SessionInfo {
  id: string;
  tenant_id: string;
  session_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
}

async function fetchMessages(
  sessionDbId: string,
  tenantId?: string
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (tenantId) params.set("tenant", tenantId);
  const res = await authFetch(
    `${API_BASE}/v1/admin/chat-history/sessions/${sessionDbId}/messages?${params}`
  );
  if (!res.ok) throw new Error("Failed to fetch messages");
  const data = await res.json();
  return data.messages as Message[];
}

// ─── AI提案ルール承認カード (Super Admin only) ─────────────────────────────────

function SuggestedRulesCard({
  evaluationId,
  rules,
  onUpdate,
}: {
  evaluationId: number;
  rules: SuggestedRule[];
  onUpdate: (updated: SuggestedRule[]) => void;
}) {
  const navigate = useNavigate();
  const [processing, setProcessing] = useState<number | null>(null);

  const pending = rules.filter((r) => !r.status || r.status === "pending");
  const approved = rules.filter((r) => r.status === "approved");
  if (pending.length === 0 && approved.length === 0) return null;

  const handleAction = async (ruleIndex: number, action: "approve" | "reject") => {
    setProcessing(ruleIndex);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/evaluations/${evaluationId}/rules/${ruleIndex}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) },
      );
      if (res.ok) {
        const json = await res.json() as { tuning_rule_id?: number };
        const updated = rules.map((r, i) =>
          i === ruleIndex
            ? { ...r, status: action === "approve" ? "approved" : "rejected", tuning_rule_id: json.tuning_rule_id }
            : r,
        );
        onUpdate(updated);
      }
    } finally {
      setProcessing(null);
    }
  };

  const totalShown = pending.length + approved.length;

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#c4b5fd" }}>
        💡 AI提案ルール ({totalShown}件)
      </p>
      {rules.map((rule, idx) => {
        const isApproved = rule.status === "approved";
        const isPending = !rule.status || rule.status === "pending";
        if (!isPending && !isApproved) return null;
        const busy = processing === idx;
        return (
          <div
            key={idx}
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: isApproved ? "rgba(34,197,94,0.06)" : "rgba(124,58,237,0.08)",
              border: `1px solid ${isApproved ? "rgba(74,222,128,0.2)" : "rgba(196,181,253,0.2)"}`,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <p style={{ margin: 0, fontSize: 13, color: "var(--foreground)", lineHeight: 1.6 }}>
              {rule.rule_text}
            </p>
            {isApproved ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: "#4ade80", fontWeight: 600 }}>✅ 承認済み</span>
                <button
                  onClick={() => {
                    const params = new URLSearchParams();
                    if (rule.tuning_rule_id) params.set("editId", String(rule.tuning_rule_id));
                    navigate(`/admin/tuning?${params.toString()}`);
                  }}
                  style={{
                    padding: "6px 12px", minHeight: 32, borderRadius: 6,
                    border: "1px solid rgba(148,163,184,0.3)", background: "rgba(148,163,184,0.1)",
                    color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  ✏️ 編集
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => void handleAction(idx, "approve")}
                  disabled={busy}
                  style={{
                    flex: 1, padding: "10px 12px", minHeight: 44, borderRadius: 8,
                    border: "1px solid rgba(74,222,128,0.4)", background: "rgba(34,197,94,0.15)",
                    color: "#4ade80", fontSize: 14, fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
                  }}
                >
                  ✅ 承認してルールに追加
                </button>
                <button
                  onClick={() => void handleAction(idx, "reject")}
                  disabled={busy}
                  style={{
                    padding: "10px 16px", minHeight: 44, borderRadius: 8,
                    border: "1px solid rgba(248,113,113,0.4)", background: "rgba(239,68,68,0.15)",
                    color: "#f87171", fontSize: 14, fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
                  }}
                >
                  ❌ 却下
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ChatHistorySessionPage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { t, lang } = useLang();
  const { user, isSuperAdmin, isClientAdmin } = useAuth();
  const location = useLocation();

  const sessionFromState = (location.state as { session?: SessionInfo } | null)?.session ?? null;

  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(sessionFromState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [outcomeRecordedAt, setOutcomeRecordedAt] = useState<string | null>(null);
  const [outcomeRecordedBy, setOutcomeRecordedBy] = useState<string | null>(null);
  const [conversionTypes, setConversionTypes] = useState<string[]>(DEFAULT_CONVERSION_TYPES);
  const [outcomeSubmitting, setOutcomeSubmitting] = useState(false);
  const [outcomeToast, setOutcomeToast] = useState<string | null>(null);

  // ─── セッション完全削除（GDPR Art.17 / 個情法30条） ────────────────────────
  const [deleteStep, setDeleteStep] = useState<DeleteStep>("idle");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteReasonRef = useRef<HTMLTextAreaElement>(null);
  const deleteConfirmRef = useRef<HTMLInputElement>(null);

  const locale = lang === "en" ? "en-US" : "ja-JP";
  const tenantId = isSuperAdmin ? undefined : (user?.tenantId ?? undefined);

  const loadMessages = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMessages(sessionId, tenantId);
      setMessages(data);
      // If session info wasn't passed via nav state, fill in what we can
      if (!sessionInfo) {
        setSessionInfo({
          id: sessionId,
          tenant_id: tenantId ?? "",
          session_id: sessionId,
          started_at: data[0]?.created_at ?? new Date().toISOString(),
          last_message_at: data[data.length - 1]?.created_at ?? new Date().toISOString(),
          message_count: data.length,
        });
      }
    } catch {
      setError("データの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [sessionId, tenantId, sessionInfo]);

  useEffect(() => {
    void loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Judge評価を取得
  useEffect(() => {
    if (!sessionId) return;
    authFetch(`${API_BASE}/v1/admin/evaluations/${sessionId}`)
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ evaluations?: Evaluation[] }>;
      })
      .then((data) => {
        setEvaluation(data?.evaluations?.[0] ?? null);
      })
      .catch(() => {});
  }, [sessionId]);

  // テナントのconversion_typesを取得
  useEffect(() => {
    const fetchConversionTypes = async () => {
      try {
        const endpoint = isSuperAdmin && sessionInfo?.tenant_id
          ? `${API_BASE}/v1/admin/tenants/${sessionInfo.tenant_id}`
          : `${API_BASE}/v1/admin/my-tenant`;
        const res = await authFetch(endpoint);
        if (!res.ok) return;
        const data = (await res.json()) as { conversion_types?: string[] };
        if (Array.isArray(data.conversion_types) && data.conversion_types.length > 0) {
          setConversionTypes(data.conversion_types);
        }
      } catch {
        // フォールバック: デフォルトを使用
      }
    };
    void fetchConversionTypes();
  }, [isSuperAdmin, sessionInfo?.tenant_id]);

  // sessionFromStateにoutcome情報があれば復元
  useEffect(() => {
    const s = sessionFromState as (typeof sessionFromState & { outcome?: string | null; outcome_recorded_at?: string | null; outcome_recorded_by?: string | null }) | null;
    if (s?.outcome) {
      setOutcome(s.outcome);
      setOutcomeRecordedAt(s.outcome_recorded_at ?? null);
      setOutcomeRecordedBy(s.outcome_recorded_by ?? null);
    }
  }, []);

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });

  const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleOutcome = async (value: string) => {
    if (!sessionId) return;
    setOutcomeSubmitting(true);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/chat-history/sessions/${sessionId}/outcome`,
        { method: "PATCH", body: JSON.stringify({ outcome: value }) },
      );
      const data = (await res.json()) as { outcome?: string; recorded_at?: string; recorded_by?: string; error?: string };
      if (!res.ok) {
        setOutcomeToast(data.error ?? "保存に失敗しました。もう一度お試しください 🙏");
        setTimeout(() => setOutcomeToast(null), 3000);
        return;
      }
      setOutcome(value);
      setOutcomeRecordedAt(data.recorded_at ?? new Date().toISOString());
      setOutcomeRecordedBy(data.recorded_by ?? null);
      setOutcomeToast(`✅ 「${value}」として記録しました`);
      setTimeout(() => setOutcomeToast(null), 3000);
    } catch {
      setOutcomeToast("保存に失敗しました。もう一度お試しください 🙏");
      setTimeout(() => setOutcomeToast(null), 3000);
    } finally {
      setOutcomeSubmitting(false);
    }
  };

  // セッション削除: super_admin / client_admin のみ許可
  const isDeleteAllowed = isSuperAdmin || isClientAdmin;

  const handleDeleteSubmit = async () => {
    if (!sessionId) return;
    const trimmedReason = deleteReason.trim();
    if (trimmedReason.length < 5) {
      setDeleteError("削除理由は5文字以上で入力してください");
      deleteReasonRef.current?.focus();
      return;
    }
    if (trimmedReason.length > 500) {
      setDeleteError("削除理由は500文字以内で入力してください");
      deleteReasonRef.current?.focus();
      return;
    }
    if (deleteConfirmId.trim() !== sessionId) {
      setDeleteError("セッションIDが一致しません。もう一度確認してください");
      deleteConfirmRef.current?.focus();
      return;
    }
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      const res = await authFetch(
        `${API_BASE}/v1/admin/chat-history/sessions/${sessionId}`,
        {
          method: "DELETE",
          body: JSON.stringify({ reason: trimmedReason }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        console.error("[DeleteSession] API error", { sessionId, status: res.status, error: data.error });
        setDeleteError(
          data.error ??
            "削除できませんでした。少し時間をおいてもう一度試してみてください 🙏",
        );
        setDeleteSubmitting(false);
        return;
      }
      // 成功: トースト表示後に一覧へ遷移
      setDeleteStep("idle");
      setOutcomeToast("✅ セッションを完全に削除しました");
      setTimeout(() => {
        navigate("/admin/chat-history");
      }, 1500);
    } catch (err) {
      console.error("[DeleteSession] unexpected error", { sessionId, err });
      setDeleteError("サーバーとうまくお話できませんでした。もう一度試してみてください 🙏");
      setDeleteSubmitting(false);
    }
  };

  const handleCreateRule = (assistantMsg: Message) => {
    const msgIndex = messages.findIndex((m) => m.id === assistantMsg.id);
    const userMsg =
      msgIndex > 0 && messages[msgIndex - 1].role === "user"
        ? messages[msgIndex - 1].content
        : "";

    const params = new URLSearchParams({
      create: "1",
      userMsg,
      assistantMsg: assistantMsg.content,
    });
    if (sessionInfo?.tenant_id) params.set("presetTenantId", sessionInfo.tenant_id);
    navigate(`/admin/tuning?${params.toString()}`);
  };

  if (!loading && error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--background)",
          color: "var(--foreground)",
          padding: "24px 20px",
          maxWidth: 900,
          margin: "0 auto",
        }}
      >
        <button
          onClick={() => navigate("/admin/chat-history")}
          style={{
            background: "none",
            border: "none",
            color: "var(--muted-foreground)",
            fontSize: 14,
            cursor: "pointer",
            padding: 0,
            marginBottom: 24,
            display: "block",
          }}
        >
          {t("chat_history.back_to_list")}
        </button>
        <div
          style={{
            padding: "32px 20px",
            borderRadius: 14,
            border: "1px solid rgba(248,113,113,0.3)",
            background: "rgba(127,29,29,0.2)",
            color: "#fca5a5",
            textAlign: "center",
            fontSize: 15,
          }}
        >
          <p style={{ margin: "0 0 16px" }}>{error}</p>
          <button
            onClick={() => void loadMessages()}
            style={{
              padding: "10px 20px",
              minHeight: 44,
              borderRadius: 10,
              border: "1px solid rgba(248,113,113,0.4)",
              background: "rgba(248,113,113,0.1)",
              color: "#fca5a5",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "24px 20px",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <header style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <button
            onClick={() => navigate("/admin/chat-history")}
            style={{
              background: "none",
              border: "none",
              color: "var(--muted-foreground)",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              marginBottom: 8,
              display: "block",
            }}
          >
            {t("chat_history.back_to_list")}
          </button>
          <LangSwitcher />
        </div>

        {/* 完全削除ボタン (super_admin / client_admin のみ) */}
        {isDeleteAllowed && (
          <div style={{ marginBottom: 8 }}>
            <button
              onClick={() => {
                setDeleteStep("step1");
                setDeleteError(null);
                setDeleteReason("");
                setDeleteConfirmId("");
              }}
              style={{
                padding: "10px 18px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(239,68,68,0.4)",
                background: "rgba(127,29,29,0.2)",
                color: "#f87171",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                transition: "border-color 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.style.borderColor = "rgba(239,68,68,0.7)";
                btn.style.background = "rgba(127,29,29,0.4)";
              }}
              onMouseLeave={(e) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.style.borderColor = "rgba(239,68,68,0.4)";
                btn.style.background = "rgba(127,29,29,0.2)";
              }}
            >
              🗑️ 完全削除
            </button>
          </div>
        )}

        <div
          style={{
            borderRadius: 14,
            border: "1px solid var(--border)",
            background: "linear-gradient(145deg, var(--card), var(--card))",
            padding: "18px 20px",
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "center",
          }}
        >
          {sessionInfo && (
            <>
              <span
                style={{
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: "rgba(34,197,94,0.15)",
                  border: "1px solid rgba(34,197,94,0.3)",
                  color: "#4ade80",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {sessionInfo.tenant_id}
              </span>
              <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
                🕐 {formatDateTime(sessionInfo.started_at)}
              </span>
            </>
          )}
          <span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
            💬{" "}
            {t("chat_history.message_count").replace(
              "{n}",
              String(messages.length)
            )}
          </span>
          {sessionInfo && (
            <span style={{ fontSize: 11, color: "#4b5563", fontFamily: "monospace", marginLeft: "auto" }}>
              {sessionInfo.session_id.slice(0, 8)}…
            </span>
          )}
        </div>
      </header>

      {/* 営業結果トースト */}
      {outcomeToast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "14px 24px",
            borderRadius: 12,
            background: "var(--card)",
            border: "1px solid #22c55e",
            color: "#4ade80",
            fontSize: 15,
            fontWeight: 600,
            zIndex: 2000,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
          {outcomeToast}
        </div>
      )}

      {/* ─── 完全削除モーダル ──────────────────────────────────────────────────── */}
      {deleteStep !== "idle" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="セッション完全削除"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleteSubmitting) {
              setDeleteStep("idle");
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
            padding: 20,
          }}
        >
          <div
            style={{
              background: "var(--background)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              padding: "28px 24px",
              maxWidth: 480,
              width: "100%",
            }}
          >
            {/* エラー表示 */}
            {deleteError && (
              <div
                style={{
                  marginBottom: 16,
                  padding: "12px 16px",
                  borderRadius: 10,
                  background: "rgba(127,29,29,0.4)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  color: "#fca5a5",
                  fontSize: 14,
                  lineHeight: 1.6,
                }}
              >
                {deleteError}
              </div>
            )}

            {/* Step 1: 警告・確認 */}
            {deleteStep === "step1" && (
              <>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
                  🗑️ セッションを完全に削除しますか?
                </h2>
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: 10,
                    background: "rgba(120,53,15,0.4)",
                    border: "1px solid rgba(251,191,36,0.3)",
                    color: "#fbbf24",
                    fontSize: 14,
                    fontWeight: 600,
                    marginBottom: 20,
                    lineHeight: 1.6,
                  }}
                >
                  ⚠️ この操作は取り消せません。チャット履歴・評価データがすべて完全に削除されます。
                </div>
                <p style={{ fontSize: 15, color: "var(--muted-foreground)", marginBottom: 24, lineHeight: 1.6 }}>
                  GDPR（忘れられる権利）または個人情報保護法に基づいて削除を行う場合は「次へ」を押してください。
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <button
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteStep("step2");
                      setTimeout(() => deleteReasonRef.current?.focus(), 50);
                    }}
                    style={{
                      padding: "16px 24px",
                      minHeight: 52,
                      borderRadius: 12,
                      border: "1px solid rgba(239,68,68,0.5)",
                      background: "rgba(127,29,29,0.3)",
                      color: "#f87171",
                      fontSize: 16,
                      fontWeight: 700,
                      cursor: "pointer",
                      width: "100%",
                    }}
                  >
                    次へ（削除理由を入力）
                  </button>
                  <button
                    onClick={() => setDeleteStep("idle")}
                    style={{
                      padding: "14px 24px",
                      minHeight: 48,
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--muted-foreground)",
                      fontSize: 15,
                      fontWeight: 600,
                      cursor: "pointer",
                      width: "100%",
                    }}
                  >
                    やめる
                  </button>
                </div>
              </>
            )}

            {/* Step 2: 削除理由入力 + セッションID確認 */}
            {deleteStep === "step2" && (
              <>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--foreground)", margin: "0 0 16px" }}>
                  削除の詳細確認
                </h2>

                {/* 削除理由 */}
                <div style={{ marginBottom: 20 }}>
                  <label
                    htmlFor="delete-reason"
                    style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}
                  >
                    削除理由 <span style={{ color: "#f87171" }}>*</span>
                    <span style={{ fontWeight: 400, color: "var(--muted-foreground)", marginLeft: 4 }}>(5〜500文字)</span>
                  </label>
                  <textarea
                    id="delete-reason"
                    ref={deleteReasonRef}
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    placeholder="例: GDPR Art.17に基づくデータ削除要求（ユーザーID: xxx、受付日: 2026-05-31）"
                    rows={4}
                    disabled={deleteSubmitting}
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      color: "var(--foreground)",
                      fontSize: 14,
                      lineHeight: 1.6,
                      resize: "vertical",
                      minHeight: 96,
                      boxSizing: "border-box",
                      outline: "none",
                    }}
                  />
                  <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                    {deleteReason.trim().length} / 500文字
                  </span>
                </div>

                {/* セッションID確認 */}
                <div style={{ marginBottom: 24 }}>
                  <label
                    htmlFor="delete-confirm-id"
                    style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}
                  >
                    確認のため、セッションIDを入力してください <span style={{ color: "#f87171" }}>*</span>
                  </label>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: 12,
                      color: "var(--muted-foreground)",
                      background: "rgba(0,0,0,0.4)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "6px 10px",
                      marginBottom: 8,
                      wordBreak: "break-all",
                      userSelect: "text",
                    }}
                  >
                    {sessionId}
                  </div>
                  <input
                    id="delete-confirm-id"
                    ref={deleteConfirmRef}
                    type="text"
                    value={deleteConfirmId}
                    onChange={(e) => setDeleteConfirmId(e.target.value)}
                    placeholder="上記のセッションIDをそのまま入力"
                    disabled={deleteSubmitting}
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      borderRadius: 10,
                      border:
                        deleteConfirmId && deleteConfirmId !== sessionId
                          ? "1px solid rgba(248,113,113,0.5)"
                          : "1px solid var(--border)",
                      background: "var(--card)",
                      color: "var(--foreground)",
                      fontSize: 14,
                      fontFamily: "monospace",
                      boxSizing: "border-box",
                      outline: "none",
                    }}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <button
                    onClick={() => void handleDeleteSubmit()}
                    disabled={
                      deleteSubmitting ||
                      deleteReason.trim().length < 5 ||
                      deleteConfirmId.trim() !== sessionId
                    }
                    style={{
                      padding: "16px 24px",
                      minHeight: 52,
                      borderRadius: 12,
                      border: "1px solid rgba(239,68,68,0.5)",
                      background:
                        deleteSubmitting ||
                        deleteReason.trim().length < 5 ||
                        deleteConfirmId.trim() !== sessionId
                          ? "rgba(127,29,29,0.2)"
                          : "rgba(127,29,29,0.5)",
                      color:
                        deleteSubmitting ||
                        deleteReason.trim().length < 5 ||
                        deleteConfirmId.trim() !== sessionId
                          ? "rgba(248,113,113,0.5)"
                          : "#f87171",
                      fontSize: 16,
                      fontWeight: 700,
                      cursor:
                        deleteSubmitting ||
                        deleteReason.trim().length < 5 ||
                        deleteConfirmId.trim() !== sessionId
                          ? "not-allowed"
                          : "pointer",
                      width: "100%",
                    }}
                  >
                    {deleteSubmitting ? "⏳ 削除中..." : "🗑️ 完全に削除する"}
                  </button>
                  <button
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteStep("step1");
                    }}
                    disabled={deleteSubmitting}
                    style={{
                      padding: "14px 24px",
                      minHeight: 48,
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--muted-foreground)",
                      fontSize: 15,
                      fontWeight: 600,
                      cursor: deleteSubmitting ? "not-allowed" : "pointer",
                      width: "100%",
                    }}
                  >
                    戻る
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted-foreground)" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          {t("chat_history.loading")}
        </div>
      ) : (
        /* Messages */
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              {/* Role label */}
              <span
                style={{
                  fontSize: 12,
                  color: "var(--muted-foreground)",
                  marginBottom: 4,
                  paddingLeft: msg.role === "user" ? 0 : 4,
                  paddingRight: msg.role === "user" ? 4 : 0,
                }}
              >
                {msg.role === "user"
                  ? t("chat_history.user_message")
                  : t("chat_history.assistant_message")}
                {" · "}
                {formatTime(msg.created_at)}
              </span>

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 8,
                  flexDirection: msg.role === "user" ? "row-reverse" : "row",
                  maxWidth: "80%",
                }}
              >
                {/* Bubble */}
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                    background:
                      msg.role === "user"
                        ? "linear-gradient(135deg, #2563eb, #3b82f6)"
                        : "rgba(31,41,55,0.9)",
                    border:
                      msg.role === "user"
                        ? "none"
                        : "1px solid var(--border)",
                    color: msg.role === "user" ? "#fff" : "#e5e7eb",
                    fontSize: 15,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    boxShadow: msg.role === "user"
                      ? "0 4px 12px rgba(37,99,235,0.3)"
                      : "0 4px 12px rgba(0,0,0,0.2)",
                  }}
                >
                  {msg.content}

                  {/* Metadata badges for assistant */}
                  {msg.role === "assistant" && msg.metadata && (
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      {typeof msg.metadata.model === "string" && (
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "rgba(55,65,81,0.8)",
                            border: "1px solid #4b5563",
                            color: "var(--muted-foreground)",
                            fontSize: 11,
                            fontFamily: "monospace",
                          }}
                        >
                          {msg.metadata.model}
                        </span>
                      )}
                      {typeof msg.metadata.route === "string" && (
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "rgba(34,197,94,0.1)",
                            border: "1px solid rgba(34,197,94,0.25)",
                            color: "#4ade80",
                            fontSize: 11,
                          }}
                        >
                          {msg.metadata.route}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Create rule button for assistant messages */}
                {msg.role === "assistant" && (
                  <button
                    onClick={() => handleCreateRule(msg)}
                    title={t("chat_history.create_rule")}
                    style={{
                      padding: "6px 10px",
                      minHeight: 44,
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      color: "var(--muted-foreground)",
                      fontSize: 13,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      transition: "border-color 0.15s, color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      const btn = e.currentTarget as HTMLButtonElement;
                      btn.style.borderColor = "#4b5563";
                      btn.style.color = "#e5e7eb";
                    }}
                    onMouseLeave={(e) => {
                      const btn = e.currentTarget as HTMLButtonElement;
                      btn.style.borderColor = "#374151";
                      btn.style.color = "#9ca3af";
                    }}
                  >
                    🎛️
                  </button>
                )}
              </div>
            </div>
          ))}
          {/* Judge評価セクション */}
          <div
            style={{
              marginTop: 8,
              padding: "20px 18px",
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "linear-gradient(145deg, var(--card), var(--card))",
            }}
          >
            <p style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>
              🤖 AI品質評価 (Judge)
            </p>
            {evaluation == null ? (
              <span style={{
                display: "inline-flex", alignItems: "center", padding: "4px 12px",
                borderRadius: 999, fontSize: 12, fontWeight: 700,
                background: "rgba(107,114,128,0.15)", border: "1px solid rgba(107,114,128,0.3)", color: "var(--muted-foreground)",
              }}>未評価</span>
            ) : (() => {
              const overall = evaluation.overall_score ?? evaluation.score;
              const scoreColor = overall >= 80 ? "#4ade80" : overall >= 60 ? "#fbbf24" : "#f87171";
              const scoreBg = overall >= 80 ? "rgba(34,197,94,0.15)" : overall >= 60 ? "rgba(251,191,36,0.15)" : "rgba(248,113,113,0.15)";
              const scoreBorder = overall >= 80 ? "rgba(34,197,94,0.3)" : overall >= 60 ? "rgba(251,191,36,0.3)" : "rgba(248,113,113,0.3)";
              const AXES = [
                { key: "psychology_fit_score" as const, label: "心理対応力" },
                { key: "customer_reaction_score" as const, label: "顧客対応力" },
                { key: "stage_progress_score" as const, label: "商談進行力" },
                { key: "taboo_violation_score" as const, label: "禁止事項の遵守率" },
              ];
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 14px",
                    borderRadius: 999, fontSize: 15, fontWeight: 700,
                    background: scoreBg, border: `1px solid ${scoreBorder}`, color: scoreColor,
                    width: "fit-content",
                  }}>
                    総合スコア {overall}/100
                  </span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {AXES.map(({ key, label }) => {
                      const s = evaluation[key];
                      if (s == null) return null;
                      const c = s >= 80 ? "#4ade80" : s >= 60 ? "#fbbf24" : "#f87171";
                      return (
                        <span key={key} style={{
                          padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                          background: "rgba(31,41,55,0.8)", border: "1px solid var(--border)", color: c,
                        }}>
                          {label}: {s}
                        </span>
                      );
                    })}
                  </div>
                  {evaluation.feedback?.summary && (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.6, padding: "10px 12px", borderRadius: 8, background: "rgba(31,41,55,0.6)", border: "1px solid var(--border)" }}>
                      {evaluation.feedback.summary}
                    </p>
                  )}
                  {isSuperAdmin && Array.isArray(evaluation.suggested_rules) && evaluation.suggested_rules.length > 0 && (
                    <SuggestedRulesCard
                      evaluationId={evaluation.id}
                      rules={evaluation.suggested_rules}
                      onUpdate={(updated) => setEvaluation((prev) => prev ? { ...prev, suggested_rules: updated } : prev)}
                    />
                  )}
                </div>
              );
            })()}
          </div>

          {/* 営業結果入力（Client Adminのみ表示） */}
          {!isSuperAdmin && <div
            style={{
              marginTop: 8,
              padding: "20px 18px",
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "linear-gradient(145deg, var(--card), var(--card))",
            }}
          >
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--foreground)",
              }}
            >
              この会話の営業結果を記録
            </p>
            {/* 記録済み情報 */}
            {outcome && outcomeRecordedAt && (
              <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(5,46,22,0.4)", border: "1px solid rgba(74,222,128,0.2)", fontSize: 12, color: "#86efac" }}>
                ✓ 記録済み: {new Date(outcomeRecordedAt).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {outcomeRecordedBy && ` by ${outcomeRecordedBy}`}
                <button
                  onClick={() => { setOutcome(null); setOutcomeRecordedAt(null); setOutcomeRecordedBy(null); }}
                  style={{ marginLeft: 8, background: "none", border: "none", color: "#4ade80", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  変更
                </button>
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 10,
              }}
            >
              {conversionTypes.map((value) => (
                <button
                  key={value}
                  onClick={() => void handleOutcome(value)}
                  disabled={outcomeSubmitting}
                  style={{
                    padding: "14px 12px",
                    minHeight: 52,
                    borderRadius: 10,
                    border:
                      outcome === value
                        ? "1px solid rgba(74,222,128,0.5)"
                        : "1px solid var(--border)",
                    background:
                      outcome === value
                        ? "rgba(34,197,94,0.2)"
                        : "rgba(31,41,55,0.5)",
                    color: outcome === value ? "#4ade80" : "#9ca3af",
                    fontSize: 15,
                    fontWeight: outcome === value ? 700 : 500,
                    cursor: outcomeSubmitting ? "not-allowed" : "pointer",
                    opacity: outcomeSubmitting && outcome !== value ? 0.6 : 1,
                    transition: "all 0.15s",
                    width: "100%",
                  }}
                >
                  {outcome === value ? `✓ ${value}` : value}
                </button>
              ))}
            </div>
          </div>}
        </div>
      )}
    </div>
  );
}
