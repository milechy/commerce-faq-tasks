// front/ui/copy.ts
// 表示文言は status/reasonCode から「固定文言にマッピング」する方針が安全（UI が嘘をつかない）

import { AdapterStatus, type AdapterMeta } from "../types/adapterStatus";

export function getAvatarBannerText(
  locale: "ja" | "en",
  meta: AdapterMeta
): string | null {
  const ja: Record<AdapterStatus, string> = {
    [AdapterStatus.Ready]: "アバターを有効にしました。",
    [AdapterStatus.Disabled]: "アバターは現在無効です。",
    [AdapterStatus.SkippedPii]:
      "個人情報を含む可能性があるため、アバターは使用しません。",
    [AdapterStatus.Failed]:
      "アバターに接続できませんでした（テキストで回答します）。",
    [AdapterStatus.Fallback]:
      "アバターが利用できないため、テキストに切り替えました。",
  };

  const en: Record<AdapterStatus, string> = {
    [AdapterStatus.Ready]: "Avatar is enabled.",
    [AdapterStatus.Disabled]: "Avatar is currently disabled.",
    [AdapterStatus.SkippedPii]: "Avatar is disabled due to possible PII.",
    [AdapterStatus.Failed]:
      "Could not connect to the avatar (answering in text).",
    [AdapterStatus.Fallback]: "Avatar unavailable; switched to text.",
  };

  // ready の「成功表示」は readiness が取れた場合のみ server が Ready を返す前提
  const table = locale === "en" ? en : ja;
  return table[meta.status] ?? null;
}
