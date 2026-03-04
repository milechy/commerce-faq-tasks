/**
 * Phase23 アラート条件定義
 *
 * MetricsSnapshot: 60秒評価ウィンドウ内の KPI サマリ（null = データなし）
 * AlertRule: 発火条件・継続時間・アラートレベル
 *
 * 制約: PII・書籍内容をスナップショットに含めない
 */

export type AlertLevel = "CRITICAL" | "WARNING" | "INFO";

/**
 * 評価ウィンドウ内で計算された KPI スナップショット。
 * null は評価ウィンドウ内に該当データがないことを示す（division-by-zero 防止）。
 */
export interface MetricsSnapshot {
  timestamp: number;
  /** 会話完了率 (0–100 %) */
  completionRate: number | null;
  /** ループ検出率 (0–100 %) */
  loopRate: number | null;
  /** アバターフォールバック率 (0–100 %) */
  avatarFallbackRate: number | null;
  /** 検索レイテンシ p95 (ms) */
  searchP95Ms: number | null;
  /** HTTP エラー率 (0–100 %) */
  errorRate: number | null;
  /** Kill Switch 発動中か */
  killSwitchActive: boolean;
}

export interface AlertRule {
  /** 一意識別子 */
  id: string;
  /** 表示名（日本語可） */
  name: string;
  /** アラートレベル */
  level: AlertLevel;
  /**
   * 条件が継続している必要がある時間 (ms)。
   * 0 = 即時発火（Kill Switch 用）。
   */
  durationMs: number;
  /** true = 条件違反（アラート発火対象） */
  evaluate: (snapshot: MetricsSnapshot) => boolean;
}

export const ALERT_RULES: AlertRule[] = [
  {
    id: "completion_rate_low",
    name: "会話完了率低下",
    level: "CRITICAL",
    durationMs: 60 * 60 * 1000, // 1時間
    evaluate: (s) => s.completionRate !== null && s.completionRate < 60,
  },
  {
    id: "loop_rate_high",
    name: "ループ検出率上昇",
    level: "CRITICAL",
    durationMs: 30 * 60 * 1000, // 30分
    evaluate: (s) => s.loopRate !== null && s.loopRate > 15,
  },
  {
    id: "avatar_fallback_high",
    name: "アバターフォールバック率上昇",
    level: "WARNING",
    durationMs: 15 * 60 * 1000, // 15分
    evaluate: (s) => s.avatarFallbackRate !== null && s.avatarFallbackRate > 50,
  },
  {
    id: "search_latency_p95_high",
    name: "検索レイテンシ p95 上昇",
    level: "WARNING",
    durationMs: 10 * 60 * 1000, // 10分
    evaluate: (s) => s.searchP95Ms !== null && s.searchP95Ms > 2000,
  },
  {
    id: "error_rate_high",
    name: "エラー率上昇",
    level: "CRITICAL",
    durationMs: 5 * 60 * 1000, // 5分
    evaluate: (s) => s.errorRate !== null && s.errorRate > 3,
  },
  {
    id: "kill_switch_active",
    name: "Kill Switch 発動",
    level: "INFO",
    durationMs: 0, // 即時
    evaluate: (s) => s.killSwitchActive,
  },
];
