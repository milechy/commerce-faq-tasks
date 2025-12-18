
// src/agent/orchestrator/sales/notionSalesRulesLoader.ts
//
// Notion から SalesRules をロードするためのローダーの雛形。
// Phase10 ではまだ実際の Notion API 連携は行わず、インターフェイスのみを定義する。

import type { SalesRules } from "./salesRules";
import type { SalesRulesLoader } from "./rulesLoader";

export interface NotionSalesRulesLoaderConfig {
  /** SalesRules が保存されている Notion データベース ID */
  databaseId: string;
  /** Notion API の認証トークン */
  authToken: string;
  /** 明示的に default テナントとして扱いたい tenantId があれば指定 */
  defaultTenantId?: string;
}

export class NotionSalesRulesLoader implements SalesRulesLoader {
  constructor(private readonly config: NotionSalesRulesLoaderConfig) {}

  /**
   * Phase10 時点ではダミー実装。
   * 将来、Notion SDK / HTTP クライアントを用いて
   * - tenantId 別のルール行を取得
   * - SalesRules 型にマッピング
   * するロジックをここに実装する。
   */
  async loadAll(): Promise<Record<string, SalesRules>> {
    const defaultTenantId = this.config.defaultTenantId ?? "default";

    return {
      [defaultTenantId]: {
        premiumHints: [],
        upsellKeywords: [],
        ctaKeywords: [],
      },
    };
  }
}

