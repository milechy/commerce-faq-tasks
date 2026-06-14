import { useState, useEffect } from "react";
import { authFetch, API_BASE } from "../../lib/api";
import { useAuth } from "../../auth/useAuth";
import { SuperAdminOnly } from "../RoleGuard";

import { CARD, SECTION_TITLE } from "../ai-report/styles";
import { ScoreTrendChart } from "../ai-report/ScoreTrendChart";
import { KpiCards } from "../ai-report/KpiCards";
import { PsychPrincipleList } from "../ai-report/PsychPrincipleList";
import { ReactionBar } from "../ai-report/ReactionBar";
import { OutcomeScoreChart } from "../ai-report/OutcomeScoreChart";
import { SuggestedRulesList } from "../ai-report/SuggestedRulesList";
import { WeeklyReportSection } from "../ai-report/WeeklyReportSection";

import type {
  ScoreTrend,
  PsychPrinciple,
  SuggestedRule,
  CustomerReaction,
  KpiSummary,
  OutcomeScore,
  EvalStats,
} from "../ai-report/types";

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
                unknown: (raw.reaction_distribution as Record<string, number>).unknown ?? 0,
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

      {/* G: 週次レポート (全ロール) */}
      <WeeklyReportSection isSuperAdmin={isSuperAdmin} />
    </div>
  );
}
