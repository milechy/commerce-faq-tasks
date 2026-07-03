// src/agent/hermes/featureFlag.ts
// Phase74: Hermes Agent Feature Flag
//
// 常駐スケジューラのマスタースイッチ・対象テナント・通知有無・LLM整形有無を
// 独立に制御する。段階導入(生成のみ観測 → 通知ON → LLM整形ON)を可能にする。
//
//   HERMES_ENABLED=true          マスタースイッチ (常駐スケジューラ起動の前提)
//   HERMES_TENANTS=carnation     tenant別提案の対象テナント (カンマ区切り。'*' で全テナント)
//                                横断(global)提案はこのリストと無関係に生成される
//   HERMES_NOTIFY_ENABLED=true   既定true。falseで生成・永続化のみ(通知は送らない)
//   HERMES_LLM_ENABLED=false     既定false。trueでもMVP時点ではテンプレート整形のまま
//                                (Groq整形は将来PRで実装するためのフラグ予約)

function parseTenants(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** tenant別提案の対象テナントとして許可されているか。 */
export function isHermesTenantAllowed(tenantId: string): boolean {
  const allowed = parseTenants(process.env.HERMES_TENANTS);
  if (allowed.includes("*")) return true;
  return allowed.includes(tenantId);
}

/** 常駐スケジューラ (setInterval) を起動してよいか。マスタースイッチ。 */
export function isHermesEnabled(): boolean {
  return process.env.HERMES_ENABLED === "true";
}

/** 生成した提案を通知(In-App/Slack)として送るか。既定true。falseなら生成・永続化のみ。 */
export function isHermesNotifyEnabled(): boolean {
  return process.env.HERMES_NOTIFY_ENABLED !== "false";
}

/**
 * Groqによる提案文の自然言語整形を使うか。既定false。
 * MVP時点では未実装 (テンプレート整形のみ)。将来のLLM整形実装のためのフラグ予約。
 */
export function isHermesLlmEnabled(): boolean {
  return process.env.HERMES_LLM_ENABLED === "true";
}
