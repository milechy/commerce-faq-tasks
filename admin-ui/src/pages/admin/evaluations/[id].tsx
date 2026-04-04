import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useLang } from "../../../i18n/LangContext";
import LangSwitcher from "../../../components/LangSwitcher";
import { authFetch, API_BASE } from "../../../lib/api";
import { useAuth } from "../../../auth/useAuth";

interface Evaluation {
  id: number;
  tenant_id: string;
  session_id: string;
  overall_score?: number;
  score: number;
  psychology_fit_score?: number;
  customer_reaction_score?: number;
  stage_progress_score?: number;
  taboo_violation_score?: number;
  feedback?: { summary?: string };
  suggested_rules?: Array<{ rule_text: string; reason: string; priority: string; status?: string }>;
  judge_model?: string;
  evaluated_at: string;
  model_used?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

function ScoreBadge({ score, large }: { score: number; large?: boolean }) {
  const cfg =
    score >= 80
      ? { bg: "rgba(34,197,94,0.15)", border: "rgba(34,197,94,0.3)", color: "#4ade80", label: "良好" }
      : score >= 60
      ? { bg: "rgba(251,191,36,0.15)", border: "rgba(251,191,36,0.3)", color: "#fbbf24", label: "許容" }
      : { bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)", color: "#f87171", label: "要改善" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: large ? 6 : 4,
        padding: large ? "6px 16px" : "3px 10px",
        borderRadius: 999,
        fontSize: large ? 18 : 12,
        fontWeight: 700,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        color: cfg.color,
        whiteSpace: "nowrap",
      }}
    >
      {score} <span style={{ fontSize: large ? 12 : 10, opacity: 0.8 }}>{cfg.label}</span>
    </span>
  );
}

function AxisBar({ label, score, color }: { label: string; score: number; color: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: "#9ca3af" }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{score}</span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "rgba(255,255,255,0.1)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${score}%`,
            background: color,
            borderRadius: 3,
            transition: "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}

export default function EvaluationDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { lang } = useLang();
  const { isSuperAdmin, isClientAdmin } = useAuth();

  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<
    Record<number, "approving" | "rejecting" | "done" | null>
  >({});
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editedText, setEditedText] = useState<string>("");

  const locale = lang === "en" ? "en-US" : "ja-JP";

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/evaluations/by-id/${id}`);
        if (!res.ok) throw new Error("Failed to fetch evaluation");
        const data = (await res.json()) as { evaluation: Evaluation; messages: Message[] };
        setEvaluation(data.evaluation);
        setMessages(data.messages ?? []);
      } catch {
        setError("データの取得に失敗しました");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id]);

  async function handleRuleAction(
    ruleIndex: number,
    action: "approve" | "reject",
    editedTextParam?: string,
  ) {
    setActionStatus((prev) => ({
      ...prev,
      [ruleIndex]: action === "approve" ? "approving" : "rejecting",
    }));
    try {
      const body: Record<string, unknown> = { action };
      if (editedTextParam) body.edited_text = editedTextParam;

      const res = await authFetch(
        `${API_BASE}/v1/admin/evaluations/${id}/rules/${ruleIndex}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        setEvaluation((prev) =>
          prev
            ? {
                ...prev,
                suggested_rules: prev.suggested_rules?.map((r, i) =>
                  i === ruleIndex
                    ? { ...r, status: action === "approve" ? "approved" : "rejected" }
                    : r
                ),
              }
            : prev
        );
        setActionStatus((prev) => ({ ...prev, [ruleIndex]: "done" }));
        setEditingRuleId(null);
      }
    } catch {
      // silent
    }
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const ev = evaluation;
  const displayScore = ev ? (ev.overall_score ?? ev.score) : 0;

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
            onClick={() => navigate("/admin/evaluations")}
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
            ← AI評価一覧へ戻る
          </button>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f9fafb" }}>
            AI評価詳細
          </h1>
        </div>
        <LangSwitcher />
      </header>

      {/* Error */}
      {error && (
        <div
          style={{
            marginBottom: 20,
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

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
          <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
          読み込み中...
        </div>
      ) : ev ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Section 1: Overall score + axis bars */}
          <div
            style={{
              borderRadius: 14,
              border: "1px solid #1f2937",
              background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
              padding: "18px 20px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                marginBottom: 20,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 6 }}>総合スコア</div>
                <ScoreBadge score={displayScore} large />
              </div>
              <div>
                <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 4 }}>AI審査員</div>
                <span style={{ fontSize: 14, color: "#e5e7eb" }}>
                  {ev.judge_model ?? ev.model_used ?? "AI審査員"}
                </span>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <div style={{ fontSize: 12, color: "#6b7280" }}>評価日時</div>
                <span style={{ fontSize: 13, color: "#9ca3af" }}>
                  {formatDate(ev.evaluated_at)}
                </span>
              </div>
            </div>
            <AxisBar
              label="心理テクニック"
              score={ev.psychology_fit_score ?? 0}
              color="#60a5fa"
            />
            <AxisBar
              label="顧客対応"
              score={ev.customer_reaction_score ?? 0}
              color="#4ade80"
            />
            <AxisBar
              label="商談進行"
              score={ev.stage_progress_score ?? 0}
              color="#fbbf24"
            />
            <AxisBar
              label="NG行為チェック"
              score={ev.taboo_violation_score ?? 0}
              color="#a78bfa"
            />
          </div>

          {/* Section 2: Feedback summary */}
          {ev.feedback?.summary && (
            <div
              style={{
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                padding: "18px 20px",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#f9fafb",
                  marginBottom: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>📋</span> Judge総評
              </div>
              <p style={{ fontSize: 14, color: "#e5e7eb", lineHeight: 1.7, margin: 0 }}>
                {ev.feedback.summary}
              </p>
            </div>
          )}

          {/* Section 3: Conversation messages */}
          {messages.length > 0 && (
            <div
              style={{
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                padding: "18px 20px",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#f9fafb",
                  marginBottom: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>💬</span> 会話ログ
              </div>
              <div>
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "75%",
                        padding: "10px 14px",
                        borderRadius:
                          msg.role === "user"
                            ? "18px 18px 4px 18px"
                            : "18px 18px 18px 4px",
                        background:
                          msg.role === "user"
                            ? "rgba(59,130,246,0.2)"
                            : "rgba(15,23,42,0.8)",
                        border: `1px solid ${
                          msg.role === "user"
                            ? "rgba(59,130,246,0.3)"
                            : "#1f2937"
                        }`,
                        color: "#e5e7eb",
                        fontSize: 14,
                        lineHeight: 1.6,
                        wordBreak: "break-word",
                      }}
                    >
                      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>
                        {msg.role === "user" ? "👤 ユーザー" : "🤖 AI"}
                      </div>
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section 4: Suggested rules */}
          {(ev.suggested_rules?.length ?? 0) > 0 && (
            <div
              style={{
                borderRadius: 14,
                border: "1px solid #1f2937",
                background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
                padding: "18px 20px",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "#f9fafb",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>🎯</span> AI提案ルール
              </div>
              <p style={{ fontSize: 13, color: "#9ca3af", marginBottom: 16 }}>
                このルールを承認すると今後のAI応答に反映されます。承認前に内容をご確認ください。
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {ev.suggested_rules?.map((rule, ruleIndex) => {
                  const priorityCfg =
                    rule.priority === "high"
                      ? {
                          bg: "rgba(248,113,113,0.15)",
                          border: "rgba(248,113,113,0.3)",
                          color: "#f87171",
                          label: "重要度：高",
                        }
                      : rule.priority === "medium"
                      ? {
                          bg: "rgba(251,191,36,0.15)",
                          border: "rgba(251,191,36,0.3)",
                          color: "#fbbf24",
                          label: "重要度：中",
                        }
                      : {
                          bg: "rgba(107,114,128,0.15)",
                          border: "rgba(107,114,128,0.3)",
                          color: "#9ca3af",
                          label: "重要度：低",
                        };

                  const status = rule.status;
                  const currentAction = actionStatus[ruleIndex];
                  const isApproved = status === "approved";
                  const isRejected = status === "rejected";

                  return (
                    <div
                      key={ruleIndex}
                      style={{
                        borderRadius: 10,
                        border: "1px solid #374151",
                        padding: "14px 16px",
                        background: "rgba(15,23,42,0.5)",
                        opacity: isRejected ? 0.6 : 1,
                      }}
                    >
                      <div style={{ marginBottom: 8 }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            background: priorityCfg.bg,
                            border: `1px solid ${priorityCfg.border}`,
                            color: priorityCfg.color,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {priorityCfg.label}
                        </span>
                      </div>
                      <p
                        style={{
                          fontSize: 14,
                          color: "#e5e7eb",
                          margin: "0 0 8px 0",
                          lineHeight: 1.6,
                          textDecoration: isRejected ? "line-through" : "none",
                        }}
                      >
                        {rule.rule_text}
                      </p>
                      <p style={{ fontSize: 13, color: "#9ca3af", margin: "0 0 12px 0" }}>
                        理由: {rule.reason}
                      </p>

                      {isApproved ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "4px 12px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 700,
                            background: "rgba(34,197,94,0.15)",
                            border: "1px solid rgba(34,197,94,0.3)",
                            color: "#4ade80",
                          }}
                        >
                          承認済み ✓
                        </span>
                      ) : isRejected ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "4px 12px",
                            borderRadius: 999,
                            fontSize: 12,
                            fontWeight: 700,
                            background: "rgba(248,113,113,0.1)",
                            border: "1px solid rgba(248,113,113,0.3)",
                            color: "#f87171",
                          }}
                        >
                          却下済み ✗
                        </span>
                      ) : (isSuperAdmin || isClientAdmin) ? (
                        editingRuleId === ruleIndex ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <textarea
                              value={editedText}
                              onChange={(e) => setEditedText(e.target.value)}
                              placeholder="提案内容を編集してください"
                              style={{
                                width: "100%",
                                minHeight: 80,
                                padding: "10px 12px",
                                borderRadius: 8,
                                border: "1px solid rgba(59,130,246,0.5)",
                                background: "rgba(15,23,42,0.8)",
                                color: "#e5e7eb",
                                fontSize: 14,
                                lineHeight: 1.6,
                                resize: "vertical",
                                boxSizing: "border-box",
                              }}
                            />
                            <div style={{ display: "flex", gap: 8 }}>
                              <button
                                onClick={() =>
                                  void handleRuleAction(ruleIndex, "approve", editedText.trim())
                                }
                                disabled={currentAction != null || editedText.trim() === ""}
                                style={{
                                  padding: "8px 16px",
                                  minHeight: 40,
                                  borderRadius: 8,
                                  border: "1px solid rgba(34,197,94,0.3)",
                                  background: "rgba(34,197,94,0.15)",
                                  color: "#4ade80",
                                  fontSize: 13,
                                  fontWeight: 600,
                                  cursor:
                                    currentAction != null || editedText.trim() === ""
                                      ? "not-allowed"
                                      : "pointer",
                                  opacity:
                                    currentAction != null || editedText.trim() === "" ? 0.6 : 1,
                                }}
                              >
                                {currentAction === "approving" ? "処理中..." : "保存して承認 ✓"}
                              </button>
                              <button
                                onClick={() => setEditingRuleId(null)}
                                disabled={currentAction != null}
                                style={{
                                  padding: "8px 16px",
                                  minHeight: 40,
                                  borderRadius: 8,
                                  border: "1px solid rgba(107,114,128,0.3)",
                                  background: "rgba(107,114,128,0.1)",
                                  color: "#9ca3af",
                                  fontSize: 13,
                                  fontWeight: 600,
                                  cursor: currentAction != null ? "not-allowed" : "pointer",
                                  opacity: currentAction != null ? 0.6 : 1,
                                }}
                              >
                                キャンセル
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={() => void handleRuleAction(ruleIndex, "approve")}
                              disabled={currentAction != null}
                              style={{
                                padding: "8px 16px",
                                minHeight: 40,
                                borderRadius: 8,
                                border: "1px solid rgba(34,197,94,0.3)",
                                background: "rgba(34,197,94,0.15)",
                                color: "#4ade80",
                                fontSize: 13,
                                fontWeight: 600,
                                cursor: currentAction != null ? "not-allowed" : "pointer",
                                opacity: currentAction != null ? 0.6 : 1,
                              }}
                            >
                              {currentAction === "approving" ? "処理中..." : "承認する ✓"}
                            </button>
                            <button
                              onClick={() => {
                                setEditingRuleId(ruleIndex);
                                setEditedText(rule.rule_text);
                              }}
                              disabled={currentAction != null}
                              style={{
                                padding: "8px 16px",
                                minHeight: 40,
                                borderRadius: 8,
                                border: "1px solid rgba(59,130,246,0.3)",
                                background: "rgba(59,130,246,0.08)",
                                color: "#60a5fa",
                                fontSize: 13,
                                fontWeight: 600,
                                cursor: currentAction != null ? "not-allowed" : "pointer",
                                opacity: currentAction != null ? 0.6 : 1,
                              }}
                            >
                              編集して承認 ✏️
                            </button>
                            <button
                              onClick={() => void handleRuleAction(ruleIndex, "reject")}
                              disabled={currentAction != null}
                              style={{
                                padding: "8px 16px",
                                minHeight: 40,
                                borderRadius: 8,
                                border: "1px solid rgba(248,113,113,0.3)",
                                background: "rgba(248,113,113,0.08)",
                                color: "#f87171",
                                fontSize: 13,
                                fontWeight: 600,
                                cursor: currentAction != null ? "not-allowed" : "pointer",
                                opacity: currentAction != null ? 0.6 : 1,
                              }}
                            >
                              {currentAction === "rejecting" ? "処理中..." : "却下する ✗"}
                            </button>
                          </div>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
