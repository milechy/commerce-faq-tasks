

// src/integration/notion/notionSalesLogSink.ts
// Phase14: Notion implementation of SalesLogSink
//
// SalesLogWriter から渡される SalesLogRecord を、Notion データベースに保存するための sink 実装。
// Notion クライアントと databaseId は呼び出し側から注入する。

import type { Client } from '@notionhq/client'
import type { SalesLogRecord, SalesLogSink } from './salesLogWriter'

export type NotionSalesLogSinkOptions = {
  notion: Client
  databaseId: string
}

/**
 * Notion 用 SalesLogSink を生成する。
 *
 * 呼び出し側は、初期化時に `notion` クライアントと `databaseId` を渡すだけでよい。
 */
export function createNotionSalesLogSink(
  options: NotionSalesLogSinkOptions,
): SalesLogSink {
  const { notion, databaseId } = options

  const sink: SalesLogSink = async (record: SalesLogRecord) => {
    const properties: Record<string, any> = {
      TenantId: {
        title: [{ text: { content: record.tenantId } }],
      },
      SessionId: {
        rich_text: [{ text: { content: record.sessionId } }],
      },
      Phase: {
        select: { name: record.phase },
      },
      Intent: {
        rich_text: [{ text: { content: record.intent } }],
      },
      PersonaTags: {
        multi_select:
          record.personaTags?.map((tag) => ({ name: tag })) ?? [],
      },
      TemplateSource: {
        select: { name: record.templateSource },
      },
      UserMessage: {
        rich_text: [{ text: { content: record.userMessage } }],
      },
      PromptPreview: {
        rich_text: [{ text: { content: record.promptPreview } }],
      },
      Timestamp: {
        date: { start: record.timestamp.toISOString() },
      },
    }

    if (record.templateId) {
      properties.TemplateId = {
        rich_text: [{ text: { content: record.templateId } }],
      }
    }

    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    })
  }

  return sink
}