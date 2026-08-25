jest.mock('../alerts/slackNotifier', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(undefined),
}));

import { reconcileTenantPeriod, reconcileMonth, billingReconciliationMonitor } from './billingReconciliation';
import { sendSlackAlert } from '../alerts/slackNotifier';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;

describe('reconcileTenantPeriod', () => {
  function makeDb(overrides: Record<string, (sql: string, params: unknown[]) => unknown>) {
    return {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        for (const [pattern, handler] of Object.entries(overrides)) {
          if (sql.includes(pattern)) return Promise.resolve(handler(sql, params));
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
  }

  const TENANT_ROW = () => ({ rows: [{ plan: 'starter' }] });

  it('再計算値と直近の送信済み値が一致すれば matches: true', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': TENANT_ROW,
      'billed_units_weighted': () => ({ rows: [{ total_requests: 100, total_cost_cents: 500, billable_units: 100, billed_units_weighted: '100', unstamped_rows: 0 }] }),
      "status = 'sent'": () => ({ rows: [{ billed_quantity: 100 }] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result).toMatchObject({ tenantId: 't1', periodYyyyMm: '202603', expectedBilledQuantity: 100, lastReportedQuantity: 100, matches: true });
  });

  // ★本題★ 過少請求バグ(C-2導入前の症状)を再現すると、突合が確実に検出すること。
  it('再計算値の方が大きい(=送信が追いついていない/過少請求)場合は matches: false', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': TENANT_ROW,
      'billed_units_weighted': () => ({ rows: [{ total_requests: 150, total_cost_cents: 750, billable_units: 150, billed_units_weighted: '150', unstamped_rows: 0 }] }),
      "status = 'sent'": () => ({ rows: [{ billed_quantity: 50 }] }), // C-2導入前の典型的な症状値
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.matches).toBe(false);
    expect(result.expectedBilledQuantity).toBe(150);
    expect(result.lastReportedQuantity).toBe(50);
  });

  it('一度も送信していないテナントは lastReportedQuantity が null で不一致扱い', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': TENANT_ROW,
      'billed_units_weighted': () => ({ rows: [{ total_requests: 10, total_cost_cents: 50, billable_units: 10, billed_units_weighted: '10', unstamped_rows: 0 }] }),
      "status = 'sent'": () => ({ rows: [] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.matches).toBe(false);
    expect(result.lastReportedQuantity).toBeNull();
  });

  it('直近の sent 行を updated_at 降順(最新)で選ぶ', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': TENANT_ROW,
      'billed_units_weighted': () => ({ rows: [{ total_requests: 100, total_cost_cents: 500, billable_units: 100, billed_units_weighted: '100', unstamped_rows: 0 }] }),
      "status = 'sent'": (sql: string) => {
        expect(sql).toMatch(/ORDER BY updated_at DESC/);
        expect(sql).toMatch(/LIMIT 1/);
        return { rows: [{ billed_quantity: 100 }] };
      },
    });
    await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
  });

  it('テナントが存在しない(plan行が無い)場合もクラッシュせず、利用0件・未送信として不一致を返す', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [] }),
      'billed_units_weighted': () => ({ rows: [{ total_requests: 0, total_cost_cents: 0, billable_units: 0, billed_units_weighted: '0', unstamped_rows: 0 }] }),
      "status = 'sent'": () => ({ rows: [] }),
    });
    // expected=0 と lastReported=null(送信履歴なし)は別の状態なので、
    // 0===null にはならず不一致のまま返る。クラッシュしないことが本旨。
    await expect(reconcileTenantPeriod(db as any, mockLogger, 'ghost-tenant', '202603')).resolves.toMatchObject({
      expectedBilledQuantity: 0,
      lastReportedQuantity: null,
      matches: false,
    });
  });
});

describe('reconcileMonth', () => {
  beforeEach(() => {
    (sendSlackAlert as jest.Mock).mockClear();
  });

  function makeDb(state: {
    tenants: string[];
    expected: Record<string, number>;
    lastSent: Record<string, number | null>;
  }) {
    return {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_usage_reports')) {
          return Promise.resolve({ rows: state.tenants.map((t) => ({ tenant_id: t })) });
        }
        if (sql.includes('SELECT plan FROM tenants')) {
          return Promise.resolve({ rows: [{ plan: 'starter' }] });
        }
        if (sql.includes('billed_units_weighted')) {
          const tenantId = (params as unknown[])[0] as string;
          const q = state.expected[tenantId] ?? 0;
          return Promise.resolve({ rows: [{ total_requests: q, total_cost_cents: q * 5, billable_units: q, billed_units_weighted: String(q), unstamped_rows: 0 }] });
        }
        if (sql.includes("status = 'sent'")) {
          const tenantId = (params as unknown[])[0] as string;
          const v = state.lastSent[tenantId];
          return Promise.resolve({ rows: v === null || v === undefined ? [] : [{ billed_quantity: v }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
  }

  it('全テナント一致なら Slack を鳴らさない', async () => {
    const db = makeDb({ tenants: ['t1', 't2'], expected: { t1: 100, t2: 200 }, lastSent: { t1: 100, t2: 200 } });
    const results = await reconcileMonth(db as any, mockLogger, '202603');
    expect(results).toHaveLength(2);
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it('1件でも不一致があれば CRITICAL で1本にまとめて通知する', async () => {
    const db = makeDb({ tenants: ['t1', 't2', 't3'], expected: { t1: 100, t2: 250, t3: 300 }, lastSent: { t1: 100, t2: 50, t3: 300 } });
    await reconcileMonth(db as any, mockLogger, '202603');

    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    const [msg] = (sendSlackAlert as jest.Mock).mock.calls[0];
    expect(msg.level).toBe('CRITICAL');
    expect(msg.details).toContain('乖離 1 件'); // 3テナント中1件不一致
    expect(msg.details).toContain('t2');
    expect(msg.details).not.toContain('t1: 再計算'); // 一致したテナントは列挙しない
  });

  it('period 未指定なら「先月」を対象にする', async () => {
    const db = makeDb({ tenants: [], expected: {}, lastSent: {} });
    const queryCalls: string[] = [];
    db.query.mockImplementation((sql: string) => {
      queryCalls.push(sql);
      return Promise.resolve({ rows: [] });
    });
    await reconcileMonth(db as any, mockLogger);
    // period_yyyymm = $1 に渡された値を確認したいので、実際の呼び出し引数を見る
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('stripe_usage_reports'),
      expect.arrayContaining([expect.stringMatching(/^\d{6}$/)])
    );
  });

  it('1テナントの突合が例外を投げても、他テナントの処理を止めない', async () => {
    const db = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_usage_reports')) {
          return Promise.resolve({ rows: [{ tenant_id: 'broken' }, { tenant_id: 'ok' }] });
        }
        if (sql.includes('SELECT plan FROM tenants')) {
          if ((params as unknown[])[0] === 'broken') return Promise.reject(new Error('boom'));
          return Promise.resolve({ rows: [{ plan: 'starter' }] });
        }
        if (sql.includes('billed_units_weighted')) {
          return Promise.resolve({ rows: [{ total_requests: 10, total_cost_cents: 50, billable_units: 10, billed_units_weighted: '10', unstamped_rows: 0 }] });
        }
        if (sql.includes("status = 'sent'")) {
          return Promise.resolve({ rows: [{ billed_quantity: 10 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const results = await reconcileMonth(db as any, mockLogger, '202603');
    expect(results).toHaveLength(1);
    expect(results[0].tenantId).toBe('ok');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('対象テナントが0件でもクラッシュしない', async () => {
    const db = makeDb({ tenants: [], expected: {}, lastSent: {} });
    await expect(reconcileMonth(db as any, mockLogger, '202603')).resolves.toEqual([]);
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: テナント単位の突合失敗を可視化する。
// 導入時は catch → logger.error のみで、失敗したテナントは results から
// 単純に消えるだけだった(Slackには一切出ない)。DB接続不調などで一部テナントだけ
// 突合できていない状態が、突合ジョブ自身に見えない状態だった。
// ─────────────────────────────────────────────────────────────────────────────
describe('reconcileMonth: 突合失敗の可視化', () => {
  beforeEach(() => {
    (sendSlackAlert as jest.Mock).mockClear();
  });

  it('乖離が0件でも、突合失敗があればSlackに通知する', async () => {
    const db = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_usage_reports')) {
          return Promise.resolve({ rows: [{ tenant_id: 'broken' }, { tenant_id: 'ok' }] });
        }
        if (sql.includes('SELECT plan FROM tenants')) {
          if ((params as unknown[])[0] === 'broken') return Promise.reject(new Error('connection terminated'));
          return Promise.resolve({ rows: [{ plan: 'starter' }] });
        }
        if (sql.includes('billed_units_weighted')) {
          return Promise.resolve({ rows: [{ total_requests: 10, total_cost_cents: 50, billable_units: 10, billed_units_weighted: '10', unstamped_rows: 0 }] });
        }
        if (sql.includes("status = 'sent'")) {
          return Promise.resolve({ rows: [{ billed_quantity: 10 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    await reconcileMonth(db as any, mockLogger, '202603');

    expect(sendSlackAlert).toHaveBeenCalledTimes(1);
    const [msg] = (sendSlackAlert as jest.Mock).mock.calls[0];
    expect(msg.level).toBe('CRITICAL');
    expect(msg.details).toContain('突合失敗 1 件');
    expect(msg.details).toContain('broken');
    expect(msg.details).toContain('実態不明'); // 「乖離なし」と混同しないことを明示する文言
  });

  it('突合失敗も乖離も無ければSlackを鳴らさない(既存動作の維持)', async () => {
    const db = {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_usage_reports')) {
          return Promise.resolve({ rows: [{ tenant_id: 'ok' }] });
        }
        if (sql.includes('SELECT plan FROM tenants')) return Promise.resolve({ rows: [{ plan: 'starter' }] });
        if (sql.includes('billed_units_weighted')) {
          return Promise.resolve({ rows: [{ total_requests: 10, total_cost_cents: 50, billable_units: 10, billed_units_weighted: '10', unstamped_rows: 0 }] });
        }
        if (sql.includes("status = 'sent'")) return Promise.resolve({ rows: [{ billed_quantity: 10 }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    await reconcileMonth(db as any, mockLogger, '202603');
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// billingReconciliationMonitor（定期実行ラッパー）
// billingHealthCheck.ts と同じ理由で fake timers を使う
// (global.setInterval への spyOn/mockRestore は環境依存で不安定)。
// ─────────────────────────────────────────────────────────────────────────────
describe('billingReconciliationMonitor', () => {
  beforeEach(() => {
    (sendSlackAlert as jest.Mock).mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    billingReconciliationMonitor.stop();
    jest.useRealTimers();
  });

  const cleanDb = () => ({
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_usage_reports')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    }),
  });

  // ★禁止30: 費用が発生する定期処理を多重起動しうる形で登録しない★
  it('start() を2回呼んでもタイマーは1本だけ登録される', () => {
    const db = cleanDb();
    billingReconciliationMonitor.start(db as any, mockLogger);
    billingReconciliationMonitor.start(db as any, mockLogger);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('起動直後に1回実行される(次の24hを待たない)', async () => {
    const db = cleanDb();
    billingReconciliationMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    const listCalls = db.query.mock.calls.filter(([sql]: [string]) => sql.includes('SELECT DISTINCT tenant_id'));
    expect(listCalls.length).toBeGreaterThan(0);
  });

  it('24時間ごとに再実行される', async () => {
    const db = cleanDb();
    billingReconciliationMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    const callsAfterStart = db.query.mock.calls.length;

    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(db.query.mock.calls.length).toBeGreaterThan(callsAfterStart);
  });

  it('DBクエリが例外を投げても評価ループごと落ちない', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('connection terminated')) };
    billingReconciliationMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('stop() 後はタイマーが残らない', () => {
    const db = cleanDb();
    billingReconciliationMonitor.start(db as any, mockLogger);
    billingReconciliationMonitor.stop();
    expect(jest.getTimerCount()).toBe(0);
  });
});
