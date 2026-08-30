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
 * 学習メモリ機構全体のマスタースイッチ。
 * GID 1217972798328871 (H-6): 手動昇格 (memoryDistiller.manuallyPromoteSession) は
 * LEARNED_MEMORY_TENANTS allowlist を経由しない (人間が個別に判断した結果のため。
 * allowlist を広げる/広げないは自動昇格の対象範囲を決める別判断で、本関数はそれとは独立)が、
 * このマスタースイッチだけは尊重する (機構自体がOFFなら手動でも何もしない)。
 */
export function isLearnedMemoryMasterEnabled(): boolean {
  return process.env.LEARNED_MEMORY_ENABLED === "true";
}

/**
 * 学習メモリの書込み (高スコア会話の蒸留→保存) が有効か。
 */
export function isLearnedMemoryWriteEnabled(tenantId: string): boolean {
  if (!isLearnedMemoryMasterEnabled()) return false;
  return isTenantAllowed(tenantId);
}

/**
 * 学習メモリの読込み (RAG検索へのマージ) が有効か。
 * マスタースイッチ ON かつ READ 明示 OFF でない場合に有効。
 *
 * H-6欠陥修正 (GID 1217972798328871): tenantId 引数は残すが、ここでは
 * isTenantAllowed (書込み側 allowlist) を意図的に見ない。
 * 読込みは「learned_memory に存在する行」しか返せず、行が存在するのは
 *   (a) 自動昇格 = 書込み側 allowlist (isLearnedMemoryWriteEnabled) を通ったテナント
 *   (b) 手動昇格 (manuallyPromoteSession) = allowlist を経由せず人間が個別に判断したテナント
 * のどちらかに限られる。つまり「何が存在するか」は既に書込み側の gate が制御済みなので、
 * 読込み側で同じ allowlist を重ねて見ると (a) には冗長、(b) には有害
 * (せっかく手動昇格した内容が二度とプロンプトに載らない)。
 * 挙動変化: allowlist から外れたテナントは「新しく学習しなくなる (書込み側は従来どおり閉じる)」
 * だけで、「学習済みの内容を使わなくなる (忘却)」わけではない。
 */
export function isLearnedMemoryReadEnabled(_tenantId: string): boolean {
  if (process.env.LEARNED_MEMORY_ENABLED !== "true") return false;
  if (process.env.LEARNED_MEMORY_READ_ENABLED === "false") return false;
  return true;
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
