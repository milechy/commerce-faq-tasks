
// src/agent/orchestrator/sales/dbSalesRulesLoader.ts
//
// アプリケーション側の DB から SalesRules をロードするためのローダーの雛形。
// Phase10 では DB スキーマが未確定のため、インターフェイスのみを定義する。

import type { SalesRules } from "./salesRules";
import type { SalesRulesLoader } from "./rulesLoader";

/**
 * DB アクセス用の依存。
 * 既存の DB クライアント（例: Prisma / knex / 独自クエリヘルパ）を
 * ラップすることを想定している。
 */
export interface DbSalesRulesLoaderDeps {
  query: (sql: string, params?: unknown[]) => Promise<any[]>;
}

export class DbSalesRulesLoader implements SalesRulesLoader {
  constructor(private readonly deps: DbSalesRulesLoaderDeps) {}

  /**
   * Phase10 時点ではダミー実装。
   * 将来、sales_rules テーブル（仮）等から
   * - tenantId
   * - premiumHints / upsellKeywords / ctaKeywords
   * を取得して SalesRules にマッピングする。
   */
  async loadAll(): Promise<Record<string, SalesRules>> {
    // const rows = await this.deps.query("SELECT tenant_id, ... FROM sales_rules");
    // const byTenant: Record<string, SalesRules> = {};
    // rows.forEach((row) => { byTenant[row.tenant_id] = ... });
    // return byTenant;

    return {
      default: {
        premiumHints: [],
        upsellKeywords: [],
        ctaKeywords: [],
      },
    };
  }
}

