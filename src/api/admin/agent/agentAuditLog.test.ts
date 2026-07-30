// src/api/admin/agent/agentAuditLog.test.ts
// チャット経由のテナント設定変更を tenant_settings_history へ記録する監査ログのテスト

jest.mock('../../../lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { recordAgentSettingsChange } from './agentAuditLog';
import { logger } from '../../../lib/logger';

const mockQuery = jest.fn();
const mockDb = { query: mockQuery } as any;

describe('recordAgentSettingsChange', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('tenant_settings_history へ1行 INSERT する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordAgentSettingsChange(mockDb, {
      tenantId: 'tenant-abc',
      changedBy: 'admin@example.com',
      fieldName: 'ga4_measurement_id',
      oldValue: 'G-OLD111',
      newValue: 'G-NEW222',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO tenant_settings_history');
    expect(sql).toContain('(tenant_id, changed_by, field_name, old_value, new_value)');
    expect(params).toEqual([
      'tenant-abc',
      'admin@example.com',
      'ga4_measurement_id',
      JSON.stringify('G-OLD111'),
      JSON.stringify('G-NEW222'),
    ]);
  });

  it('oldValue が null の場合は SQL NULL のまま渡す（jsonb の "null" に変換しない）', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordAgentSettingsChange(mockDb, {
      tenantId: 'tenant-abc',
      changedBy: 'admin@example.com',
      fieldName: 'posthog_host',
      oldValue: null,
      newValue: 'https://app.posthog.com',
    });

    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(JSON.stringify('https://app.posthog.com'));
  });

  it('oldValue が undefined でも null として受け付ける', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordAgentSettingsChange(mockDb, {
      tenantId: 'tenant-abc',
      changedBy: 'admin@example.com',
      fieldName: 'widget_theme',
      oldValue: undefined,
      newValue: { primaryColor: '#3B82F6' },
    });

    const [, params] = mockQuery.mock.calls[0]!;
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(JSON.stringify({ primaryColor: '#3B82F6' }));
  });

  it('DBエラーは logger.warn に落とすだけで呼び出し側へ投げない', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));

    await expect(
      recordAgentSettingsChange(mockDb, {
        tenantId: 'tenant-abc',
        changedBy: 'admin@example.com',
        fieldName: 'ga4_measurement_id',
        oldValue: null,
        newValue: 'G-NEW222',
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tenant_settings_history'),
      expect.any(Error),
    );
  });
});
