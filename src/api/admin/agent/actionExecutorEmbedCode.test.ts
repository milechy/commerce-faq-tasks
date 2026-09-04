// src/api/admin/agent/actionExecutorEmbedCode.test.ts
//
// WP-14(FR-29 / §12.3 I-10): get_embed_code が WordPress プラグイン経由テナント
// (tenants.provisioning_source='wordpress_plugin')に手貼りコードを勧めないことを
// 固定する。手貼りを案内すると、プラグインが既に設置したウィジェットと二重に
// 表示される事故になるため、このガードは分岐の有無そのものが受け入れ条件。

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Pool } from 'pg';
import { executeToolCall, type ActionResult } from './actionExecutor';

const TENANT = 'acme';
const ACTOR = { role: 'owner', email: 'owner@example.com' };

function resultText(result: ActionResult): string {
  return typeof result === 'string' ? result : result.text;
}

/** SQLの内容に応じて振る舞いを変えるモックPool。 */
function makeMockPool(opts: {
  /** undefinedなら列自体をレスポンス行から省く(migration未適用DBの再現)。 */
  provisioningSource?: string;
  widgetTheme?: Record<string, unknown> | null;
  keyPrefix?: string | null;
}): Pool {
  const query = jest.fn(async (sql: string) => {
    if (String(sql).includes('FROM tenant_api_keys')) {
      return {
        rows: opts.keyPrefix == null ? [] : [{ key_prefix: opts.keyPrefix }],
      };
    }
    if (String(sql).includes('FROM tenants')) {
      const row: Record<string, unknown> = { widget_theme: opts.widgetTheme ?? null };
      if (opts.provisioningSource !== undefined) row['provisioning_source'] = opts.provisioningSource;
      return { rows: [row] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query } as unknown as Pool;
}

describe('executeToolCall: get_embed_code はprovisioning_sourceで分岐する(WP-14/FR-29)', () => {
  it('provisioning_source=wordpress_pluginのテナントには手貼りコードを出さず、プラグイン設置済みの案内を返す', async () => {
    const pool = makeMockPool({ provisioningSource: 'wordpress_plugin', keyPrefix: 'rjc_abc123' });

    const result = await executeToolCall('get_embed_code', {}, TENANT, pool, 'session-1', false, ACTOR);
    const text = resultText(result);

    expect(text).toContain('WordPress プラグインで既にウィジェットが設置されています');
    expect(text).not.toContain('<script');
    expect(text).not.toContain('埋め込みコードのひな形');
  });

  it('provisioning_source=manual(既定)のテナントには従来どおり埋め込みコードのひな形を返す', async () => {
    const pool = makeMockPool({ provisioningSource: 'manual', keyPrefix: 'rjc_abc123' });

    const result = await executeToolCall('get_embed_code', {}, TENANT, pool, 'session-1', false, ACTOR);
    const text = resultText(result);

    expect(text).toContain('埋め込みコードのひな形');
    expect(text).toContain('<script');
    expect(text).not.toContain('既にウィジェットが設置されています');
  });

  it('provisioning_source列が無い(未適用DBを想定した旧い応答形状)場合も従来どおり埋め込みコードを返す', async () => {
    const pool = makeMockPool({ keyPrefix: 'rjc_abc123' });

    const result = await executeToolCall('get_embed_code', {}, TENANT, pool, 'session-1', false, ACTOR);
    const text = resultText(result);

    expect(text).toContain('埋め込みコードのひな形');
  });
});
