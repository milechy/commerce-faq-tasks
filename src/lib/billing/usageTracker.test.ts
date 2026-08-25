// src/lib/billing/usageTracker.test.ts
// Phase32: usageTracker の非同期記録テスト

import { trackUsage, initUsageTracker, invalidateBillingPlanCache } from './usageTracker';

/**
 * INSERT INTO usage_logs のパラメータ配列における billable($13) の添字。
 * plan($14) / plan_multiplier($15) を後ろに足したため末尾からは取れない。
 */
const BILLABLE_PARAM_INDEX = 12;
const PLAN_PARAM_INDEX = 13;
const PLAN_MULTIPLIER_PARAM_INDEX = 14;

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
      expect(params[BILLABLE_PARAM_INDEX]).toBe(true);
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
      expect(params[BILLABLE_PARAM_INDEX]).toBe(false); // billable=false
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
      expect(params[BILLABLE_PARAM_INDEX]).toBe(false);
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
      expect(params[BILLABLE_PARAM_INDEX]).toBe(false);
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
      const insertCalls = mockQuery.mock.calls.filter(
        ([sql]: [string]) => sql.includes('INSERT INTO usage_logs')
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of insertCalls) {
        expect(call[0]).toContain('ON CONFLICT (request_id) DO NOTHING');
      }
    });
  });
  // ─── プラン倍率の焼き付け（遡及請求の封じ込め） ─────────────────────────────
  describe('plan / plan_multiplier の焼き付け', () => {
    /** plan の SELECT には rows を返し、INSERT には rowCount を返す mock */
    function makePool(planValue: string | null) {
      const query = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT plan FROM tenants')) {
          return Promise.resolve({ rows: planValue === null ? [] : [{ plan: planValue }] });
        }
        return Promise.resolve({ rowCount: 1 });
      });
      return query;
    }

    function findInsert(mockQuery: jest.Mock, requestId: string) {
      const call = mockQuery.mock.calls.find(
        ([sql, p]: [string, any[]]) => sql.includes('INSERT INTO usage_logs') && p?.[1] === requestId
      );
      return call![1];
    }

    async function track(mockQuery: jest.Mock, requestId: string) {
      initUsageTracker({ query: mockQuery } as any, {
        warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(),
      } as any);
      trackUsage({
        tenantId: 'tenant-plan-stamp',
        requestId,
        model: 'llama-3.1-8b-instant',
        inputTokens: 10,
        outputTokens: 10,
        featureUsed: 'chat',
      });
      await flushSetImmediate();
      await flushSetImmediate();
      await flushSetImmediate();
    }

    it.each([
      ['free_ad', 0],
      ['starter', 1.0],
      ['growth', 1.5],
      ['enterprise', 2.5],
    ])('plan=%s は倍率 %s を行に焼き付ける', async (plan, expected) => {
      const mockQuery = makePool(plan);
      await track(mockQuery, `req-stamp-${plan}`);
      const params = findInsert(mockQuery, `req-stamp-${plan}`);
      expect(params[PLAN_PARAM_INDEX]).toBe(plan);
      expect(params[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(expected);
    });

    it('free_ad の 0 は「倍率0」として焼かれ、1.0 にすり替わらない', async () => {
      const mockQuery = makePool('free_ad');
      await track(mockQuery, 'req-stamp-free-ad-zero');
      const params = findInsert(mockQuery, 'req-stamp-free-ad-zero');
      expect(params[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(0);
      expect(params[PLAN_MULTIPLIER_PARAM_INDEX]).not.toBe(1.0);
    });

    // ★fail-safe の向き★ ここが本変更の最大の罠。
    // 機能ゲート用 queryTenantPlan は取得失敗時 free_ad(=倍率0) を返すが、
    // その値を焼き付けると請求が恒久的に 0 円で固着する。
    it('テナントが見つからない場合は free_ad ではなく NULL を焼く', async () => {
      const mockQuery = makePool(null); // rows: []
      await track(mockQuery, 'req-stamp-missing-tenant');
      const params = findInsert(mockQuery, 'req-stamp-missing-tenant');
      expect(params[PLAN_PARAM_INDEX]).toBeNull();
      expect(params[PLAN_MULTIPLIER_PARAM_INDEX]).toBeNull();
    });

    it('未知のプラン文字列も free_ad へ倒さず NULL を焼く', async () => {
      const mockQuery = makePool('legacy-unknown-plan');
      await track(mockQuery, 'req-stamp-unknown-plan');
      const params = findInsert(mockQuery, 'req-stamp-unknown-plan');
      expect(params[PLAN_PARAM_INDEX]).toBeNull();
      expect(params[PLAN_MULTIPLIER_PARAM_INDEX]).toBeNull();
    });

    it('プラン取得がDB障害で落ちても NULL を焼き、利用記録自体は残す', async () => {
      const query = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT plan FROM tenants')) {
          return Promise.reject(new Error('connection terminated'));
        }
        return Promise.resolve({ rowCount: 1 });
      });
      await track(query, 'req-stamp-db-down');
      const params = findInsert(query, 'req-stamp-db-down');
      expect(params[PLAN_PARAM_INDEX]).toBeNull();
      expect(params[PLAN_MULTIPLIER_PARAM_INDEX]).toBeNull();
      // 記録が消えないこと（INSERT は実行されている）
      expect(params[1]).toBe('req-stamp-db-down');
    });

    it('確定したプランは60秒キャッシュされ、行ごとにSELECTしない', async () => {
      const mockQuery = makePool('growth');
      await track(mockQuery, 'req-stamp-cache-1');
      trackUsage({
        tenantId: 'tenant-plan-stamp',
        requestId: 'req-stamp-cache-2',
        model: 'llama-3.1-8b-instant',
        inputTokens: 10, outputTokens: 10, featureUsed: 'chat',
      });
      await flushSetImmediate();
      await flushSetImmediate();

      const planSelects = mockQuery.mock.calls.filter(
        ([sql]: [string]) => sql.includes('SELECT plan FROM tenants')
      );
      expect(planSelects.length).toBe(1);
      expect(findInsert(mockQuery, 'req-stamp-cache-2')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(1.5);
    });

    it('未確定(null)はキャッシュせず、次のリクエストで再取得する', async () => {
      let planValue: string | null = null;
      const mockQuery = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT plan FROM tenants')) {
          return Promise.resolve({ rows: planValue === null ? [] : [{ plan: planValue }] });
        }
        return Promise.resolve({ rowCount: 1 });
      });
      await track(mockQuery, 'req-stamp-nocache-1');
      planValue = 'enterprise'; // 障害から復旧
      trackUsage({
        tenantId: 'tenant-plan-stamp',
        requestId: 'req-stamp-nocache-2',
        model: 'llama-3.1-8b-instant',
        inputTokens: 10, outputTokens: 10, featureUsed: 'chat',
      });
      await flushSetImmediate();
      await flushSetImmediate();

      expect(findInsert(mockQuery, 'req-stamp-nocache-2')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(2.5);
    });
    it('migration 未適用(42703)でも旧カラム構成で記録を継続する', async () => {
      const errorLog = jest.fn();
      const mockQuery = jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT plan FROM tenants')) {
          return Promise.resolve({ rows: [{ plan: 'growth' }] });
        }
        if (sql.includes('plan_multiplier')) {
          const e: any = new Error('column "plan_multiplier" of relation "usage_logs" does not exist');
          e.code = '42703';
          return Promise.reject(e);
        }
        return Promise.resolve({ rowCount: 1 });
      });
      initUsageTracker({ query: mockQuery } as any, {
        warn: jest.fn(), error: errorLog, debug: jest.fn(), info: jest.fn(),
      } as any);
      trackUsage({
        tenantId: 'tenant-no-migration',
        requestId: 'req-42703',
        model: 'llama-3.1-8b-instant',
        inputTokens: 10, outputTokens: 10, featureUsed: 'chat',
      });
      await flushSetImmediate();
      await flushSetImmediate();
      await flushSetImmediate();

      // 旧カラム構成(13パラメータ)での INSERT が実行されている
      const legacyInsert = mockQuery.mock.calls.find(
        ([sql, p]: [string, any[]]) =>
          sql.includes('INSERT INTO usage_logs') && !sql.includes('plan_multiplier') && p?.[1] === 'req-42703'
      );
      expect(legacyInsert).toBeDefined();
      expect(legacyInsert![1]).toHaveLength(13);
      // 気づけるように error で鳴らす（warn ではなく）
      expect(errorLog).toHaveBeenCalled();
    });
  });
});

// ─── #920↔#921 の継ぎ目・テナント境界・fail-safe の向き ─────────────────────
describe('請求用プランキャッシュの継ぎ目', () => {
  function makePool(planByTenant: Record<string, string>) {
    return jest.fn().mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('SELECT plan FROM tenants')) {
        const plan = planByTenant[params[0]];
        return Promise.resolve({ rows: plan ? [{ plan }] : [] });
      }
      return Promise.resolve({ rowCount: 1 });
    });
  }

  async function track(tenantId: string, requestId: string) {
    trackUsage({
      tenantId, requestId, model: 'llama-3.1-8b-instant',
      inputTokens: 10, outputTokens: 10, featureUsed: 'chat',
    });
    await flushSetImmediate();
    await flushSetImmediate();
    await flushSetImmediate();
  }

  const insertFor = (q: jest.Mock, requestId: string) =>
    q.mock.calls.find(
      ([sql, p]: [string, any[]]) => sql.includes('INSERT INTO usage_logs') && p?.[1] === requestId
    )![1];

  const planSelects = (q: jest.Mock) =>
    q.mock.calls.filter(([sql]: [string]) => sql.includes('SELECT plan FROM tenants'));

  // ★#921 のプラン変更が #920 の焼き付けに届くか★
  // ルート側の invalidateBillingPlanCache を消しても、レスポンスも他テストも緑のまま。
  // ここが唯一「変更後の最初の1件から新倍率で焼かれる」ことを守っている。
  it('invalidateBillingPlanCache 後は次の記録で新しいプランを引き直す', async () => {
    const plans: Record<string, string> = { t1: 'starter' };
    const q = makePool(plans);
    initUsageTracker({ query: q } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);

    await track('t1', 'r1');
    expect(insertFor(q, 'r1')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(1.0);

    plans.t1 = 'enterprise';           // プラン変更が起きた
    invalidateBillingPlanCache('t1');  // ルートが呼ぶはずの無効化

    await track('t1', 'r2');
    expect(insertFor(q, 'r2')[PLAN_PARAM_INDEX]).toBe('enterprise');
    expect(insertFor(q, 'r2')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(2.5);
  });

  it('無効化しなければ TTL 内は旧プランのまま（無効化が効いていることの対照）', async () => {
    const plans: Record<string, string> = { t1: 'starter' };
    const q = makePool(plans);
    initUsageTracker({ query: q } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);

    await track('t1', 'r1');
    plans.t1 = 'enterprise';
    await track('t1', 'r2'); // 無効化しない

    expect(insertFor(q, 'r2')[PLAN_PARAM_INDEX]).toBe('starter');
    expect(planSelects(q)).toHaveLength(1);
  });

  it('無効化は指定テナントだけに効き、他テナントのキャッシュを消さない', async () => {
    const q = makePool({ t1: 'starter', t2: 'growth' });
    initUsageTracker({ query: q } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);

    await track('t1', 'a1');
    await track('t2', 'b1');
    expect(planSelects(q)).toHaveLength(2);

    invalidateBillingPlanCache('t1');

    await track('t1', 'a2'); // 引き直す
    await track('t2', 'b2'); // キャッシュのまま
    expect(planSelects(q)).toHaveLength(3);
    expect(insertFor(q, 'b2')[PLAN_PARAM_INDEX]).toBe('growth');
  });

  // ★CLAUDE.md 禁止25: キャッシュをテナント非スコープでキー付けしない★
  // キーを固定文字列にする等の退行で、あるテナントの倍率が別テナントに漏れる。
  it('テナントごとに別のプランが焼かれる（キャッシュが混ざらない）', async () => {
    const q = makePool({ t1: 'starter', t2: 'enterprise', t3: 'growth' });
    initUsageTracker({ query: q } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);

    await track('t1', 'x1');
    await track('t2', 'x2');
    await track('t3', 'x3');

    expect(insertFor(q, 'x1')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(1.0);
    expect(insertFor(q, 'x2')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(2.5);
    expect(insertFor(q, 'x3')[PLAN_MULTIPLIER_PARAM_INDEX]).toBe(1.5);
  });

  it('TTL(60秒)を過ぎたら引き直す', async () => {
    const plans: Record<string, string> = { t1: 'starter' };
    const q = makePool(plans);
    initUsageTracker({ query: q } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);

    const realNow = Date.now;
    const base = realNow.call(Date);
    try {
      jest.spyOn(Date, 'now').mockReturnValue(base);
      await track('t1', 'ttl1');
      expect(planSelects(q)).toHaveLength(1);

      (Date.now as jest.Mock).mockReturnValue(base + 59_000); // TTL内
      await track('t1', 'ttl2');
      expect(planSelects(q)).toHaveLength(1);

      (Date.now as jest.Mock).mockReturnValue(base + 61_000); // TTL超過
      plans.t1 = 'growth';
      await track('t1', 'ttl3');
      expect(planSelects(q)).toHaveLength(2);
      expect(insertFor(q, 'ttl3')[PLAN_PARAM_INDEX]).toBe('growth');
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  // initUsageTracker が cache.clear() を落とすと、pool を差し替えても
  // 前の pool 由来のプランが残る（テスト間汚染・本番の再初期化時のズレ）。
  it('initUsageTracker はキャッシュを空にする（pool 差し替えで前の値が残らない）', async () => {
    const q1 = makePool({ t1: 'starter' });
    initUsageTracker({ query: q1 } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);
    await track('t1', 'i1');
    expect(insertFor(q1, 'i1')[PLAN_PARAM_INDEX]).toBe('starter');

    const q2 = makePool({ t1: 'enterprise' });
    initUsageTracker({ query: q2 } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);
    await track('t1', 'i2');

    expect(planSelects(q2)).toHaveLength(1); // 引き直している
    expect(insertFor(q2, 'i2')[PLAN_PARAM_INDEX]).toBe('enterprise');
  });
});

describe('INSERT 失敗時のフォールバック条件', () => {
  /** 指定のエラーコードで plan_multiplier 付き INSERT だけを失敗させる */
  function poolFailingInsert(code: string | undefined) {
    return jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT plan FROM tenants')) {
        return Promise.resolve({ rows: [{ plan: 'growth' }] });
      }
      if (sql.includes('plan_multiplier')) {
        const e: any = new Error('insert failed');
        if (code !== undefined) e.code = code;
        return Promise.reject(e);
      }
      return Promise.resolve({ rowCount: 1 });
    });
  }

  async function run(q: jest.Mock, requestId: string) {
    initUsageTracker({ query: q } as any, { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any);
    trackUsage({
      tenantId: 'tenant-fallback', requestId, model: 'llama-3.1-8b-instant',
      inputTokens: 10, outputTokens: 10, featureUsed: 'chat',
    });
    await flushSetImmediate();
    await flushSetImmediate();
    await flushSetImmediate();
  }

  const legacyInserts = (q: jest.Mock) =>
    q.mock.calls.filter(
      ([sql]: [string]) => sql.includes('INSERT INTO usage_logs') && !sql.includes('plan_multiplier')
    );

  // ★フォールバックは 42703(列が無い)専用★
  // 条件を緩めて「INSERTが失敗したら旧カラムで再試行」にすると、
  // 一時的な接続断や制約違反のたびに二重INSERTを試みることになる。
  it.each([
    ['57P01 (管理者による切断)', '57P01'],
    ['23505 (一意制約違反)', '23505'],
    ['53300 (接続数超過)', '53300'],
    ['コード無しの汎用エラー', undefined],
  ])('42703 以外(%s)では旧カラムINSERTを試みない', async (_label, code) => {
    const q = poolFailingInsert(code as string | undefined);
    await run(q, `fb-${code ?? 'nocode'}`);
    expect(legacyInserts(q)).toHaveLength(0);
  });

  it('42703 のときだけ旧カラムINSERTに1回だけフォールバックする', async () => {
    const q = poolFailingInsert('42703');
    await run(q, 'fb-42703');
    expect(legacyInserts(q)).toHaveLength(1);
  });

  it('フォールバックも失敗したら例外を投げずに終わる（APIを巻き込まない）', async () => {
    const q = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT plan FROM tenants')) return Promise.resolve({ rows: [{ plan: 'growth' }] });
      const e: any = new Error('boom'); e.code = '42703';
      return Promise.reject(e);
    });
    await expect(run(q, 'fb-double-fail')).resolves.toBeUndefined();
  });
});
