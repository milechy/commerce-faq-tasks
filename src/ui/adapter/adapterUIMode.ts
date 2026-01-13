// src/ui/adapter/adapterUIMode.ts

import type { AdapterStatus } from "@/api/contracts/agentDialog";

export type AvatarUIMode =
  | "hidden" // UI に出さない（成功表示もここ）
  | "disabled" // disabled/skipped の説明バナー
  | "connecting" // requested: “成功表示はしない”
  | "failed" // failed: 接続失敗表示
  | "fallback"; // fallback: 代替表示

export function toAvatarUIMode(status?: AdapterStatus): AvatarUIMode {
  if (!status) return "hidden";

  switch (status) {
    case "disabled":
    case "skipped_pii":
      return "disabled";

    case "requested":
      return "connecting";

    case "failed":
      return "failed";

    case "fallback":
      return "fallback";

    case "ready":
      // PR2b 方針: readiness OK でも UI は「成功表示しない」
      return "hidden";

    default:
      // 将来 status が増えても UI が壊れない（failure-tolerant）
      return "hidden";
  }
}
