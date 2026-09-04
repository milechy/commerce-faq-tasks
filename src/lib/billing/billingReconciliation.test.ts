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

// ─────────────────────────────────────────────────────────────────────────────
// 込み枠プラン(Standard/Growth)の突合。
//
// 送信側は「テキスト超過」「アバター超過」を別々の行として記録するため、
// 従来どおり「直近1行の billed_quantity」を全体と比べると、たまたま最後に
// 書かれた片方の次元だけを見ることになり **毎月かならず乖離と報告し続ける**。
// 鳴りっぱなしの監視は、鳴らない監視と同じくらい役に立たない(禁止50 の裏返し)。
// ─────────────────────────────────────────────────────────────────────────────
describe('reconcileTenantPeriod（込み枠プラン: 次元ごとに突合する）', () => {
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

  /** Standard(込み枠 テキスト1,000会話 / アバター30分 / 管理AI100件)のテナント。 */
  const AGG = (textUnits: number, avatarMinutes: number, adminConsults = 0) => () => ({
    rows: [{
      total_requests: textUnits + avatarMinutes, total_cost_cents: 500,
      billable_units: textUnits + avatarMinutes, billed_units_weighted: '99999',
      unstamped_rows: 0, text_units: textUnits, avatar_minutes: avatarMinutes,
      admin_consults: adminConsults,
    }],
  });

  it('次元ごとの送信済み数量が期待値と一致すれば matches: true', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'standard' }] }),
      'billed_units_weighted': AGG(1200, 45),
      "status = 'sent'": () => ({ rows: [
        { dimension: 'text', billed_quantity: 200 },
        { dimension: 'avatar', billed_quantity: 15 },
      ] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result).toMatchObject({
      expectedBilledQuantity: 215,   // 200 + 15
      lastReportedQuantity: 215,
      matches: true,
    });
  });

  it('片方の次元だけズレていても検出する(合計が偶然合っても次元ごとに比べる)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'standard' }] }),
      'billed_units_weighted': AGG(1200, 45),  // 期待: text=200 / avatar=15
      "status = 'sent'": () => ({ rows: [
        // 合計は 215 で一致するが、次元の内訳が入れ替わっている
        { dimension: 'text', billed_quantity: 15 },
        { dimension: 'avatar', billed_quantity: 200 },
      ] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.matches).toBe(false);
  });

  it('アバター次元を一度も送っていなければ不一致(0と「未送信」を同一視しない)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'standard' }] }),
      'billed_units_weighted': AGG(1200, 10), // 期待: text=200 / avatar=0
      "status = 'sent'": () => ({ rows: [{ dimension: 'text', billed_quantity: 200 }] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.matches).toBe(false);
  });

  it('一度も送信していなければ lastReportedQuantity は null(0ではない)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'standard' }] }),
      'billed_units_weighted': AGG(500, 10),
      "status = 'sent'": () => ({ rows: [] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.lastReportedQuantity).toBeNull();
    expect(result.matches).toBe(false);
  });

  it('込み枠経路は billedQuantity(加重合計)と比べない', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'growth' }] }),
      // Growth 込み枠: テキスト3,000 / アバター150分 → 期待 text=500 / avatar=50
      'billed_units_weighted': AGG(3500, 200),
      "status = 'sent'": () => ({ rows: [
        { dimension: 'text', billed_quantity: 500 },
        { dimension: 'avatar', billed_quantity: 50 },
      ] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.expectedBilledQuantity).toBe(550);
    expect(result.expectedBilledQuantity).not.toBe(99999);
    expect(result.matches).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // S3(管理AI原価の課金・可視化): 送信側(stripeSync.ts)は 'text' dimension へ
  // overage.textPriceQuantity(= テキスト超過 + 管理AI超過)を送る。突合側も
  // 同じ値と比べないと、管理AIの超過がある月は常に「乖離あり」と誤報し続ける。
  // ─────────────────────────────────────────────────────────────────────
  it('管理AIの相談超過はテキスト次元に合算されて突合される(送信側と同じ値)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'standard' }] }),
      // Standard 込み枠: テキスト1,000 / 管理AI100件 → text超過200 + admin超過50 = 250
      'billed_units_weighted': AGG(1200, 0, 150),
      "status = 'sent'": () => ({ rows: [
        { dimension: 'text', billed_quantity: 250 },
        { dimension: 'avatar', billed_quantity: 0 },
      ] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result).toMatchObject({ expectedBilledQuantity: 250, lastReportedQuantity: 250, matches: true });
  });

  it('管理AIの超過を合算せずテキスト超過だけと比べると乖離になる(退行検知)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'standard' }] }),
      'billed_units_weighted': AGG(1200, 0, 150), // text超過200 + admin超過50
      // 送信側は250を送っているのに、突合が200(テキストのみ)と比べると不一致になってしまう
      "status = 'sent'": () => ({ rows: [{ dimension: 'text', billed_quantity: 200 }] }),
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.matches).toBe(false);
  });

  // 純従量プランは dimension 列を読まない = migration 未適用でも従来どおり突合できる。
  it('純従量プランの突合は dimension 列を読まない(migration未適用でも壊れない)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'starter' }] }),
      'billed_units_weighted': AGG(100, 0),
      // LB-3: Starterは480(¥9,600)で頭打ちになるため、加重合計(99999)ではなく
      // 480を「実際に送った数量」として置く(突合の一致自体を検証したいテストなので、
      // ここではキャップ後の期待値と揃える。キャップ導入前後の不一致検知は
      // 別テストで扱う)。
      "status = 'sent'": (sql: string) => {
        expect(sql).not.toMatch(/dimension/);
        return { rows: [{ billed_quantity: 480 }] };
      },
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.matches).toBe(true);
  });

  // LB-3導入時点で、月内に既に480を超えて送信済みのStarterテナントがいた場合、
  // 静かに追認せず不一致として検知すること(過去に送った数量をStripe側で
  // 勝手に減らすことはできないため、人手での確認・クレジット調整が必要になる)。
  it('LB-3: 上限導入前に480超を送信済みのStarterは不一致として検知する(静かに帳尻を合わせない)', async () => {
    const db = makeDb({
      'SELECT plan FROM tenants': () => ({ rows: [{ plan: 'starter' }] }),
      'billed_units_weighted': AGG(100, 0), // AGGのtextUnits引数はbilled_units_weighted(常に'99999')には影響しない
      "status = 'sent'": () => ({ rows: [{ billed_quantity: 600 }] }), // 上限導入前に480超を送信済みという想定
    });
    const result = await reconcileTenantPeriod(db as any, mockLogger, 't1', '202603');
    expect(result.expectedBilledQuantity).toBe(480);
    expect(result.lastReportedQuantity).toBe(600);
    expect(result.matches).toBe(false);
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
