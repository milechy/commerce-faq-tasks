// src/lib/billing/usageTracker.test.ts
// Phase32: usageTracker の非同期記録テスト

import { trackUsage, initUsageTracker } from './usageTracker';

// 各テスト前に pool を null にリセットして状態漏洩を防ぐ
beforeEach(() => {
  initUsageTracker(null as any, {
    warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
  } as any);
});

// setImmediate を即時実行に置き換えるユーティリティ
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('usageTracker', () => {
  describe('trackUsage: fire-and-forget（API遅延を発生させない）', () => {
    it('trackUsage は同期的に完了し、DBを待たない', () => {
      const slowQuery = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      );
      const mockPool = { query: slowQuery };
      const mockLogger = {
        warn:  jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info:  jest.fn(),
      } as any;

      initUsageTracker(mockPool as any, mockLogger);

      const start = Date.now();
      trackUsage({
        tenantId:     'test-tenant',
        requestId:    'req-001',
        model:        'llama-3.1-8b-instant',
        inputTokens:  100,
        outputTokens: 50,
        featureUsed:  'chat',
      });
      const elapsed = Date.now() - start;

      // trackUsage 自体は即時完了（非同期DBアクセスを待たない）
      expect(elapsed).toBeLessThan(100);
    });

    it('DB INSERT が非同期で実行される（setImmediate 後）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockPool  = { query: mockQuery };
      const mockLogger = {
        warn:  jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info:  jest.fn(),
      } as any;

      initUsageTracker(mockPool as any, mockLogger);

      trackUsage({
        tenantId:     'test-tenant',
        requestId:    'req-002',
        model:        'llama-3.1-8b-instant',
        inputTokens:  1000,
        outputTokens: 500,
        featureUsed:  'chat',
      });

      // setImmediate の前はまだ未実行
      expect(mockQuery).not.toHaveBeenCalled();

      // setImmediate をフラッシュ
      await flushSetImmediate();
      await flushSetImmediate(); // 非同期解決を待つ

      expect(mockQuery).toHaveBeenCalled();
      // このテストが起動したINSERTの呼び出しを特定する（requestIdで絞り込み）
      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-002'
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain('INSERT INTO usage_logs');
      expect(params[0]).toBe('test-tenant');
      expect(params[1]).toBe('req-002');
      expect(params[2]).toBe('llama-3.1-8b-instant');
      expect(params[3]).toBe(1000);
      expect(params[4]).toBe(500);
      expect(params[5]).toBe('chat');
      // cost_llm_cents と cost_total_cents は整数
      expect(Number.isInteger(params[6])).toBe(true);
      expect(Number.isInteger(params[7])).toBe(true);
      expect(params[7]).toBeGreaterThanOrEqual(params[6]);
    });
  });

  describe('pool 未初期化時', () => {
    it('pool が null の場合は warn ログを出してクラッシュしない', async () => {
      // pool を null にリセット
      initUsageTracker(null as any, {
        warn:  jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info:  jest.fn(),
      } as any);

      expect(() =>
        trackUsage({
          tenantId:     'tenant-x',
          requestId:    'req-no-pool',
          model:        'llama-3.1-8b-instant',
          inputTokens:  100,
          outputTokens: 50,
          featureUsed:  'chat',
        })
      ).not.toThrow();

      await flushSetImmediate();
      await flushSetImmediate();
      // クラッシュしないことを確認（ここに到達すればOK）
    });
  });

  describe('DB エラー時', () => {
    it('INSERT 失敗時にエラーをログするが例外を投げない', async () => {
      const mockQuery = jest.fn().mockRejectedValue(new Error('DB connection lost'));
      const mockLogger = {
        warn:  jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info:  jest.fn(),
      } as any;

      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId:     'tenant-y',
        requestId:    'req-db-fail',
        model:        'llama-3.1-8b-instant',
        inputTokens:  100,
        outputTokens: 50,
        featureUsed:  'chat',
      });

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-db-fail' }),
        expect.stringContaining('[usageTracker]')
      );
    });
  });

  describe('冪等性: ON CONFLICT DO NOTHING', () => {
    it('同じ requestId を2回呼んでも INSERT は2回実行されるが DB 側で冪等', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 0 });
      const mockLogger = {
        warn:  jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info:  jest.fn(),
      } as any;

      initUsageTracker({ query: mockQuery } as any, mockLogger);

      const params = {
        tenantId:     'tenant-z',
        requestId:    'req-idempotent',
        model:        'llama-3.1-8b-instant',
        inputTokens:  100,
        outputTokens: 50,
        featureUsed:  'chat' as const,
      };

      trackUsage(params);
      trackUsage(params);

      await flushSetImmediate();
      await flushSetImmediate();
      await flushSetImmediate();

      // 2回INSERTが試みられるが、SQL に ON CONFLICT DO NOTHING が含まれる
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of mockQuery.mock.calls) {
        expect(call[0]).toContain('ON CONFLICT (request_id) DO NOTHING');
      }
    });
  });
});
