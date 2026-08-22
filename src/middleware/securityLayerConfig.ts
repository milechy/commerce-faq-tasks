// src/middleware/securityLayerConfig.ts
// L5-L8 (inputSanitizer/topicGuard/outputGuard/promptFirewall) が共有する
// 「本番既定ON」判定。5箇所に同一の3行がコピーされていたのを1箇所に集約する。
//
// この極性を守ることが目的そのもの: production では明示的に'false'にしない限り
// 常にON、それ以外(development/test)は明示的に'true'にしない限り常にOFF。
// 6層目を追加する人がここを間違えると、その層は本番で静かにOFFのままになる
// （実際に4層すべてがこの状態のまま本番稼働していたP1インシデントが起きている）。

/**
 * production は既定ON（'false'明示時のみOFF）。
 * development/test は既定OFF（'true'明示時のみON）。
 */
export function isSecurityLayerEnabled(envName: string): boolean {
  const flag = process.env[envName];
  if (process.env["NODE_ENV"] === "production") return flag !== "false";
  return flag === "true";
}
