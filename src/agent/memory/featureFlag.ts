// src/agent/memory/featureFlag.ts
// Phase71-A: Learned Memory Feature Flag
//
// 書込み (蒸留→保存) と 読込み (検索マージ) を独立に制御する。
// 段階導入のため、特定テナントだけで先行有効化できるようにする。
//
//   LEARNED_MEMORY_ENABLED=true       マスタースイッチ (write + read 両方の前提)
//   LEARNED_MEMORY_TENANTS=carnation  対象テナント (カンマ区切り。'*' で全テナント)
//   LEARNED_MEMORY_READ_ENABLED=true  検索マージを有効化 (既定 true。蒸留だけ先行したい場合 false)

function parseTenants(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTenantAllowed(tenantId: string): boolean {
  const allowed = parseTenants(process.env.LEARNED_MEMORY_TENANTS);
  if (allowed.includes("*")) return true;
  return allowed.includes(tenantId);
}

/**
 * 学習メモリの書込み (高スコア会話の蒸留→保存) が有効か。
 */
export function isLearnedMemoryWriteEnabled(tenantId: string): boolean {
  if (process.env.LEARNED_MEMORY_ENABLED !== "true") return false;
  return isTenantAllowed(tenantId);
}

/**
 * 学習メモリの読込み (RAG検索へのマージ) が有効か。
 * マスタースイッチ ON かつ READ 明示 OFF でない場合に有効。
 */
export function isLearnedMemoryReadEnabled(tenantId: string): boolean {
  if (process.env.LEARNED_MEMORY_ENABLED !== "true") return false;
  if (process.env.LEARNED_MEMORY_READ_ENABLED === "false") return false;
  return isTenantAllowed(tenantId);
}

/**
 * 蒸留対象とする Judge overall_score の下限閾値。
 * 既定 80 (高品質会話のみ学習に取り込む)。
 */
export function getLearnedMemoryThreshold(): number {
  const raw = parseInt(process.env.LEARNED_MEMORY_THRESHOLD ?? "80", 10);
  if (Number.isNaN(raw)) return 80;
  return Math.max(0, Math.min(100, raw));
}

/**
 * 学習メモリのスコアに掛ける重み (キュレーション済みFAQより優先させない)。
 * 既定 0.9。同点時は curated FAQ を優先させる意図。
 */
export function getLearnedMemoryWeight(): number {
  const raw = parseFloat(process.env.LEARNED_MEMORY_WEIGHT ?? "0.9");
  if (Number.isNaN(raw)) return 0.9;
  return Math.max(0, Math.min(1, raw));
}
