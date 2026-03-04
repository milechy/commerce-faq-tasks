// src/agent/avatar/avatarPolicy.ts

import { detectPiiRoute } from "./piiRouteDetector";

export type AvatarProvider = "lemon_slice";

export type AvatarDecisionStatus =
  | "forced_off_pii"
  | "disabled_by_flag"
  | "disabled_by_kill_switch"
  | "requested"
  | "ready"
  | "failed"
  | "fallback_to_text";

export type AvatarDisableReason =
  | "pii_route"
  | "flag_off"
  | "kill_switch"
  | "provider_error"
  | "timeout";

export interface AvatarPolicyInput {
  provider: AvatarProvider;
  locale: "ja" | "en";
  userMessage: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  intentHint?: string; // detectIntentHint の結果を渡す
  flags: {
    avatarEnabled: boolean; // FF_AVATAR_ENABLED
    avatarForceOff: boolean; // FF_AVATAR_FORCE_OFF
  };
  killSwitch: {
    enabled: boolean; // 運用で即時停止
    reason?: string;
  };
  timing: {
    // readiness待ちのタイムアウト。UIでの接続失敗やfallbackを促すため。
    readinessTimeoutMs: number;
  };
}

export interface AvatarPolicyDecision {
  provider: AvatarProvider;
  status: AvatarDecisionStatus;
  disableReason?: AvatarDisableReason;
  piiReasons?: string[];
  killReason?: string;
  // requested の場合: readiness待ち時間
  readinessTimeoutMs?: number;
}

export function evaluateAvatarPolicy(
  input: AvatarPolicyInput
): AvatarPolicyDecision {
  // 0) PII導線は avatar 使用禁止
  const pii = detectPiiRoute({
    userMessage: input.userMessage,
    history: input.history,
    intentHint: input.intentHint,
  });
  if (pii.isPiiRoute) {
    return {
      provider: input.provider,
      status: "forced_off_pii",
      disableReason: "pii_route",
      piiReasons: pii.reasons,
    };
  }

  // 1) feature flag
  if (!input.flags.avatarEnabled || input.flags.avatarForceOff) {
    return {
      provider: input.provider,
      status: "disabled_by_flag",
      disableReason: "flag_off",
    };
  }

  // 2) kill-switch
  if (input.killSwitch.enabled) {
    return {
      provider: input.provider,
      status: "disabled_by_kill_switch",
      disableReason: "kill_switch",
      killReason: input.killSwitch.reason,
    };
  }

  // 3) avatar を要求（presentation layer で readiness を待つ）
  return {
    provider: input.provider,
    status: "requested",
    readinessTimeoutMs: input.timing.readinessTimeoutMs,
  };
}
