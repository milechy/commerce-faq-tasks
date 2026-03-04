// front/types/adapterStatus.ts
// UI が meta.adapter.status をもとに disabled/fallback/failed の表示を切り替えるための最小インターフェース案

/** バックエンドが meta.adapter.provider で返す値と一致させる */
export type AvatarAdapterProvider = "lemon_slice";

/**
 * UI 表示の分岐に使うステータス（Phase22: UI は嘘をつかない）
 * - ready: readiness 確認が成功した場合のみ（成功表示してよい）
 * - disabled: feature flag / 強制OFF 等により最初から使わない
 * - skipped_pii: PII 導線につき使わない（安全側）
 * - failed: readiness/接続の試行が失敗（ただし会話フローは継続）
 * - fallback: adapter 側が「使えないので fallback した」を明示（=失敗とは区別したい場合）
 */
export enum AdapterStatus {
  Ready = "ready",
  Disabled = "disabled",
  SkippedPii = "skipped_pii",
  Failed = "failed",
  Fallback = "fallback",
}

/**
 * サーバーレスポンスの meta.adapter の形（UI が参照する契約）
 * - status で UI 表示を切り替える
 * - reasonCode は表示テキストの出し分けやデバッグ用途（任意）
 * - correlationId はログ突合のためのキー（任意）
 */
export interface AdapterMeta {
  provider: AvatarAdapterProvider;
  status: AdapterStatus;

  /** 例: "flag_off" | "kill_switch" | "timeout" | "network" | "pii_policy" など（任意） */
  reasonCode?: string;

  /** 人が読める説明（UI 表示するなら短く固定文言にマッピング推奨） */
  message?: string;

  /** 観測・突合用（Phase22: 追跡可能性） */
  correlationId?: string;
}

/**
 * /agent.dialog のフロント側レスポンス最小形（必要箇所のみ）
 * 実際の app では既存の DialogAgentResponse 型にマージ想定。
 */
export interface AgentDialogResponse {
  sessionId?: string;
  answer: string | null;
  steps: unknown[];

  meta: {
    adapter: AdapterMeta;
    // 他にも flow / ragStats / salesMeta などが入るならここに追加
  };
}

/** UI 表示の決定ロジック例（状態→表示モード） */
export type AvatarUiMode =
  | "show_avatar"
  | "show_disabled"
  | "show_failed"
  | "show_fallback";

export function resolveAvatarUiMode(meta: AdapterMeta): AvatarUiMode {
  switch (meta.status) {
    case AdapterStatus.Ready:
      return "show_avatar";
    case AdapterStatus.Disabled:
    case AdapterStatus.SkippedPii:
      return "show_disabled";
    case AdapterStatus.Failed:
      return "show_failed";
    case AdapterStatus.Fallback:
      return "show_fallback";
    default: {
      // 将来ステータスが増えても UI が破綻しないよう安全側へ
      return "show_failed";
    }
  }
}
