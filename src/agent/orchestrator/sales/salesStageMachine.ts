// src/agent/orchestrator/sales/salesStageMachine.ts
// Phase15: Simple state machine for SalesFlow stages

/**
 * SalesFlow が扱うステージ。
 *
 * - clarify: ヒアリング・要件整理フェーズ
 * - propose: プラン・料金などの初回提案フェーズ
 * - recommend: 代替案や詳細プランの提案フェーズ
 * - close: クロージング（次のステップ・申込）フェーズ
 * - ended: 会話上、SalesFlow を終了した状態（将来拡張用）
 */
export type SalesStage =
  | "clarify"
  | "propose"
  | "recommend"
  | "close"
  | "ended";

/**
 * ステージ遷移の理由をログ用に表現するためのラベル。
 *
 * Phase15 では最小限の分類のみを持ち、必要に応じて拡張する想定。
 */
export type SalesStageTransitionReason =
  | "initial_clarify"
  | "auto_progress_by_intent"
  | "stay_in_stage"
  | "manual_override";

export type SalesStageTransition = {
  previousStage: SalesStage | null;
  nextStage: SalesStage;
  reason: SalesStageTransitionReason;
};

/**
 * ステージ遷移を決める際に利用するシグナル。
 *
 * - previousStage: 直前のステージ（新規会話の場合は null）
 * - hasProposeIntent / hasRecommendIntent / hasCloseIntent:
 *   intent 検出器などが出した「各ステージ向けの候補 Intent があるかどうか」のフラグ
 * - manualNextStage: 外部から明示的にステージを指定したい場合（オペレーター操作など）
 */
export type SalesStageSignals = {
  previousStage: SalesStage | null;
  hasProposeIntent: boolean;
  hasRecommendIntent: boolean;
  hasCloseIntent: boolean;
  manualNextStage?: SalesStage;
};

/**
 * 新規セッション開始時の初期ステージを決定する。
 * 現状は常に clarify から開始する。
 */
export function getInitialSalesStage(): SalesStageTransition {
  return {
    previousStage: null,
    nextStage: "clarify",
    reason: "initial_clarify",
  };
}

/**
 * SalesFlow のステージ遷移をシンプルなルールで決定する。
 *
 * Phase15 では以下のポリシーとする：
 * - 新規 or previousStage=null の場合は clarify から開始
 * - clarify:
 *   - intent 候補が出ていれば propose に進める（Clarify が一通り終わった扱い）
 *   - そうでなければ clarify 続行
 * - propose:
 *   - close 候補があれば close へ
 *   - close 候補が無く recommend 候補があれば recommend へ
 *   - それ以外は propose 続行
 * - recommend:
 *   - close 候補があれば close へ
 *   - それ以外は recommend 続行
 * - close / ended:
 *   - 現時点ではステージ維持（ended への遷移や再開は将来の拡張ポイント）
 */
export function computeNextSalesStage(
  signals: SalesStageSignals
): SalesStageTransition {
  const previousStage: SalesStage | null = signals.previousStage ?? null;

  // 明示的なステージ指定があればそれを最優先する
  if (signals.manualNextStage) {
    return {
      previousStage,
      nextStage: signals.manualNextStage,
      reason: "manual_override",
    };
  }

  // 会話開始時（previousStage が null）の扱い
  if (previousStage === null) {
    return {
      previousStage: null,
      nextStage: "clarify",
      reason: "initial_clarify",
    };
  }

  const { hasProposeIntent, hasRecommendIntent, hasCloseIntent } = signals;

  // ステージごとのシンプルな遷移ルール
  switch (previousStage) {
    case "clarify": {
      if (hasCloseIntent || hasProposeIntent || hasRecommendIntent) {
        return {
          previousStage,
          nextStage: "propose",
          reason: "auto_progress_by_intent",
        };
      }
      return {
        previousStage,
        nextStage: "clarify",
        reason: "stay_in_stage",
      };
    }

    case "propose": {
      if (hasCloseIntent) {
        return {
          previousStage,
          nextStage: "close",
          reason: "auto_progress_by_intent",
        };
      }
      if (hasRecommendIntent) {
        return {
          previousStage,
          nextStage: "recommend",
          reason: "auto_progress_by_intent",
        };
      }
      return {
        previousStage,
        nextStage: "propose",
        reason: "stay_in_stage",
      };
    }

    case "recommend": {
      if (hasCloseIntent) {
        return {
          previousStage,
          nextStage: "close",
          reason: "auto_progress_by_intent",
        };
      }
      return {
        previousStage,
        nextStage: "recommend",
        reason: "stay_in_stage",
      };
    }

    case "close":
    case "ended":
    default: {
      // 現時点では close/ended からの遷移は制御しない（外部の判断に委ねる）
      return {
        previousStage,
        nextStage: previousStage,
        reason: "stay_in_stage",
      };
    }
  }
}
