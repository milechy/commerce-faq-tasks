/**
 * agentMetrics ユニットテスト
 *
 * - 正常系: metrics_snapshots へ期待した行形状で INSERT する
 * - DB エラーは握りつぶす（throw せず logger.warn する）
 * - tenantId=null（テナント未特定の super_admin）でも記録できる
 */

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { recordAgentMetric } from './agentMetrics';
import { logger } from '../logger';

const mockQuery = jest.fn();
const mockDb = { query: mockQuery } as unknown as import('pg').Pool;

describe('recordAgentMetric', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('metrics_snapshots へ metric_name / tenant_id / labels / value を INSERT する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordAgentMetric(mockDb, {
      metricName: 'agent_tool_invoked',
      tenantId: 'tenant-abc',
      labels: { tool: 'get_faq_list', outcome: 'ok' },
      value: 1,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO metrics_snapshots');
    expect(sql).toContain('(metric_name, tenant_id, labels, value)');
    expect(values).toEqual([
      'agent_tool_invoked',
      'tenant-abc',
      JSON.stringify({ tool: 'get_faq_list', outcome: 'ok' }),
      1,
    ]);
  });

  it('value にカウント以外の数値（ホップ数）も記録できる', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordAgentMetric(mockDb, {
      metricName: 'agent_turn_hops',
      tenantId: 'tenant-abc',
      labels: { hit_limit: false },
      value: 3,
    });

    const [, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(values[2]).toBe(JSON.stringify({ hit_limit: false }));
    expect(values[3]).toBe(3);
  });

  it('DB エラーは throw せず logger.warn に落とす', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "metrics_snapshots" does not exist'));

    await expect(
      recordAgentMetric(mockDb, {
        metricName: 'agent_turn_completed',
        tenantId: 'tenant-abc',
        labels: { answered_from: 'general' },
        value: 1,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it('tenantId が null（テナント未特定の super_admin）でも記録する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await recordAgentMetric(mockDb, {
      metricName: 'agent_legacy_handoff',
      tenantId: null,
      labels: { feature: 'billing' },
      value: 1,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(values[1]).toBeNull();
  });
});
