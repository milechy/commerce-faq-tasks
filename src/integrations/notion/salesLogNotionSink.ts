// src/integrations/notion/salesLogNotionSink.ts
// GID 1216970103691946 (PR-11): SalesLogWriter(src/agent/orchestrator/sales/
// salesLogWriter.ts)の SalesLogSink を Notion で実装する。
//
// 従来 src/integration/notion/{salesLogWriter,notionSalesLogSink}.ts に同種の
// 実装があったが、SalesLogRecord の形が古く(prevStage/nextStage/
// stageTransitionReasonを含まない)、どこからもimportされていなかった
// (createNotionSalesLogSink自体exportすらされていなかった)ため削除し、
// 現行のSalesLogSink/SalesLogRecordに正しく合わせてここに作り直した。

import { Client, isNotionClientError } from "@notionhq/client";
import { logger } from "../../lib/logger";
import type { SalesLogRecord, SalesLogSink } from "../../agent/orchestrator/sales/salesLogWriter";

export function createSalesLogNotionSink(opts?: {
  apiKey?: string;
  databaseId?: string;
}): SalesLogSink {
  const apiKey = opts?.apiKey ?? process.env.NOTION_API_KEY;
  if (!apiKey) {
    throw new Error("[SalesLogNotionSink] NOTION_API_KEY is not set");
  }
  const databaseId = opts?.databaseId ?? process.env.NOTION_DB_SALES_LOG_ID;
  if (!databaseId) {
    throw new Error("[SalesLogNotionSink] NOTION_DB_SALES_LOG_ID is not set");
  }

  const client = new Client({ auth: apiKey, notionVersion: "2025-09-03" });

  return {
    async write(record: SalesLogRecord): Promise<void> {
      try {
        await client.pages.create({
          parent: { database_id: databaseId },
          properties: {
            TenantId: { title: [{ text: { content: record.tenantId } }] },
            SessionId: { rich_text: [{ text: { content: record.sessionId } }] },
            Phase: { select: { name: record.phase } },
            PrevStage: record.prevStage
              ? { select: { name: record.prevStage } }
              : { select: null },
            NextStage: { select: { name: record.nextStage } },
            StageTransitionReason: { select: { name: record.stageTransitionReason } },
            Intent: { rich_text: [{ text: { content: record.intent } }] },
            PersonaTags: {
              multi_select: record.personaTags.map((tag) => ({ name: tag })),
            },
            TemplateSource: { select: { name: record.templateSource } },
            ...(record.templateId
              ? { TemplateId: { rich_text: [{ text: { content: record.templateId } }] } }
              : {}),
            UserMessage: { rich_text: [{ text: { content: record.userMessage } }] },
            PromptPreview: { rich_text: [{ text: { content: record.promptPreview } }] },
            Timestamp: { date: { start: record.timestamp } },
          },
        });
      } catch (err) {
        if (isNotionClientError(err)) {
          logger.warn({ code: err.code, message: err.message }, "[SalesLogNotionSink] Notion API error (non-blocking)");
        } else {
          logger.warn({ err }, "[SalesLogNotionSink] unknown error (non-blocking)");
        }
        // best-effort: SalesFlow応答自体は止めない(呼び出し元writeSalesLogViaGlobalは
        // runSalesFlowWithLoggingからawaitされるが、そちらもtry/catchしていないため
        // ここで吸収する)
      }
    },
  };
}
