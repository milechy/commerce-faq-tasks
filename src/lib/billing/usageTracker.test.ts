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

    it('Subtask 3: extraLlmUsages の planner トークンを永続化列にも合算する', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId:     'test-tenant',
        requestId:    'req-planner-001',
        model:        'llama-3.1-70b-versatile',
        inputTokens:  1000,
        outputTokens: 500,
        featureUsed:  'chat',
        extraLlmUsages: [
          { model: 'openai/gpt-oss-20b', inputTokens: 300, outputTokens: 60 },
        ],
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-planner-001'
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      // input/output_tokens 列に planner 分が合算されている（cost との整合）
      expect(params[3]).toBe(1300); // 1000 + 300
      expect(params[4]).toBe(560);  // 500 + 60
      // model 列は chat 本体（代表モデル）のまま
      expect(params[2]).toBe('llama-3.1-70b-versatile');
    });
  });

  // GID 1216944049264977: これまでtrackUsage対象外だった外部API課金経路
  describe('未計測だった外部API課金経路のpass-through', () => {
    it('extraLlmUsagesに価格表未登録のモデルが来てもwarnログを出しコスト0で黙って落ちない', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId:     'test-tenant',
        requestId:    'req-unknown-model',
        model:        'qwen-vl-max-latest',
        inputTokens:  0,
        outputTokens: 0,
        featureUsed:  'book_analysis',
        extraLlmUsages: [{ model: 'totally-unknown-model-xyz', inputTokens: 100, outputTokens: 0 }],
      });

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-unknown-model', model: 'totally-unknown-model-xyz' }),
        expect.stringContaining('no price entry'),
      );
      // warnを出しつつクラッシュせずINSERTは実行される（コストは黙って0になるが記録は続く）
      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-unknown-model'
      );
      expect(insertCall).toBeDefined();
    });

    it('ocrPagesがcost_total_centsに反映される（costCalculator.test.tsのocrPages=3ケースと同額）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId:     'test-tenant',
        requestId:    'req-ocr-pages',
        model:        'qwen-vl-max-latest',
        inputTokens:  0,
        outputTokens: 0,
        featureUsed:  'book_analysis',
        ocrPages:     3,
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-ocr-pages'
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      expect(params[7]).toBe(4); // serverCost + 3ページ分のQWEN_OCR_COST_PER_PAGE_USD、切り上げ
    });
  });

  // GID 1216944003337186: usage_logs.billable フラグ（NON_BILLABLE_FEATURESから自動判定）
  describe('billableフラグの自動判定・pass-through', () => {
    it('featureUsed=chat（課金対象）はbillable=trueでINSERTされる', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId: 'test-tenant',
        requestId: 'req-billable-chat',
        model: 'llama-3.1-8b-instant',
        inputTokens: 100,
        outputTokens: 50,
        featureUsed: 'chat',
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-billable-chat'
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain('billable');
      expect(params[params.length - 1]).toBe(true);
    });

    it('featureUsed=admin_tuning（NON_BILLABLE_FEATURES）はbillable=falseでINSERTされ、costは0にならない', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId: 'test-tenant',
        requestId: 'req-non-billable-tuning',
        model: 'llama-3.1-8b-instant',
        inputTokens: 1000,
        outputTokens: 500,
        featureUsed: 'admin_tuning',
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-non-billable-tuning'
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      expect(params[params.length - 1]).toBe(false); // billable=false
      expect(params[7]).toBeGreaterThan(0); // cost_total_centsは原価可視化のため0にならない
    });

    it('featureUsed=sai_agent（NON_BILLABLE_FEATURES）もbillable=falseになる', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId: 'test-tenant',
        requestId: 'req-sai-agent-non-billable',
        model: 'agent-s',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'sai_agent',
        saiAgentSteps: 3,
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-sai-agent-non-billable'
      );
      const [, params] = insertCall!;
      expect(params[params.length - 1]).toBe(false);
    });

    it('billableを明示指定すると自動判定より優先される（オーバーライド）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId: 'test-tenant',
        requestId: 'req-explicit-billable-override',
        model: 'llama-3.1-8b-instant',
        inputTokens: 10,
        outputTokens: 10,
        featureUsed: 'chat', // 通常はbillable=trueになる機能
        billable: false,     // 明示的にfalseを指定
      });

      await flushSetImmediate();
      await flushSetImmediate();

      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-explicit-billable-override'
      );
      const [, params] = insertCall!;
      expect(params[params.length - 1]).toBe(false);
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

  // GID: calculateBillingAmountCentsが例外を投げるケース(負値ガード等)が実際に
  // trackUsage経由で発生した場合、INSERT自体はクラッシュせずcostTotalCents=0で
  // 継続することを固定する。この経路はこれまでテストされていなかった。
  describe('原価計算エラー時（負値ガード等でcalculateBillingAmountCentsが例外を投げた場合）', () => {
    it('asrAudioSecondsが負の場合、warnログを出しcost_total_cents=0でINSERTは継続する（クラッシュしない）', async () => {
      const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
      initUsageTracker({ query: mockQuery } as any, mockLogger);

      trackUsage({
        tenantId: 'test-tenant',
        requestId: 'req-negative-asr-seconds',
        model: 'fish-audio-asr',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'voice',
        asrAudioSeconds: -100,
      });

      await flushSetImmediate();
      await flushSetImmediate();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-negative-asr-seconds' }),
        expect.stringContaining('cost calculation error'),
      );
      const insertCall = mockQuery.mock.calls.find(
        ([, p]: [string, any[]]) => p?.[1] === 'req-negative-asr-seconds'
      );
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      // cost_llm_cents / cost_total_cents 列は両方0にフォールバックする
      expect(params[6]).toBe(0);
      expect(params[7]).toBe(0);
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
