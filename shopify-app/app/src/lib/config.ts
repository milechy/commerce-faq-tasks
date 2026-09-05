// shopify-app/app/src/lib/config.ts
//
// このアプリが呼び出す先の設定値。すべて Vite の環境変数で差し替え可能にし、
// ハードコードされたホスト名を分岐条件に使わない。

/** R2C 本体API。既定は本番(api.r2c.biz)。 */
export const API_BASE_URL: string =
  (import.meta.env.VITE_R2C_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ??
  "https://api.r2c.biz";

/**
 * CopilotUI(admin-ui/src/pages/copilot-preview/)への導線先。
 * FAQ登録・有人対応・課金操作はここでは再実装せず、常にこちらへリンクするだけ(D9)。
 */
export const COPILOT_UI_BASE_URL: string =
  (import.meta.env.VITE_R2C_COPILOT_UI_BASE_URL as string | undefined)?.replace(/\/$/, "") ??
  "https://admin.r2c.biz";
