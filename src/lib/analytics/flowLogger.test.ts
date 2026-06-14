// src/lib/analytics/flowLogger.test.ts
// Phase72-C: flowLogger ユニットテスト

import { logFlowTransition, initFlowLogger } from './flowLogger';

// 各テスト前に pool を null にリセット
beforeEach(() => {
  initFlowLogger(null as any, {
    warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
  } as any);
});

function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('flowLogger', () => {
  describe('logFlowTransition: fire-and-forget', () => {
    it('pool 未初期化時は warn を出してスキップする', async () => {
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;
      // pool を null のまま使う
      initFlowLogger(null as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-1',
        sessionId: 'session-abc',
        fromState: 'clarify',
        toState: 'answer',
        turnIndex: 1,
      });

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-abc' }),
        expect.stringContaining('pool not initialized'),
      );
    });

    it('INSERT を非同期で発行する（setImmediate 後）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockPool = { query: mockQuery };
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger(mockPool as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-1',
        sessionId: 'session-abc',
        fromState: 'clarify',
        toState: 'answer',
        turnIndex: 2,
      });

      // setImmediate 前は未実行
      expect(mockQuery).not.toHaveBeenCalled();

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO conversation_flow_logs');
      expect(params[0]).toBe('tenant-1');  // tenantId
      expect(params[1]).toBe('session-abc'); // sessionId
      expect(params[2]).toBe('clarify');   // from_state
      expect(params[3]).toBe('answer');    // to_state
      expect(params[4]).toBe(2);           // turn_index
    });

    it('terminal 遷移時に metadata.reason が保存される', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockPool = { query: mockQuery };
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger(mockPool as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-1',
        sessionId: 'session-xyz',
        fromState: 'confirm',
        toState: 'terminal',
        turnIndex: 5,
        metadata: { reason: 'completed' },
      });

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      const metadataStr = params[5] as string;
      const metadata = JSON.parse(metadataStr);
      expect(metadata).toEqual({ reason: 'completed' });
    });

    it('fromState が null でも正常に INSERT される', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockPool = { query: mockQuery };
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger(mockPool as any, mockLogger);

      logFlowTransition({
        tenantId: 'tenant-1',
        sessionId: 'session-new',
        fromState: null,
        toState: 'clarify',
        turnIndex: 1,
      });

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[2]).toBeNull(); // from_state
    });

    it('DB エラーは API を止めずにエラーログのみ出す', async () => {
      const mockQuery = jest.fn().mockRejectedValue(new Error('DB connection failed'));
      const mockPool = { query: mockQuery };
      const mockLogger = {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any;

      initFlowLogger(mockPool as any, mockLogger);

      // エラーでも例外を投げない（fire-and-forget）
      expect(() =>
        logFlowTransition({
          tenantId: 'tenant-err',
          sessionId: 'session-err',
          fromState: 'clarify',
          toState: 'terminal',
          turnIndex: 3,
        })
      ).not.toThrow();

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-err' }),
        expect.stringContaining('db insert failed'),
      );
    });
  });
});
