// src/lib/hermesConsent.ts
// Phase75: Hermes Agent(CVR学習エージェント)向けデータ利用同意チェック
//
// テナントの会話ログ生データをHermes Agent(外部, MCP経由)に公開してよいかを判定する。
// fail-safe設計: features.hermes_raw_data_consent が明示的に true でない限り、
// 常に false(=非公開)として扱う。新規テナント・未設定テナントは自動的に除外される。

import { getPool } from "./db";

export async function isHermesDataConsentGranted(tenantId: string): Promise<boolean> {
  const pool = getPool();
  try {
    const result = await pool.query<{ features: { hermes_raw_data_consent?: boolean } | null }>(
      `SELECT features FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return result.rows[0]?.features?.hermes_raw_data_consent === true;
  } catch {
    // DB障害時は fail-safe で非公開扱い(データ露出よりも可用性低下を優先)
    return false;
  }
}

/**
 * 同意済みテナントのIDを全件取得する。
 * MCPサーバーが公開してよいテナント一覧を返す用途。
 */
export async function listHermesConsentingTenantIds(): Promise<string[]> {
  const pool = getPool();
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE features->>'hermes_raw_data_consent' = 'true'`,
    );
    return result.rows.map((r) => r.id);
  } catch {
    return [];
  }
}
