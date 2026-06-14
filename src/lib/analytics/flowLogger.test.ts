// src/lib/analytics/flowLogger.test.ts
// Phase72-C: flowLogger の非同期記録テスト（usageTracker.test.ts パターン踏襲）

import { logFlowTransition, initFlowLogger } from './flowLogger';

// 各テスト前に pool を null にリセットして状態漏洩を防ぐ
beforeEach(() => {
  initFlowLogger(null as any, {
    warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
  } as any);
});

// setImmediate を即時実行に置き換えるユーティリティ
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('flowLogger', () => {
  describe('logFlowTransition: INSERT 発火', () => {
    it('logFlowTransition は同期的に完了し、DBを待たない', () => {
      const slowQuery = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );
      const mockPool = { query: slowQuery };
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger(mockPool as any, mockLogger);

      const start = Date.now();
      logFlowTransition({
        tenantId: 'tenant-a',
        sessionId: 'sess-001',
        fromState: 'clarify',
        toState: 'answer',
        turnIndex: 1,
      });
      const elapsed = Date.now() - start;

      // logFlowTransition 自体は即時完了（非同期DBアクセスを待たない）
      expect(elapsed).toBeLessThan(100);
    });

    it('DB INSERT が非同期で実行される（setImmediate 後）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger({ query: mockQuery } as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-z99',
        sessionId: 'sess-z99',
        fromState: 'clarify',
        toState: 'answer',
        turnIndex: 2,
      });

      // setImmediate の前はまだ未実行（この mock だけなので 0 件）
      expect(mockQuery).not.toHaveBeenCalled();

      // setImmediate をフラッシュ
      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockQuery).toHaveBeenCalled();
      // sess-z99 の呼び出しを特定
      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'sess-z99',
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain('INSERT INTO conversation_flow_logs');
      expect(params[0]).toBe('tenant-z99');
      expect(params[1]).toBe('sess-z99');
      expect(params[2]).toBe('clarify');    // from_state
      expect(params[3]).toBe('answer');     // to_state
      expect(params[4]).toBe(2);            // turn_index
    });

    it('metadata が渡された場合、JSONB 列に記録される', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger({ query: mockQuery } as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-b',
        sessionId: 'sess-003',
        fromState: 'confirm',
        toState: 'terminal',
        turnIndex: 5,
        metadata: { terminalReason: 'aborted_loop_detected' },
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const [, params] = mockQuery.mock.calls[0] as [string, any[]];
      const metaJson = params[5] as string;
      const parsed = JSON.parse(metaJson);
      expect(parsed).toMatchObject({ terminalReason: 'aborted_loop_detected' });
    });

    it('fromState が undefined の場合、null として記録される（セッション初回遷移）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger({ query: mockQuery } as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-c',
        sessionId: 'sess-004',
        fromState: undefined,
        toState: 'clarify',
        turnIndex: 0,
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const [, params] = mockQuery.mock.calls[0] as [string, any[]];
      expect(params[2]).toBeNull(); // from_state = null
    });
  });

  describe('pool 未初期化時', () => {
    it('pool が null の場合は warn ログを出してクラッシュしない', async () => {
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;
      initFlowLogger(null as any, mockLogger);

      expect(() =>
        logFlowTransition({
          tenantId: 'tenant-x',
          sessionId: 'sess-no-pool',
          fromState: 'clarify',
          toState: 'answer',
          turnIndex: 1,
        }),
      ).not.toThrow();

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-no-pool' }),
        expect.stringContaining('[flowLogger]'),
      );
    });
  });
});
