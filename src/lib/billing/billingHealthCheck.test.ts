jest.mock('../alerts/slackNotifier', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(undefined),
}));

import { checkBillingHealth, billingHealthMonitor } from './billingHealthCheck';
import { sendSlackAlert } from '../alerts/slackNotifier';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;

describe('checkBillingHealth', () => {
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

  const CLEAN_STUCK = () => ({ rows: [{ cnt: 0, oldest: null }] });
  const CLEAN_UNSTAMPED = () => ({ rows: [{ total: 100, unstamped: 0 }] });

  it('健全な状態では違反0件', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toEqual([]);
  });

  // ★本題★ 月をまたいで pending が残っている = 現在の集計では二度と拾われない。
  // 1件でも直接収益に効くため CRITICAL、閾値でごまかさない。
  it('月をまたいだ pending 行が1件でもあれば CRITICAL', async () => {
    const db = makeDb({
      "billing_status = 'pending'": () => ({ rows: [{ cnt: 1, oldest: '2026-06-01T00:00:00Z' }] }),
      'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'billing_stuck_pending_rows', level: 'CRITICAL' });
    expect(violations[0].message).toContain('1 件');
    expect(violations[0].message).toContain('2026-06-01');
  });

  // ★オオカミ少年防止★ billing_enabled=false のテナントは _reportTenantUsage が
  // 集計にすら到達しないため、その usage_logs は「意図的に永久 pending」であり
  // 故障ではない。tenants.billing_enabled のデフォルトは false(migration_billing.sql)
  // なので、これを除外し忘れると新規テナントが1つ増えるだけで毎時間 CRITICAL が
  // 鳴り続け、本物の異常が埋もれる。
  it('SQLが tenants.billing_enabled で絞り込んでいる(billing_enabled=falseの誤検知を防ぐ)', async () => {
    const db = makeDb({
      "billing_status = 'pending'": (sql: string) => {
        expect(sql).toMatch(/billing_enabled\s*=\s*true/);
        expect(sql).toMatch(/JOIN\s+tenants/i);
        return { rows: [{ cnt: 0, oldest: null }] };
      },
      'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
    });
    await checkBillingHealth(db as any, mockLogger);
  });

  it('未確定行の比率がしきい値(5%)を超えると WARNING', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 100, unstamped: 10 }] }), // 10%
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: 'billing_unstamped_ratio_high', level: 'WARNING' });
    expect(violations[0].message).toContain('10.0%');
  });

  it('しきい値ちょうど(5%)は違反にしない（境界値）', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 100, unstamped: 5 }] }), // ちょうど5%
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toEqual([]);
  });

  it('しきい値をわずかに超える(6%)と違反になる（境界値）', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 100, unstamped: 6 }] }),
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toHaveLength(1);
  });

  // 低トラフィック帯の誤検知防止。1/1件=100%でも鳴らさない。
  it('サンプル数が最小値(20件)未満なら比率が高くても鳴らさない', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 5, unstamped: 5 }] }), // 100%だがサンプル不足
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toEqual([]);
  });

  it('サンプル数がちょうど最小値(20件)なら判定対象になる（境界値）', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 20, unstamped: 2 }] }), // 10%, サンプル20
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations).toHaveLength(1);
  });

  it('両方の違反が同時に出る', async () => {
    const db = makeDb({
      "billing_status = 'pending'": () => ({ rows: [{ cnt: 3, oldest: '2026-05-01T00:00:00Z' }] }),
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 50, unstamped: 25 }] }),
    });
    const violations = await checkBillingHealth(db as any, mockLogger);
    expect(violations.map((v) => v.id).sort()).toEqual(['billing_stuck_pending_rows', 'billing_unstamped_ratio_high']);
  });

  it('総件数0件(トラフィックが無い)ではクラッシュしない', async () => {
    const db = makeDb({
      "billing_status = 'pending'": CLEAN_STUCK,
      'plan_multiplier IS NULL': () => ({ rows: [{ total: 0, unstamped: 0 }] }),
    });
    await expect(checkBillingHealth(db as any, mockLogger)).resolves.toEqual([]);
  });

  // stuckPendingRows のカットオフは「当月の開始」。前月分は拾い、当月分の
  // 未処理は(まだ24hバッチが回っていないだけかもしれないので)違反にしない。
  it('カットオフは当月の開始日を使う', async () => {
    const db = makeDb({
      "billing_status = 'pending'": (_sql, params) => {
        expect(params[0]).toMatch(/^\d{4}-\d{2}-01$/);
        return { rows: [{ cnt: 0, oldest: null }] };
      },
      'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
    });
    await checkBillingHealth(db as any, mockLogger);
  });
});

describe('billingHealthMonitor（定期実行ラッパー）', () => {
  // global.setInterval を直接 spyOn/mockRestore すると、環境によっては
  // 復元時に global.setInterval 自体が失われる(実測済み・順序依存の flaky の原因)。
  // jest の fake timers 経由でタイマー数を数える方が安全かつ「実際に周期実行されるか」
  // まで検証できる。
  beforeEach(() => {
    (sendSlackAlert as jest.Mock).mockClear();
    billingHealthMonitor._resetForTest();
    jest.useFakeTimers();
  });

  afterEach(() => {
    billingHealthMonitor.stop();
    jest.useRealTimers();
  });

  // ★禁止30: 費用が発生する定期処理を多重起動しうる形で登録しない★
  it('start() を2回呼んでもタイマーは1本だけ登録される', () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ cnt: 0, oldest: null, total: 0, unstamped: 0 }] }) };
    billingHealthMonitor.start(db as any, mockLogger);
    billingHealthMonitor.start(db as any, mockLogger);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('1時間ごとに評価が実行される', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ cnt: 0, oldest: null, total: 0, unstamped: 0 }] }) };
    billingHealthMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0); // 起動直後の即時評価

    const callsAfterStart = db.query.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000); // 1時間経過
    expect(db.query.mock.calls.length).toBeGreaterThan(callsAfterStart);
  });

  it('DBクエリが例外を投げても評価ループごと落ちない', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('connection terminated')) };
    billingHealthMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('stop() 後はタイマーが残らない', () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ cnt: 0, oldest: null, total: 0, unstamped: 0 }] }) };
    billingHealthMonitor.start(db as any, mockLogger);
    billingHealthMonitor.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('違反が続く間、Slack再送はcooldown(6時間)まで抑制される', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ cnt: 1, oldest: '2026-06-01', total: 0, unstamped: 0 }] }) };
    billingHealthMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    const firstSendCount = (sendSlackAlert as jest.Mock).mock.calls.length;
    expect(firstSendCount).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000); // 1時間後(cooldown内)
    expect((sendSlackAlert as jest.Mock).mock.calls.length).toBe(firstSendCount);

    await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); // さらに6時間後(cooldown超過)
    expect((sendSlackAlert as jest.Mock).mock.calls.length).toBeGreaterThan(firstSendCount);
  });

  it('違反が解消したら RESOLVED を送る', async () => {
    let violating = true;
    const db = {
      query: jest.fn().mockImplementation(() =>
        Promise.resolve({
          rows: [violating
            ? { cnt: 1, oldest: '2026-06-01', total: 0, unstamped: 0 }
            : { cnt: 0, oldest: null, total: 0, unstamped: 0 }],
        })
      ),
    };
    billingHealthMonitor.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect((sendSlackAlert as jest.Mock).mock.calls.some(([m]) => m.status === 'FIRING')).toBe(true);

    violating = false;
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect((sendSlackAlert as jest.Mock).mock.calls.some(([m]) => m.status === 'RESOLVED')).toBe(true);
  });
});
