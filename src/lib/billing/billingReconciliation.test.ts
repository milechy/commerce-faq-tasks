jest.mock('../alerts/slackNotifier', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(undefined),
}));

import { reconcileTenantPeriod, reconcileMonth } from './billingReconciliation';
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
    expect(msg.details).toContain('1/3'); // 3テナント中1件不一致
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
