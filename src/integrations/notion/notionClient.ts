// src/integrations/notion/notionClient.ts
import { Client, isNotionClientError } from "@notionhq/client";

export interface QueryDatabaseArgs {
  databaseId: string;
  filter?: any;
  sorts?: any;
  start_cursor?: string;
  page_size?: number;
}

export interface INotionClient {
  queryDatabaseAll<T = unknown>(args: QueryDatabaseArgs): Promise<T[]>;
}

export interface NotionClientConfig {
  apiKey?: string;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
  defaultPageSize?: number;
}

export class NotionClient implements INotionClient {
  private readonly client: Client;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private readonly defaultPageSize: number;
  private readonly dataSourceIdCache = new Map<string, string>();

  constructor(config: NotionClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.NOTION_API_KEY;

    if (!apiKey) {
      throw new Error(
        "[NotionClient] NOTION_API_KEY is not set in environment variables"
      );
    }

    this.client = new Client({
      auth: apiKey,
      notionVersion: "2025-09-03",
    });
    this.logger = config.logger ?? console;
    this.defaultPageSize = config.defaultPageSize ?? 100;
  }

  async queryDatabaseAll<T = unknown>(args: QueryDatabaseArgs): Promise<T[]> {
    const { databaseId, ...rest } = args;
    const dataSourceId = await this.resolveDataSourceId(databaseId);
    const pageSize =
      typeof rest.page_size === "number"
        ? rest.page_size
        : this.defaultPageSize;

    let cursor: string | undefined = rest.start_cursor;
    const allResults: T[] = [];

    this.logger.info?.(
      `[NotionClient] queryDatabaseAll start (databaseId=${databaseId})`
    );

    try {
      while (true) {
        const response: any = await (this.client as any).dataSources.query({
          // v5 では dataSources.query を使い、data_source_id を指定する
          data_source_id: dataSourceId,
          page_size: pageSize,
          start_cursor: cursor,
          // filter / sorts だけを明示的に渡す
          ...(rest.filter ? { filter: rest.filter } : {}),
          ...(rest.sorts ? { sorts: rest.sorts } : {}),
        });

        allResults.push(...(response.results as T[]));

        this.logger.debug?.(
          `[NotionClient] fetched ${response.results.length} items (has_more=${response.has_more})`
        );

        if (!response.has_more || !response.next_cursor) {
          break;
        }

        cursor = response.next_cursor as string | undefined;
      }

      this.logger.info?.(
        `[NotionClient] queryDatabaseAll done (databaseId=${databaseId}, total=${allResults.length})`
      );

      return allResults;
    } catch (err: unknown) {
      this.handleError(err, {
        operation: "queryDatabaseAll",
        databaseId,
      });
      throw err;
    }
  }

  private async resolveDataSourceId(databaseId: string): Promise<string> {
    if (this.dataSourceIdCache.has(databaseId)) {
      return this.dataSourceIdCache.get(databaseId)!;
    }

    this.logger.info?.(
      `[NotionClient] resolveDataSourceId start (databaseId=${databaseId})`,
    );

    try {
      const response: any = await (this.client as any).request({
        method: "get",
        path: `databases/${databaseId}`,
      });

      const dataSources: any[] = response?.data_sources ?? [];
      if (!dataSources.length || !dataSources[0]?.id) {
        throw new Error(
          `[NotionClient] No data_sources found for database ${databaseId}`,
        );
      }

      const dataSourceId = String(dataSources[0].id);
      this.dataSourceIdCache.set(databaseId, dataSourceId);

      this.logger.info?.(
        `[NotionClient] resolveDataSourceId done (databaseId=${databaseId}, dataSourceId=${dataSourceId})`,
      );

      return dataSourceId;
    } catch (err: unknown) {
      this.handleError(err, {
        operation: "resolveDataSourceId",
        databaseId,
      });
      throw err;
    }
  }

  private handleError(err: unknown, context: Record<string, unknown> = {}) {
    if (isNotionClientError(err)) {
      this.logger.error?.(
        "[NotionClient] Notion API error",
        JSON.stringify(
          {
            code: err.code,
            message: err.message,
            context,
          },
          null,
          2
        )
      );
      return;
    }

    this.logger.error?.(
      "[NotionClient] Unknown error",
      JSON.stringify({ err, context }, null, 2)
    );
  }
}
