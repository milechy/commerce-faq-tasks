// src/integrations/notion/clarifyLogWriter.ts
import { Client, isNotionClientError } from "@notionhq/client";

export interface ClarifyLogInput {
  originalQuestion: string;
  clarifyQuestion: string;
  missingInfo?: string;
  intent?: string;
  tenantId?: string;
}

export class ClarifyLogWriter {
  private readonly client: Client;
  private readonly databaseId: string;

  constructor(opts?: { apiKey?: string; databaseId?: string }) {
    const apiKey = opts?.apiKey ?? process.env.NOTION_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[ClarifyLogWriter] NOTION_API_KEY is not set in environment variables"
      );
    }

    const dbId = opts?.databaseId ?? process.env.NOTION_DB_CLARIFY_LOG_ID;
    if (!dbId) {
      throw new Error("[ClarifyLogWriter] NOTION_DB_CLARIFY_LOG_ID is not set");
    }

    this.client = new Client({
      auth: apiKey,
      notionVersion: "2025-09-03",
    });
    this.databaseId = dbId;
  }

  async createLog(input: ClarifyLogInput): Promise<void> {
    const title = this.buildTitle(input);

    try {
      await this.client.pages.create({
        parent: { database_id: this.databaseId },
        properties: {
          // タイトル
          Title: {
            title: [{ type: "text", text: { content: title } }],
          },
          // 元質問
          Original: {
            rich_text: [
              { type: "text", text: { content: input.originalQuestion } },
            ],
          },
          // Clarify 質問
          Clarify: {
            rich_text: [
              { type: "text", text: { content: input.clarifyQuestion } },
            ],
          },
          // 不足情報メモ
          ...(input.missingInfo
            ? {
                Missing: {
                  rich_text: [
                    {
                      type: "text",
                      text: { content: input.missingInfo },
                    },
                  ],
                },
              }
            : {}),
          // Intent
          ...(input.intent
            ? {
                Intent: {
                  rich_text: [
                    { type: "text", text: { content: input.intent } },
                  ],
                },
              }
            : {}),
          // TenantId
          ...(input.tenantId
            ? {
                TenantId: {
                  rich_text: [
                    { type: "text", text: { content: input.tenantId } },
                  ],
                },
              }
            : {}),
        },
      });
    } catch (err: any) {
      if (isNotionClientError(err)) {
        console.error(
          "[ClarifyLogWriter] Notion API error",
          JSON.stringify(
            {
              code: err.code,
              message: err.message,
            },
            null,
            2
          )
        );
      } else {
        console.error("[ClarifyLogWriter] Unknown error", err);
      }
      throw err;
    }
  }

  private buildTitle(input: ClarifyLogInput): string {
    const intentPart = input.intent ? `[${input.intent}]` : "";
    const preview = input.originalQuestion.slice(0, 30);
    return `Clarify ${intentPart} ${preview}`;
  }
}
