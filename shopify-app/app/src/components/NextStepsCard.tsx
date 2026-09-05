// shopify-app/app/src/components/NextStepsCard.tsx
//
// 接続完了後の「次にやること」導線(FR-12)。
// FAQ登録・有人対応・課金操作はここで再実装せず、既存 CopilotUI
// (admin-ui/src/pages/copilot-preview/)へのリンクとして提供するだけ
// (D9・WordPress版D10と同型)。

import { COPILOT_UI_BASE_URL } from "../lib/config";
import type { ShopifySettings } from "../types";

export function NextStepsCard({ settings }: { settings: ShopifySettings }) {
  const copilotUrl = `${COPILOT_UI_BASE_URL}/copilot-preview?tenant=${encodeURIComponent(settings.tenant_id)}`;

  return (
    <section className="r2c-card" aria-label="次にやること">
      <h2 className="r2c-card__title">次にやること</h2>
      <p className="r2c-card__desc">
        よくある質問（FAQ）を登録すると、チャットがお客様の質問に答えられるようになります。
        FAQ の登録・お客様対応・ご利用プランの変更は R2C の管理画面（CopilotUI）から行います。
      </p>
      <a className="r2c-button r2c-button--primary" href={copilotUrl} target="_blank" rel="noreferrer">
        R2C の管理画面を開く
      </a>
    </section>
  );
}
