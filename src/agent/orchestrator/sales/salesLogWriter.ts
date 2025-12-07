// src/agent/orchestrator/sales/salesLogWriter.ts
//
// Runtime-level abstraction for writing Sales Logs.
// This sits between the SalesFlow orchestrator and concrete sinks
// (e.g. Notion, Postgres). It follows the data model defined in
// docs/SALES_LOG_SPEC.md.
//
// Fields:
// - tenantId, sessionId
// - phase: clarify / propose / recommend / close
// - intent: taxonomy slug (e.g. "trial_lesson_offer")
// - personaTags: ["beginner", ...]
// - userMessage: raw user utterance
// - templateSource: "notion" | "fallback"   ← important for KPI / fallback analysis
// - templateId: Notion page id (or null for fallback)
// - templateText: full text shown to the user
// - promptPreview: leading ~120 chars (for list UI)
// - timestamp: ISO8601 string

export type SalesLogPhase = "clarify" | "propose" | "recommend" | "close";

export type TemplateSource = "notion" | "fallback";

export interface SalesLogRecord {
  tenantId: string;
  sessionId: string;
  phase: SalesLogPhase;
  intent: string;
  personaTags: string[];
  userMessage: string;
  templateSource: TemplateSource;
  templateId: string | null;
  templateText: string;
  promptPreview: string;
  timestamp: string; // ISO8601
}

// Minimal sink abstraction so that Notion / Postgres etc. can implement it.
export interface SalesLogSink {
  write(record: SalesLogRecord): Promise<void>;
}

// Context shared across multiple stages of the same dialog.
export interface SalesLogContext {
  tenantId: string;
  sessionId: string;
}

/**
 * Build a SalesLogRecord from contextual information and template metadata.
 * This helper is intended to be called from runSalesFlowWithLogging or
 * equivalent orchestrator code.
 */
export function buildSalesLogRecord(params: {
  context: SalesLogContext;
  phase: SalesLogPhase;
  intent: string;
  personaTags: string[];
  userMessage: string;
  templateSource: TemplateSource;
  templateId: string | null;
  templateText: string;
  timestamp?: string | Date;
}): SalesLogRecord {
  const timestamp =
    params.timestamp instanceof Date
      ? params.timestamp.toISOString()
      : params.timestamp ?? new Date().toISOString();

  const promptPreview =
    params.templateText.length <= 120
      ? params.templateText
      : params.templateText.slice(0, 120);

  return {
    tenantId: params.context.tenantId,
    sessionId: params.context.sessionId,
    phase: params.phase,
    intent: params.intent,
    personaTags: params.personaTags,
    userMessage: params.userMessage,
    templateSource: params.templateSource,
    templateId: params.templateId,
    templateText: params.templateText,
    promptPreview,
    timestamp,
  };
}

/**
 * Runtime writer that delegates to a single sink. In most deployments this
 * will be a Notion-backed sink, but tests can inject an in-memory sink.
 */
export class SalesLogWriter {
  private readonly sink: SalesLogSink;

  constructor(sink: SalesLogSink) {
    this.sink = sink;
  }

  async write(record: SalesLogRecord): Promise<void> {
    await this.sink.write(record);
  }
}

// --- Global writer (optional) -----------------------------------------------

let globalWriter: SalesLogWriter | undefined;

/**
 * Set global SalesLogWriter used by orchestrator-level helpers.
 * This is typically configured at process startup.
 */
export function setGlobalSalesLogWriter(
  writer: SalesLogWriter | undefined
): void {
  globalWriter = writer;
}

/**
 * Get the current global SalesLogWriter, if any.
 */
export function getGlobalSalesLogWriter(): SalesLogWriter | undefined {
  return globalWriter;
}

/**
 * Convenience helper for writing via the global writer.
 * If no writer is configured, this becomes a no-op.
 */
export async function writeSalesLogViaGlobal(
  record: SalesLogRecord
): Promise<void> {
  if (!globalWriter) return;
  await globalWriter.write(record);
}
