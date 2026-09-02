// src/lib/excludedPagePattern.ts
// ウィジェットを表示しないページのパスパターン検証。
// 保存側(src/api/admin/tenants/routes.ts の zod スキーマ)とチャットツール側
// (src/api/admin/agent/actionExecutor.ts)が同じ判定を共有する。
// isValidOriginPattern(src/api/middleware/originCheck.ts)と同じ理由: 検証ロジックの
// 重複による片方だけ緩くなる事故(保存できたのに効かない)を防ぐ。
export function isValidExcludedPagePattern(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("?") || value.includes("#")) return false;
  if (value.length < 1 || value.length > 200) return false;
  return true;
}
