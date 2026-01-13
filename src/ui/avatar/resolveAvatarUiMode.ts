// frontend/src/ui/avatar/resolveAvatarUiMode.ts

import { AdapterMeta } from "@/types/agentDialog";

export type AvatarUiMode =
  | "show_avatar"
  | "show_disabled"
  | "show_failed"
  | "show_fallback";

export function resolveAvatarUiMode(adapter?: AdapterMeta): AvatarUiMode {
  if (!adapter) return "show_failed";

  switch (adapter.status) {
    case "ready":
      return "show_avatar";
    case "disabled":
    case "skipped_pii":
      return "show_disabled";
    case "fallback":
      return "show_fallback";
    case "failed":
    default:
      return "show_failed";
  }
}
