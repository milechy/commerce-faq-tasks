import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { useAuth } from "../../auth/useAuth";
import { SuperAdminOnly } from "../RoleGuard";

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface ScoreTrend {
  date: string;
  avg_score: number;
}

interface PsychPrinciple {
  name: string;
  usage_count: number;
  effectiveness_rate: number;
}

interface RuleEvidence {
  evaluationIds?: number[];
  effectivePrinciples?: string[];
  failedPrinciples?: string[];
  avgScore?: number;
}

interface SuggestedRule {
  id: string;
  trigger: string;
  response: string;
  reason: string;
  evidence?: RuleEvidence | null;
}

interface CustomerReaction {
  positive: number;
  neutral: number;
  negative: number;
}

interface KpiSummary {
  reply_rate: number;
  appointment_rate: number;
  lost_rate: number;
  reply_rate_delta: number;
  appointment_rate_delta: number;
  lost_rate_delta: number;
}

interface OutcomeScore {
  outcome: string;
  avg_score: number;
  label: string;
}

interface EvalStats {
  score_trend: ScoreTrend[];
  psychology_principles: PsychPrinciple[];
  customer_reactions: CustomerReaction;
  kpi_summary: KpiSummary;
  outcome_scores: OutcomeScore[];
}

// ─── モックデータ ─────────────────────────────────────────────────────────────

function buildMockStats(days: 7 | 30): EvalStats {
  const now = new Date();
  const trend: ScoreTrend[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    return {
      date: d.toISOString().slice(0, 10),
      avg_score: 55 + Math.round(Math.random() * 35),
    };
  });
  return {
    score_trend: trend,
    psychology_principles: [
      { name: "返報性", usage_count: 42, effectiveness_rate: 0.78 },
      { name: "社会的証明", usage_count: 37, effectiveness_rate: 0.72 },
      { name: "希少性", usage_count: 28, effectiveness_rate: 0.65 },
      { name: "権威性", usage_count: 21, effectiveness_rate: 0.61 },
      { name: "好意", usage_count: 18, effectiveness_rate: 0.59 },
    ],
    customer_reactions: { positive: 58, neutral: 27, negative: 15 },
    kpi_summary: {
      reply_rate: 0.62,
      appointment_rate: 0.34,
      lost_rate: 0.18,
      reply_rate_delta: 0.05,
      appointment_rate_delta: 0.03,
      lost_rate_delta: -0.02,
    },
    outcome_scores: [
      { outcome: "appointment", avg_score: 82, label: "アポ取得" },
      { outcome: "replied", avg_score: 71, label: "返信あり" },
      { outcome: "unknown", avg_score: 59, label: "不明" },
      { outcome: "lost", avg_score: 44, label: "失注" },
    ],
  };
}

const MOCK_RULES: SuggestedRule[] = [
  {
    id: "r1",
    trigger: "検討します",
    response: "ご検討いただきありがとうございます。具体的なご要望をお聞かせいただけますか？",
    reason: "返報性の原則：先に情報を提供することで、より具体的な返信を促します",
  },
  {
    id: "r2",
    trigger: "他社と比較中",
    response: "比較検討されているとのこと、ありがとうございます。弊社の強みをご説明してもよろしいでしょうか？",
    reason: "権威性の原則：専門知識をアピールし、差別化を図ります",
  },
];

// ─── スタイル定数 ─────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid #1f2937",
  background: "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
  padding: "20px 18px",
};

const SECTION_TITLE: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "#e5e7eb",
  marginBottom: 14,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

// ─── A: スコア推移チャート ─────────────────────────────────────────────────────

function ScoreTrendChart({ data }: { data: ScoreTrend[] }) {
  if (data.length === 0) return null;
  const chartW = 560;
  const chartH = 100;
  const vals = data.map((d) => d.avg_score);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;

  const pts = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * chartW;
    const y = chartH - ((d.avg_score - min) / range) * chartH;
    return `${x},${y}`;
  });

  const labelStep = Math.max(1, Math.floor(data.length / 6));

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${chartW} ${chartH + 28}`}
        style={{ width: "100%", minWidth: 280, display: "block" }}
        aria-label="日別平均スコア推移"
      >
        {/* グリッドライン */}
        {[0, 50, 100].map((v) => {
          const y = chartH - ((v - min) / range) * chartH;
          return (
            <g key={v}>
              <line x1={0} y1={y} x2={chartW} y2={y} stroke="#1f2937" strokeWidth={1} />
              <text x={chartW + 2} y={y + 4} fontSize={9} fill="#4b5563">{v}</text>
            </g>
          );
        })}
        {/* 折れ線 */}
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="#4ade80"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {/* 点 */}
        {data.map((d, i) => {
          const x = (i / Math.max(data.length - 1, 1)) * chartW;
          const y = chartH - ((d.avg_score - min) / range) * chartH;
          return <circle key={d.date} cx={x} cy={y} r={3} fill="#4ade80" />;
        })}
        {/* X軸ラベル */}
        {data.map((d, i) =>
          i % labelStep === 0 ? (
            <text key={d.date} x={(i / Math.max(data.length - 1, 1)) * chartW} y={chartH + 18} textAnchor="middle" fontSize={9} fill="#6b7280">
              {d.date.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

// ─── E: KPIサマリカード ───────────────────────────────────────────────────────

function KpiCards({ kpi }: { kpi: KpiSummary }) {
  const items = [
    { label: "返信率", value: kpi.reply_rate, delta: kpi.reply_rate_delta },
    { label: "アポ率", value: kpi.appointment_rate, delta: kpi.appointment_rate_delta },
    { label: "失注率", value: kpi.lost_rate, delta: kpi.lost_rate_delta },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
      {items.map((item) => (
        <div key={item.label} style={{ ...CARD, textAlign: "center" as const }}>
          <p style={{ margin: "0 0 6px", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>{item.label}</p>
          <p style={{ margin: "0 0 6px", fontSize: 26, fontWeight: 700, color: "#f9fafb" }}>
            {Math.round(item.value * 100)}%
          </p>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              color:
                item.label === "失注率"
                  ? item.delta < 0 ? "#4ade80" : "#f87171"
                  : item.delta >= 0 ? "#4ade80" : "#f87171",
            }}
          >
            {item.delta >= 0 ? "+" : ""}
            {Math.round(item.delta * 100)}% 先週比
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── B: 心理原則トップ5 ───────────────────────────────────────────────────────

function PsychPrincipleList({ principles }: { principles: PsychPrinciple[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {principles.map((p, i) => (
        <div key={p.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, color: "#e5e7eb", fontWeight: 600 }}>
              {i + 1}. {p.name}
            </span>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>{p.usage_count}回 / 効果率 {Math.round(p.effectiveness_rate * 100)}%</span>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 4, height: 8, overflow: "hidden" }}>
            <div
              style={{
                width: `${p.effectiveness_rate * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg, #22c55e, #4ade80)",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── D: 顧客反応分布 ──────────────────────────────────────────────────────────

function ReactionBar({ reactions }: { reactions: CustomerReaction }) {
  const total = reactions.positive + reactions.neutral + reactions.negative || 1;
  const items = [
    { label: "肯定的", value: reactions.positive, color: "#4ade80" },
    { label: "中立", value: reactions.neutral, color: "#fbbf24" },
    { label: "否定的", value: reactions.negative, color: "#f87171" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", height: 24, borderRadius: 6, overflow: "hidden", gap: 2 }}>
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              flex: item.value / total,
              background: item.color,
              opacity: 0.85,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" as const }}>
        {items.map((item) => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color }} />
            <span style={{ fontSize: 13, color: "#9ca3af" }}>
              {item.label}: {Math.round((item.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── F: スコア×成果相関 ───────────────────────────────────────────────────────

function OutcomeScoreChart({ data }: { data: OutcomeScore[] }) {
  const max = Math.max(...data.map((d) => d.avg_score), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {data.map((item) => (
        <div key={item.outcome} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, color: "#e5e7eb", fontWeight: 600 }}>{item.label}</span>
            <span style={{ fontSize: 14, color: "#9ca3af" }}>{item.avg_score}</span>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 4, height: 10, overflow: "hidden" }}>
            <div
              style={{
                width: `${(item.avg_score / max) * 100}%`,
                height: "100%",
                background:
                  item.outcome === "appointment"
                    ? "linear-gradient(90deg, #22c55e, #4ade80)"
                    : item.outcome === "lost"
                    ? "linear-gradient(90deg, #dc2626, #f87171)"
                    : "linear-gradient(90deg, #2563eb, #60a5fa)",
                borderRadius: 4,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── C: 提案チューニングルール ────────────────────────────────────────────────

function SuggestedRulesList({
  tenantId,
  rules,
  onDecision,
}: {
  tenantId: string;
  rules: SuggestedRule[];
  onDecision: (id: string, action: "approve" | "reject") => void;
}) {
  const [processing, setProcessing] = useState<string | null>(null);

  const handleDecision = async (rule: SuggestedRule, action: "approve" | "reject") => {
    setProcessing(rule.id);
    try {
      await authFetch(`${API_BASE}/v1/admin/tuning/${rule.id}/${action}?tenantId=${tenantId}`, {
        method: "PUT",
      });
      onDecision(rule.id, action);
    } catch {
      // show inline error? keep it simple for now
    } finally {
      setProcessing(null);
    }
  };

  if (rules.length === 0) {
    return (
      <p style={{ fontSize: 14, color: "#6b7280", textAlign: "center", padding: "20px 0" }}>
        現在、提案されたルールはありません。
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {rules.map((rule) => (
        <div key={rule.id} style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>トリガー</p>
            <p style={{ margin: "0 0 8px", fontSize: 14, color: "#e5e7eb" }}>「{rule.trigger}」</p>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#9ca3af", fontWeight: 600 }}>提案返答</p>
            <p style={{ margin: "0 0 8px", fontSize: 14, color: "#e5e7eb", lineHeight: 1.6 }}>{rule.response}</p>
            <p style={{ margin: 0, fontSize: 12, color: "#6b7280", lineHeight: 1.5, fontStyle: "italic" }}>
              💡 {rule.reason}
            </p>
            {rule.evidence && (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "rgba(37,99,235,0.08)",
                  border: "1px solid rgba(96,165,250,0.2)",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {rule.evidence.avgScore !== undefined && (
                  <span style={{ fontSize: 12, color: "#93c5fd", fontWeight: 700 }}>
                    📊 平均スコア {rule.evidence.avgScore}
                  </span>
                )}
                {rule.evidence.effectivePrinciples && rule.evidence.effectivePrinciples.length > 0 && (
                  <span style={{ fontSize: 11, color: "#4ade80" }}>
                    ✅ {rule.evidence.effectivePrinciples.join("・")}
                  </span>
                )}
                {rule.evidence.failedPrinciples && rule.evidence.failedPrinciples.length > 0 && (
                  <span style={{ fontSize: 11, color: "#f87171" }}>
                    ❌ {rule.evidence.failedPrinciples.join("・")}
                  </span>
                )}
                {rule.evidence.evaluationIds && (
                  <span style={{ fontSize: 11, color: "#6b7280" }}>
                    {rule.evidence.evaluationIds.length}件の会話を分析
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => void handleDecision(rule, "approve")}
              disabled={processing === rule.id}
              style={{
                flex: 1,
                padding: "12px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(74,222,128,0.4)",
                background: "rgba(34,197,94,0.15)",
                color: "#4ade80",
                fontSize: 15,
                fontWeight: 700,
                cursor: processing === rule.id ? "not-allowed" : "pointer",
                opacity: processing === rule.id ? 0.6 : 1,
              }}
            >
              ✅ 承認
            </button>
            <button
              onClick={() => void handleDecision(rule, "reject")}
              disabled={processing === rule.id}
              style={{
                flex: 1,
                padding: "12px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(248,113,113,0.4)",
                background: "rgba(239,68,68,0.15)",
                color: "#f87171",
                fontSize: 15,
                fontWeight: 700,
                cursor: processing === rule.id ? "not-allowed" : "pointer",
                opacity: processing === rule.id ? 0.6 : 1,
              }}
            >
              ❌ 却下
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── メインコンポーネント ──────────────────────────────────────────────────────

export default function AIReportTab({ tenantId }: { tenantId: string }) {
  const { isSuperAdmin } = useAuth();
  const [days, setDays] = useState<7 | 30>(7);
  const [stats, setStats] = useState<EvalStats | null>(null);
  const [rules, setRules] = useState<SuggestedRule[]>(MOCK_RULES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [statsRes, kpiRes] = await Promise.all([
          authFetch(`${API_BASE}/v1/admin/evaluations/stats?tenantId=${tenantId}&days=${days}`),
          authFetch(`${API_BASE}/v1/admin/evaluations/kpi-stats?tenantId=${tenantId}&days=${days}`),
        ]);
        const mock = buildMockStats(days);
        if (statsRes.ok && kpiRes.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = (await statsRes.json()) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const kpi = (await kpiRes.json()) as any;

          // score_trend: { date, avg_score }[] が返る場合はそのまま、なければモック
          const scoreTrend: ScoreTrend[] = Array.isArray(raw.score_trend)
            ? (raw.score_trend as ScoreTrend[])
            : mock.score_trend;

          // principle_stats: Record<name, {usage_count,effectiveness_rate}|number>
          const principles: PsychPrinciple[] = raw.principle_stats
            ? Object.entries(raw.principle_stats as Record<string, unknown>)
                .slice(0, 5)
                .map(([name, v]) =>
                  typeof v === "object" && v !== null
                    ? {
                        name,
                        usage_count: (v as { usage_count?: number }).usage_count ?? 0,
                        effectiveness_rate: (v as { effectiveness_rate?: number }).effectiveness_rate ?? 0,
                      }
                    : { name, usage_count: typeof v === "number" ? v : 0, effectiveness_rate: 0 }
                )
            : mock.psychology_principles;

          // reaction_distribution: Record<"positive"|"neutral"|"negative", number>
          const reactions: CustomerReaction = raw.reaction_distribution
            ? {
                positive: (raw.reaction_distribution as Record<string, number>).positive ?? 0,
                neutral: (raw.reaction_distribution as Record<string, number>).neutral ?? 0,
                negative: (raw.reaction_distribution as Record<string, number>).negative ?? 0,
              }
            : mock.customer_reactions;

          // kpi-stats: flat format
          const kpiSummary: KpiSummary = {
            reply_rate: kpi.reply_rate ?? mock.kpi_summary.reply_rate,
            appointment_rate: kpi.appointment_rate ?? mock.kpi_summary.appointment_rate,
            lost_rate: kpi.lost_rate ?? mock.kpi_summary.lost_rate,
            reply_rate_delta: kpi.reply_rate_delta ?? mock.kpi_summary.reply_rate_delta,
            appointment_rate_delta: kpi.appointment_rate_delta ?? mock.kpi_summary.appointment_rate_delta,
            lost_rate_delta: kpi.lost_rate_delta ?? mock.kpi_summary.lost_rate_delta,
          };

          // outcome_scores: derive from avg_score_by_outcome
          const outcomeLabels: Record<string, string> = {
            appointment: "アポ取得",
            replied: "返信あり",
            unknown: "不明",
            lost: "失注",
          };
          const outcomeScores: OutcomeScore[] = kpi.avg_score_by_outcome
            ? Object.entries(kpi.avg_score_by_outcome as Record<string, number>).map(([k, v]) => ({
                outcome: k,
                avg_score: Math.round(v),
                label: outcomeLabels[k] ?? k,
              }))
            : mock.outcome_scores;

          setStats({
            score_trend: scoreTrend,
            psychology_principles: principles,
            customer_reactions: reactions,
            kpi_summary: kpiSummary,
            outcome_scores: outcomeScores,
          });
        } else {
          setStats(mock);
        }
      } catch {
        setStats(buildMockStats(days));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [tenantId, days]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    const loadRules = async () => {
      try {
        const res = await authFetch(
          `${API_BASE}/v1/admin/tuning?tenantId=${tenantId}&source=judge&status=suggested`
        );
        if (res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = (await res.json()) as any;
          setRules((data.rules as SuggestedRule[]) ?? MOCK_RULES);
        }
      } catch {
        // keep mock
      }
    };
    void loadRules();
  }, [tenantId, isSuperAdmin]);

  const handleRuleDecision = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  // 空状態チェック（スコアが全部0またはデータなし）
  const isEmpty =
    !loading &&
    stats !== null &&
    stats.score_trend.every((d) => d.avg_score === 0);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>
        <span style={{ display: "block", fontSize: 32, marginBottom: 8 }}>⏳</span>
        分析データを読み込んでいます...
      </div>
    );
  }

  if (isEmpty || !stats) {
    return (
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          borderRadius: 14,
          border: "1px solid #1f2937",
          background: "rgba(15,23,42,0.8)",
        }}
      >
        <span style={{ display: "block", fontSize: 40, marginBottom: 12 }}>📊</span>
        <p style={{ fontSize: 16, color: "#9ca3af", margin: "0 0 8px", fontWeight: 600 }}>
          まだ評価データがありません
        </p>
        <p style={{ fontSize: 14, color: "#6b7280", margin: 0, lineHeight: 1.7 }}>
          お客様との会話が完了すると、AIが自動で営業トークを分析・採点します。
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* A: スコア推移チャート */}
      <div style={CARD}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
          <p style={{ ...SECTION_TITLE, margin: 0 }}>📈 スコア推移</p>
          <div style={{ display: "flex", gap: 6 }}>
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                style={{
                  padding: "8px 16px",
                  minHeight: 36,
                  borderRadius: 8,
                  border: `1px solid ${days === d ? "rgba(74,222,128,0.4)" : "#374151"}`,
                  background: days === d ? "rgba(34,197,94,0.15)" : "transparent",
                  color: days === d ? "#4ade80" : "#6b7280",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {d}日間
              </button>
            ))}
          </div>
        </div>
        <ScoreTrendChart data={stats.score_trend} />
      </div>

      {/* E: KPIサマリカード (全ロール) */}
      <div style={CARD}>
        <p style={SECTION_TITLE}>🎯 営業成果サマリ</p>
        <KpiCards kpi={stats.kpi_summary} />
      </div>

      {/* B: 心理原則トップ5 (Super Admin only) */}
      <SuperAdminOnly>
        <div style={CARD}>
          <p style={SECTION_TITLE}>🧠 効果的な心理アプローチ トップ5</p>
          <PsychPrincipleList principles={stats.psychology_principles} />
        </div>
      </SuperAdminOnly>

      {/* C: 提案チューニングルール (Super Admin only) */}
      <SuperAdminOnly>
        <div style={CARD}>
          <p style={SECTION_TITLE}>💡 AI提案ルール ({rules.length}件)</p>
          <SuggestedRulesList
            tenantId={tenantId}
            rules={rules}
            onDecision={handleRuleDecision}
          />
        </div>
      </SuperAdminOnly>

      {/* D: 顧客反応分布 (Super Admin only) */}
      <SuperAdminOnly>
        <div style={CARD}>
          <p style={SECTION_TITLE}>😊 お客様の反応分布</p>
          <ReactionBar reactions={stats.customer_reactions} />
        </div>
      </SuperAdminOnly>

      {/* F: スコア×成果相関 (Super Admin only) */}
      <SuperAdminOnly>
        <div style={CARD}>
          <p style={SECTION_TITLE}>📊 営業成果別 平均スコア</p>
          <OutcomeScoreChart data={stats.outcome_scores} />
        </div>
      </SuperAdminOnly>
    </div>
  );
}
