// src/middleware/securityLayerConfig.ts
// L5-L8 (inputSanitizer/topicGuard/outputGuard/promptFirewall) が共有する
// 「既定ON」判定。5箇所に同一の3行がコピーされていたのを1箇所に集約する。
//
// この極性を守ることが目的そのもの: 開発・テスト以外の環境では明示的に'false'に
// しない限り常にON。6層目を追加する人がここを間違えると、その層は本番で静かに
// OFFのままになる（実際に4層すべてがこの状態のまま本番稼働していたP1インシデントが
// 起きている）。

/**
 * 既定OFFにする環境。ここに列挙した値と完全一致した場合のみ、明示的に'true'を
 * 指定しない限り層はOFFになる。
 *
 * 「productionと完全一致した場合のみON」という以前の実装は fail-open だった:
 * package.json の dev/start/start:prod はいずれも NODE_ENV を設定せず、
 * ecosystem.config.cjs の env_production も `pm2 start --env production` を
 * 付けた時だけ適用される。つまり `--env production` を付け忘れて起動すると
 * NODE_ENV=undefined となり、4層すべてが無言でOFFになっていた。
 * staging/qa のような準本番環境を将来足した場合も同じ穴を踏む。
 * 未知の環境名は「本番かもしれない」側に倒す（fail-safe）。
 */
const DEFAULT_OFF_ENVS = new Set(["development", "test"]);

/**
 * development/test は既定OFF（'true'明示時のみON）。
 * それ以外（production / staging / NODE_ENV未設定 など）は既定ON（'false'明示時のみOFF）。
 */
export function isSecurityLayerEnabled(envName: string): boolean {
  const flag = process.env[envName];
  if (DEFAULT_OFF_ENVS.has(process.env["NODE_ENV"] ?? "")) return flag === "true";
  return flag !== "false";
}
