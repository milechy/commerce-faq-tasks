

// src/agent/orchestrator/sales/rulesLoader.ts

import {
  SalesRules,
  SalesRulesProvider,
  defaultSalesRules,
  setSalesRulesProvider,
} from "./salesRules";

/**
 * SalesRules をどこからロードするかを抽象化するためのオプション。
 *
 * Phase9 では tenantId のみを想定していますが、
 * 将来的に locale や brand などを足しても互換性が保てるようにしています。
 */
export type SalesRulesLoadOptions = {
  tenantId?: string;
};

/**
 * SalesRules を外部ストア（Notion / DB など）から取得するローダのインターフェース。
 *
 * - 実装例: NotionSalesRulesLoader, DbSalesRulesLoader
 * - Phase9 の段階では、まだ default を返すシンプル実装のみを用意します。
 */
export interface SalesRulesLoader {
  load(options?: SalesRulesLoadOptions): Promise<SalesRules>;
}

/**
 * 何も外部ストアが無い場合のデフォルトローダ。
 *
 * - tests やローカル開発で特に設定しなくても動くようにするための実装です。
 */
export class DefaultSalesRulesLoader implements SalesRulesLoader {
  async load(): Promise<SalesRules> {
    return defaultSalesRules;
  }
}

/**
 * 与えられた Loader を使って、同期的に利用できる SalesRulesProvider を初期化します。
 *
 * - リクエスト前に 1 度だけ呼んでおく
 * - または テナント切り替えごとに呼んで provider を差し替える
 * といった使い方を想定しています。
 *
 * 将来、より高度なキャッシュ戦略（tenantId ごとのキャッシュなど）が必要になったら、
 * ここではなく専用のモジュールをぶら下げる形で拡張できます。
 */
export async function initSalesRulesProviderFromLoader(
  loader: SalesRulesLoader,
  options?: SalesRulesLoadOptions,
): Promise<SalesRules> {
  const rules = await loader.load(options);

  const provider: SalesRulesProvider = () => rules;
  setSalesRulesProvider(provider);

  return rules;
}

/**
 * もっともシンプルな利用パターン向けのヘルパー。
 *
 * - 外部ストアを使わず、defaultSalesRules だけで運用するテナント
 * - テストコード
 *
 * などでは、この関数を呼ぶだけで SalesRulesProvider が初期化されます。
 */
export async function initDefaultSalesRulesProvider(): Promise<SalesRules> {
  const loader = new DefaultSalesRulesLoader();
  return initSalesRulesProviderFromLoader(loader);
}