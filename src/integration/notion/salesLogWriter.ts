// src/integration/notion/salesLogWriter.ts
// Phase14: SalesLogWriter (Notion adapter-agnostic core)
//
// Clarify / Propose / Recommend / Close それぞれで提示したテンプレ情報を
// 一元的に記録するためのコアロジック。
//
// 実際の「どこに書き込むか」（Notion / Postgres など）は caller 側から
// コールバックとして注入する想定にしておくことで、ここでは
// データ整形と型定義に責務を絞る。

/**
 * SalesLog で扱うフェーズ種別。
 * docs/INTENT_TAXONOMY_SALES_EN.md / SALES_LOG_SPEC.md と揃える。
 */
export type SalesLogPhase = "clarify" | "propose" | "recommend" | "close";

/**
 * テンプレのソース種別。
 * - notion: Notion TuningTemplates から取得
 * - fallback: コード内のフォールバック文面
 */
export type SalesLogTemplateSource = "notion" | "fallback";

/**
 * SalesLogWriter に渡す入力。
 * Runtime からはこの構造だけ意識すればよい。
 */
export interface SalesLogInput {
  tenantId: string;
  sessionId: string;
  phase: SalesLogPhase;
  intent: string; // intent taxonomy slug
  personaTags?: string[];
  userMessage: string;
  templateSource: SalesLogTemplateSource;
  templateId?: string | null;
  templateText: string;
  timestamp?: Date;
}

/**
 * 実際に保存されるレコード形。
 * promptPreview などの派生値を含む。
 */
export interface SalesLogRecord extends SalesLogInput {
  promptPreview: string;
  timestamp: Date;
}

/**
 * SalesLogWriter が依存する「実際の書き込み先」。
 * - Notion DB に書き込む実装
 * - Postgres に保存する実装
 * などは、このインターフェースを満たす関数で差し替え可能。
 */
export type SalesLogSink = (record: SalesLogRecord) => Promise<void>;

/**
 * SalesLogWriter
 *
 * - SalesLogInput を受け取り、SalesLogRecord に整形して sink へ渡す。
 * - sink の実装は呼び出し側（integration 層）で行う。
 */
export class SalesLogWriter {
  constructor(private readonly sink: SalesLogSink) {}

  /**
   * SalesLog を 1 件書き込む。
   */
  async write(input: SalesLogInput): Promise<void> {
    const timestamp = input.timestamp ?? new Date();

    const promptPreview =
      input.templateText.length <= 120
        ? input.templateText
        : input.templateText.slice(0, 120);

    const record: SalesLogRecord = {
      ...input,
      timestamp,
      promptPreview,
    };

    await this.sink(record);
  }
}

// Global writer reference (set at app startup in src/index.ts)
export let globalSalesLogWriter: SalesLogWriter | undefined;

export function setGlobalSalesLogWriter(
  writer: SalesLogWriter | undefined,
): void {
  globalSalesLogWriter = writer;
}
