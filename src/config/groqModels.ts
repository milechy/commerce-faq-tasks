// src/config/groqModels.ts
// Groq / gpt-oss モデル ID の単一の正典（散在ハードコードの集約先）。
//
// 目的:
//   1. 集約 — モデル ID をコード全体に散らさず、ここだけを更新すれば差し替えられる。
//   2. EOL 検知 — 廃止モデルが本番に残るのを 2 層で防ぐ（下記）。
//
// EOL 検知は 2 層構成:
//   [静的] SCRIPTS/check-groq-models.sh
//     KNOWN_DEPRECATED に列挙した ID が src/ (非 test) に混入したら落とす。
//     ネットワーク非依存。security-scan.sh 経由で PR / push / 週次 CI すべてで走る。
//     限界: リストが手動メンテなので、告知を見落とすと検知できない。
//   [ライブ] SCRIPTS/check-groq-models-live.sh
//     Groq の /v1/models が返す実配信リストと ACTIVE_GROQ_MODELS を突き合わせ、
//     「コードはアクティブだと思っているが Groq には無い」ID を検出する。
//     告知を見落としても気づける代わりにネットワークと API キーが要る。
//     GROQ_API_KEY が GitHub Actions の secret に無いため CI には入れず、手動 / cron で回す。
//     終了コード: 0=PASS / 1=廃止検知 / 2=検知不能（キー無し・API 到達不可。赤扱いしない）。
//
// なぜ 2 層必要か:
//   2026-08 に Groq が llama-3.3-70b-versatile / llama-3.1-8b-instant を廃止した際、
//   誰も KNOWN_DEPRECATED に追記しなかったため静的層は素通りし、
//   アバターチャットが本番で全面停止した。ライブ層はこの取りこぼしを埋めるためにある。
//
// 追加・変更時のルール:
//   - 新モデル採用: ACTIVE に定数を足し、call site をその定数経由に。
//   - モデル廃止: Groq の deprecation 告知が出たら KNOWN_DEPRECATED に id を追記。
//     検知層が src/ 内の残存使用を洗い出すので、移行漏れを防げる。
//   - ACTIVE を変更したら GROQ_FALLBACK_CHAIN の退避先が生存モデルを指すか必ず確認する
//     （2026-08 の障害では、生存モデルからの退避先が全て廃止モデルに着地する状態だった）。
//
// 2026-08-23 の移行:
//   Groq が llama-3.3-70b-versatile / llama-3.1-8b-instant を配信停止したため
//   (実測: /v1/models に存在せず 404 model_not_found)、両者を openai/gpt-oss-120b へ集約した。
//   Groq に残る汎用チャットモデルは gpt-oss 系と compound 系のみで、Llama 系の汎用モデルは無い。
//   8B 相当の安価枠を gpt-oss-20b ではなく 120b に寄せたのは、20b が低い max_tokens 下で
//   推論トークンを使い切って本文が空になり、JSON 出力用途(objectionDetector 等)が
//   無言で機能停止する挙動を実測したため。

/** 現在アクティブな Groq チャットモデル（実機で呼び出している実 ID）。値は実 ID と完全一致させること。 */
export const GROQ_COMPOUND = 'groq/compound';
export const GROQ_COMPOUND_MINI = 'groq/compound-mini';

/** gpt-oss（Groq 経由）— アーキテクチャ上の 20B / 120B。汎用チャットの主力は 120B。 */
export const GPT_OSS_20B = 'openai/gpt-oss-20b';
export const GPT_OSS_120B = 'openai/gpt-oss-120b';

export type GroqModelStatus = 'active' | 'deprecated';

export interface GroqModelEntry {
  id: string;
  /** 用途の目安。集約後の選定で参照する。 */
  tier: 'compound' | 'compound-mini' | 'oss-20b' | 'oss-120b';
  status: GroqModelStatus;
}

/** アクティブモデルのレジストリ（COST マップ・テスト・検知層が参照する単一の真実）。 */
export const ACTIVE_GROQ_MODELS: readonly GroqModelEntry[] = [
  { id: GROQ_COMPOUND, tier: 'compound', status: 'active' },
  { id: GROQ_COMPOUND_MINI, tier: 'compound-mini', status: 'active' },
  { id: GPT_OSS_20B, tier: 'oss-20b', status: 'active' },
  { id: GPT_OSS_120B, tier: 'oss-120b', status: 'active' },
] as const;

export const ACTIVE_GROQ_MODEL_IDS: readonly string[] = ACTIVE_GROQ_MODELS.map((m) => m.id);

/**
 * Groq が decommission 済み / 廃止予定として告知したモデル ID。
 * ここに載った ID が src/ (非 test) に残っていれば EOL 検知層が CI を落とす。
 * 出典: Groq deprecations (https://console.groq.com/docs/deprecations)。
 */
export const KNOWN_DEPRECATED_GROQ_MODELS: readonly string[] = [
  // 2026-08-23 実測で /v1/models から消滅を確認（告知の見落としにより本番障害化した2件）。
  'llama-3.3-70b-versatile', // → openai/gpt-oss-120b に移行済み
  'llama-3.1-8b-instant', // → openai/gpt-oss-120b に移行済み
  'llama-3.1-70b-versatile', // → llama-3.3-70b-versatile 経由で openai/gpt-oss-120b へ
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma-7b-it',
  'gemma2-9b-it',
  'llama-3.2-1b-preview',
  'llama-3.2-3b-preview',
  'llama-3.2-11b-vision-preview',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-text-preview',
  'llama-3.2-90b-text-preview',
] as const;

const DEPRECATED_SET = new Set(KNOWN_DEPRECATED_GROQ_MODELS);

/** 与えられたモデル ID が Groq の既知 EOL リストに含まれるか。 */
export function isDeprecatedGroqModel(model: string): boolean {
  return DEPRECATED_SET.has(model);
}

/**
 * モデル ID がアクティブであることを保証する。EOL モデルなら例外を投げる。
 * 起動時 / 設定読込時の fail-fast 用。
 */
export function assertActiveGroqModel(model: string): void {
  if (isDeprecatedGroqModel(model)) {
    throw new Error(
      `[groqModels] decommissioned Groq model "${model}" is in use. ` +
        `Migrate to an ACTIVE_GROQ_MODELS entry (see src/config/groqModels.ts).`,
    );
  }
}

/**
 * モデルが 404 / model_not_found エラーを返した際のフォールバックチェーン。
 *
 * キー: 優先モデルの ID
 * 値: 退避先モデルの ID
 *
 * 設計方針:
 *   - **退避先は必ず ACTIVE_GROQ_MODEL_IDS の中から選ぶこと。**
 *     2026-08-23 まで、退避先が既に配信停止された llama 系を指しており、
 *     「生きているモデルから退避すると必ず死んだモデルに着地する」状態だった。
 *     404 時の救済のための仕組みが、逆に全経路を確実な失敗へ導いていた。
 *     この不変条件は groqModels.test.ts が機械的に検証する。
 *   - compound 系 → 汎用の gpt-oss-120b へ抜けられるようにする。
 *   - 終端は gpt-oss-20b（Groq に残る唯一の他の汎用チャットモデル）。
 *     20b は JSON 用途では不安定だが、緊急退避先としては「何も返さない」より良い。
 *   - 無限ループ防止のため resolve 側(callGroqWithModelFallback)で visited 検証する。
 */
export const GROQ_FALLBACK_CHAIN: Readonly<Record<string, string>> = {
  // 主力 120B → 20B（終端）
  [GPT_OSS_120B]: GPT_OSS_20B,
  // compound 系 → mini → 汎用 120B
  [GROQ_COMPOUND]: GROQ_COMPOUND_MINI,
  [GROQ_COMPOUND_MINI]: GPT_OSS_120B,
  // gpt-oss-20b: これ以上退避先なし（チェーン終端）
};

/**
 * 指定モデルのフォールバック先を返す。
 *
 * @returns フォールバック先モデル ID。チェーン終端の場合は null。
 */
export function getFallbackGroqModel(model: string): string | null {
  return GROQ_FALLBACK_CHAIN[model] ?? null;
}
