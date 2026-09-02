jest.mock('../alerts/slackNotifier', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(undefined),
}));

import { checkBillingHealth, billingHealthMonitor, fetchFixedCostQuotaStatus } from './billingHealthCheck';
import { sendSlackAlert } from '../alerts/slackNotifier';
import { REQUIRED_COLUMNS } from '../../api/admin/analytics/schemaHealth';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;

// REQUIRED_COLUMNS を全て満たす行を機械的に生成する(手書きの列挙で
// テストとレジストリがズレるのを防ぐ。REQUIRED_COLUMNS が唯一の出どころ)。
const SCHEMA_ALL_PRESENT_ROWS = (_sql?: string, _params?: unknown[]) => ({
  rows: Object.entries(REQUIRED_COLUMNS).flatMap(([table_name, cols]) =>
    cols.map((column_name) => ({ table_name, column_name }))
  ),
});

describe('checkBillingHealth', () => {
  function makeDb(overrides: Record<string, (sql: string, params: unknown[]) => unknown>) {
    // 'information_schema.columns' の既定はスキーマ健全(欠落なし)。
    // 'reported' の既定は滞留なし(健全)。
    // チェック3・4を検証するテストだけ overrides で上書きする。
    const merged = {
      'information_schema.columns': SCHEMA_ALL_PRESENT_ROWS,
      "billing_status = 'reported'": () => ({ rows: [{ cnt: 0, oldest: null }] }),
      // A2A-0i チェック5: デフォルトは消費0(健全・沈黙)。
      // LemonSliceはデフォルトenvが効くため current/history とも常に呼ばれる。
      // LiveKitはenv未設定ならquota=nullでhistoryクエリ自体発行されないが、
      // currentは常に呼ばれるため両方に既定ハンドラを用意しておく。
      'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 0 }] }),
      'fixed_cost_quota:lemonslice:history': () => ({ rows: [] }),
      'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 0 }] }),
      'fixed_cost_quota:livekit:history': () => ({ rows: [] }),
      ...overrides,
    };
    return {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        for (const [pattern, handler] of Object.entries(merged)) {
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

  // ★本題(PR-6・2026-08-25収益監査)★ 検出器(fetchSchemaHealth)は既に
  // 存在したが、鳴らす場所が無かった。ここで初めて billingHealthCheck から
  // 呼ばれることを固定する。billing_enabled のテナント有無とは無関係に
  // 常時評価する(チェック1・2と違い対象0件で沈黙してはいけない)。
  describe('チェック3: 課金スキーマの欠落列', () => {
    it('列が1つ欠落していれば CRITICAL', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'information_schema.columns': () => ({
          // usage_logs から plan_multiplier だけを欠落させる
          rows: Object.entries(REQUIRED_COLUMNS).flatMap(([table_name, cols]) =>
            cols
              .filter((c) => !(table_name === 'usage_logs' && c === 'plan_multiplier'))
              .map((column_name) => ({ table_name, column_name }))
          ),
        }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ id: 'billing_schema_missing_columns', level: 'CRITICAL' });
      expect(violations[0].message).toContain('usage_logs.plan_multiplier');
    });

    it('テーブルごと欠落していれば tableMissing としてメッセージに含む', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'information_schema.columns': () => ({
          rows: Object.entries(REQUIRED_COLUMNS)
            .filter(([table_name]) => table_name !== 'stripe_webhook_events')
            .flatMap(([table_name, cols]) => cols.map((column_name) => ({ table_name, column_name }))),
        }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toContain('stripe_webhook_events(テーブルごと欠落)');
    });

    it('欠落が無ければ違反を出さない(デフォルトの健全な状態)', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toEqual([]);
    });

    it('billing_enabled=true のテナントが無くても評価される(対象0件で沈黙しない)', async () => {
      // チェック1・2は billing_enabled=true が無いと沈黙するが、チェック3は
      // テナントの利用状況と無関係にスキーマの事実を見るため沈黙してはいけない。
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK, // billing_enabled=true が0件でもcnt=0
        'plan_multiplier IS NULL': () => ({ rows: [{ total: 0, unstamped: 0 }] }), // トラフィックゼロ
        'information_schema.columns': () => ({ rows: [] }), // 全テーブル欠落
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0].id).toBe('billing_schema_missing_columns');
    });
  });

  // PR-4(2026-08-25収益監査): invoice.payment_succeeded/payment_failed が
  // billing_status を 'reported' → 'paid'/'failed' に遷移させることの不変条件監視。
  describe('チェック4: 決済webhookが反映されないまま滞留している行', () => {
    it('30日以上reportedのまま滞留していればWARNING', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        "billing_status = 'reported'": () => ({ rows: [{ cnt: 3, oldest: '2026-06-01T00:00:00Z' }] }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ id: 'billing_stale_reported_rows', level: 'WARNING' });
      expect(violations[0].message).toContain('3件');
      expect(violations[0].message).toContain('2026-06-01');
    });

    it('滞留が無ければ違反を出さない(デフォルトの健全な状態)', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toEqual([]);
    });

    it('billing_enabled=true のテナントが無くても評価される(対象0件で沈黙しない)', async () => {
      // チェック1・2は billing_enabled=true が無いと沈黙するが、チェック4は
      // webhook到達状況の事実を見るため沈黙してはいけない(チェック3と同じ理由)。
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': () => ({ rows: [{ total: 0, unstamped: 0 }] }),
        "billing_status = 'reported'": () => ({ rows: [{ cnt: 1, oldest: '2026-06-01T00:00:00Z' }] }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0].id).toBe('billing_stale_reported_rows');
    });

    it('両方の滞留(pending + reported)が同時に出る', async () => {
      const db = makeDb({
        "billing_status = 'pending'": () => ({ rows: [{ cnt: 2, oldest: '2026-05-01T00:00:00Z' }] }),
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        "billing_status = 'reported'": () => ({ rows: [{ cnt: 5, oldest: '2026-06-01T00:00:00Z' }] }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations.map((v) => v.id).sort()).toEqual([
        'billing_stale_reported_rows',
        'billing_stuck_pending_rows',
      ]);
    });
  });

  // A2A-0i: 固定費(LemonSlice/LiveKit)クォータ監視。downSignal(下げられるか)は
  // ここでは違反にしない(表示カード専用)ため、upSignal(上げるべきか)のみ検証する。
  describe('チェック5: 固定費クォータの消費率', () => {
    afterEach(() => {
      delete process.env.LEMONSLICE_MONTHLY_CREDIT_QUOTA;
      delete process.env.LIVEKIT_MONTHLY_ROOM_QUOTA;
    });

    it('LemonSliceの消費がデフォルト込み枠(15000)の80%を超えるとWARNING', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 13500 }] }), // 90%
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ id: 'fixed_cost_quota_lemonslice_high', level: 'WARNING' });
      expect(violations[0].message).toContain('90.0%');
      // ★計測の信頼性★ agent.pyのfire-and-forget送信であることの注記を必ず含む
      expect(violations[0].message).toContain('計上漏れ');
    });

    it('LemonSliceの消費が80%未満なら違反を出さない', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 11999 }] }), // 79.99%
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toEqual([]);
    });

    it('LIVEKIT_MONTHLY_ROOM_QUOTA未設定ならLiveKitの消費量が多くても沈黙する(込み枠が未確定なため)', async () => {
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 999999 }] }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toEqual([]);
    });

    it('LIVEKIT_MONTHLY_ROOM_QUOTA設定時、80%以上でWARNING', async () => {
      process.env.LIVEKIT_MONTHLY_ROOM_QUOTA = '100';
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 85 }] }),
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ id: 'fixed_cost_quota_livekit_high', level: 'WARNING' });
    });

    it('env値が不正(負値)ならデフォルトにフォールバックしwarnログを出す(fail-safe)', async () => {
      process.env.LEMONSLICE_MONTHLY_CREDIT_QUOTA = '-1';
      const db = makeDb({
        "billing_status = 'pending'": CLEAN_STUCK,
        'plan_multiplier IS NULL': CLEAN_UNSTAMPED,
        'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 13500 }] }), // 90% of デフォルト15000
      });
      const violations = await checkBillingHealth(db as any, mockLogger);
      expect(violations).toHaveLength(1);
      expect(violations[0].id).toBe('fixed_cost_quota_lemonslice_high');
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});

describe('fetchFixedCostQuotaStatus (A2A-0i)', () => {
  function makeQuotaDb(overrides: Record<string, (sql: string, params: unknown[]) => unknown>) {
    return {
      query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        for (const [pattern, handler] of Object.entries(overrides)) {
          if (sql.includes(pattern)) return Promise.resolve(handler(sql, params));
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
  }

  afterEach(() => {
    delete process.env.LEMONSLICE_MONTHLY_CREDIT_QUOTA;
    delete process.env.LIVEKIT_MONTHLY_ROOM_QUOTA;
  });

  it('直近3ヶ月連続で50%未満ならdownSignal=true(下げ方向は3ヶ月分の実績が必要)', async () => {
    const db = makeQuotaDb({
      'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 1000 }] }),
      'fixed_cost_quota:lemonslice:history': () => ({
        rows: [
          { month: '2026-06-01', used: 3000 },
          { month: '2026-07-01', used: 4000 },
          { month: '2026-08-01', used: 2000 },
        ],
      }),
      'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 0 }] }),
    });
    const status = await fetchFixedCostQuotaStatus(db as any, mockLogger);
    expect(status.lemonslice.downSignal).toBe(true);
    expect(status.lemonslice.historyMonths).toBe(3);
  });

  it('3ヶ月のうち1ヶ月でも50%以上ならdownSignal=false', async () => {
    const db = makeQuotaDb({
      'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 1000 }] }),
      'fixed_cost_quota:lemonslice:history': () => ({
        rows: [
          { month: '2026-06-01', used: 3000 },
          { month: '2026-07-01', used: 8000 }, // 53% — 閾値超え
          { month: '2026-08-01', used: 2000 },
        ],
      }),
      'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 0 }] }),
    });
    const status = await fetchFixedCostQuotaStatus(db as any, mockLogger);
    expect(status.lemonslice.downSignal).toBe(false);
  });

  it('完了月の履歴が3ヶ月に満たないならdownSignal=false(母数不足)', async () => {
    const db = makeQuotaDb({
      'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 1000 }] }),
      'fixed_cost_quota:lemonslice:history': () => ({
        rows: [
          { month: '2026-07-01', used: 1000 },
          { month: '2026-08-01', used: 1000 },
        ],
      }),
      'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 0 }] }),
    });
    const status = await fetchFixedCostQuotaStatus(db as any, mockLogger);
    expect(status.lemonslice.downSignal).toBe(false);
    expect(status.lemonslice.historyMonths).toBe(2);
  });

  it('LiveKitはquota未設定ならquota/ratioがnullで、historyクエリ自体を発行しない', async () => {
    const db = makeQuotaDb({
      'fixed_cost_quota:lemonslice:current': () => ({ rows: [{ used: 0 }] }),
      'fixed_cost_quota:lemonslice:history': () => ({ rows: [] }),
      'fixed_cost_quota:livekit:current': () => ({ rows: [{ used: 42 }] }),
      // 'fixed_cost_quota:livekit:history' は意図的にハンドラを登録しない。
      // quota=null のときに呼ばれてしまうと `unexpected query` で失敗し、この
      // テスト自体が「呼ばれていないこと」の検証になる。
    });
    const status = await fetchFixedCostQuotaStatus(db as any, mockLogger);
    expect(status.livekit.quota).toBeNull();
    expect(status.livekit.ratio).toBeNull();
    expect(status.livekit.used).toBe(42);
    expect(status.livekit.upSignal).toBe(false);
    expect(status.livekit.downSignal).toBe(false);
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
