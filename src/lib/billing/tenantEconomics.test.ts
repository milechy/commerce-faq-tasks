/**
 * tenantEconomics.test.ts
 *
 * ここで固定したいのは3点:
 *  1. 期間境界が JST 暦月で、実行環境の TZ に依存しないこと
 *  2. 売上が算出不可のとき粗利を 0 にせず null のまま伝播すること
 *  3. 原価の確からしさ(estimation_method)を必ず開示すること
 *
 * 原価の導出SQL(BASE_COST_EXPR)自体は実 Postgres でしか検証できないため、
 * billingSqlIntegration.test.ts 側で別途固定している。
 */
import {
  periodToJstRangeIso,
  fetchTenantEconomics,
  _clearEconomicsCache,
  MAX_TENANTS_PER_ECONOMICS_REQUEST,
  type BillingSnapshotFn,
} from './tenantEconomics';

describe('periodToJstRangeIso', () => {
  it('JST 暦月の境界を ISO インスタントで返す', () => {
    expect(periodToJstRangeIso('202609')).toEqual({
      from: '2026-08-31T15:00:00.000Z', // 2026-09-01 00:00 JST
      to: '2026-09-30T15:00:00.000Z',   // 2026-10-01 00:00 JST
    });
  });

  it('年をまたぐ月も正しい', () => {
    expect(periodToJstRangeIso('202612')).toEqual({
      from: '2026-11-30T15:00:00.000Z',
      to: '2026-12-31T15:00:00.000Z',
    });
    expect(periodToJstRangeIso('202601')).toEqual({
      from: '2025-12-31T15:00:00.000Z',
      to: '2026-01-31T15:00:00.000Z',
    });
  });

  it('うるう年の2月も正しい', () => {
    expect(periodToJstRangeIso('202402')).toEqual({
      from: '2024-01-31T15:00:00.000Z',
      to: '2024-02-29T15:00:00.000Z',
    });
  });

  it('★process の TZ を変えても結果が変わらない★', () => {
    const original = process.env.TZ;
    try {
      const results = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati'].map((tz) => {
        process.env.TZ = tz;
        return periodToJstRangeIso('202609');
      });
      for (const r of results) expect(r).toEqual(results[0]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('不正な period は例外', () => {
    expect(() => periodToJstRangeIso('2026')).toThrow();
    expect(() => periodToJstRangeIso('202613')).toThrow();
    expect(() => periodToJstRangeIso('202600')).toThrow();
    expect(() => periodToJstRangeIso('abcdef')).toThrow();
  });
});

describe('fetchTenantEconomics', () => {
  beforeEach(() => _clearEconomicsCache());

  /** usage_logs 集計 → tenants 名前引き の順で応答する簡易モック。 */
  function mockDb(costRows: unknown[], tenantRows: unknown[] = [{ id: 't1', name: 'T1' }]) {
    const calls: string[] = [];
    return {
      calls,
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes('FROM usage_logs')) return { rows: costRows };
        return { rows: tenantRows };
      }),
    };
  }

  const snapshotOf = (over: Partial<Awaited<ReturnType<BillingSnapshotFn>>> = {}): BillingSnapshotFn =>
    async () => ({ plan: 'standard', textUnits: 100, avatarMinutes: 0, revenueEstimateJpy: 10_000, ...over });

  const costRow = (over: Record<string, string> = {}) => ({
    tenant_id: 't1', total_requests: '10',
    cost_base_billable: '1000',      // $10.00 → ¥1,500
    cost_base_nonbillable: '0',
    recorded_rows: '10', all_rows: '10', ...over,
  });

  it('粗利 = 売上 − 課金対象の原価（円換算）', async () => {
    const db = mockDb([costRow()]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    const row = res.tenants[0]!;
    expect(row.cost_base_jpy).toBe(1500);          // 1000 cents = $10 → ¥1,500
    expect(row.gross_profit_jpy).toBe(8500);       // 10,000 − 1,500
    expect(row.gross_margin_pct).toBe(85);
  });

  it('★売上が算出不可なら粗利も null（0 にしない）★', async () => {
    const db = mockDb([costRow()]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf({ revenueEstimateJpy: null }));
    const row = res.tenants[0]!;
    expect(row.revenue_estimate_jpy).toBeNull();
    expect(row.gross_profit_jpy).toBeNull();
    expect(row.gross_margin_pct).toBeNull();
    expect(row.unavailable_reason).toBe('revenue_estimate_unavailable');
    // 原価は分かっているので出す（売上が出ないことと原価が無いことは別）
    expect(row.cost_base_jpy).toBe(1500);
  });

  it('売上0円(free_ad)は「算出不可」ではない', async () => {
    const db = mockDb([costRow()]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf({ plan: 'free_ad', revenueEstimateJpy: 0 }));
    const row = res.tenants[0]!;
    expect(row.revenue_estimate_jpy).toBe(0);
    expect(row.unavailable_reason).toBeNull();
    expect(row.gross_profit_jpy).toBe(-1500);   // 原価だけ出ている＝赤字
    expect(row.gross_margin_pct).toBeNull();    // 売上0で率は定義できない
  });

  it('estimation_method: 全行記録済みなら recorded', async () => {
    const db = mockDb([costRow({ recorded_rows: '10', all_rows: '10' })]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.tenants[0]!.estimation_method).toBe('recorded');
    expect(res.tenants[0]!.recorded_row_ratio).toBe(1);
  });

  it('estimation_method: 全行未記録なら derived', async () => {
    const db = mockDb([costRow({ recorded_rows: '0', all_rows: '10' })]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.tenants[0]!.estimation_method).toBe('derived');
    expect(res.tenants[0]!.recorded_row_ratio).toBe(0);
  });

  it('estimation_method: 混在なら mixed（移行期を隠さない）', async () => {
    const db = mockDb([costRow({ recorded_rows: '3', all_rows: '10' })]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.tenants[0]!.estimation_method).toBe('mixed');
    expect(res.tenants[0]!.recorded_row_ratio).toBe(0.3);
  });

  it('非課金機能の原価は粗利から外し、実額として別に出す', async () => {
    const db = mockDb([costRow({ cost_base_nonbillable: '500' })]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    const row = res.tenants[0]!;
    expect(row.cost_nonbillable_jpy).toBe(750);
    // 売上側(computeExpectedBilling)が billable=true しか数えないので基準を揃える
    expect(row.gross_profit_jpy).toBe(8500);
  });

  it('1テナントの売上取得が落ちても一覧全体を落とさない', async () => {
    const db = mockDb([costRow()]);
    const failing: BillingSnapshotFn = async () => { throw new Error('stripe down'); };
    const res = await fetchTenantEconomics(db, '202609', failing);
    expect(res.tenants).toHaveLength(1);
    expect(res.tenants[0]!.revenue_estimate_jpy).toBeNull();
    expect(res.tenants[0]!.gross_profit_jpy).toBeNull();
  });

  it('上限を超えたら truncated を立てる（黙って切らない）', async () => {
    const many = Array.from({ length: MAX_TENANTS_PER_ECONOMICS_REQUEST + 5 }, (_, i) =>
      costRow({ tenant_id: `t${i}` }));
    const db = mockDb(many, many.map((_, i) => ({ id: `t${i}`, name: `T${i}` })));
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.truncated).toBe(true);
    expect(res.tenants).toHaveLength(MAX_TENANTS_PER_ECONOMICS_REQUEST);
  });

  it('上限以内なら truncated は false', async () => {
    const db = mockDb([costRow()]);
    expect((await fetchTenantEconomics(db, '202609', snapshotOf())).truncated).toBe(false);
  });

  it('マージン倍率と為替レートを必ず開示する（後から検算できるように）', async () => {
    const db = mockDb([costRow()]);
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(typeof res.margin_assumed).toBe('number');
    expect(res.fx.usd_jpy).toBe(150);
    expect(res.fx.basis).toBe('fixed_rate_estimate');
    // 固定費を含まないことを構造で示す（文言だけに頼らない）
    expect(res.cost_basis).toBe('variable_only');
    expect(res.boundary).toBe('jst_calendar_month');
    expect(res.period_from).toBe('2026-08-31T15:00:00.000Z');
  });

  it('★売上の集計SQLを自前で書いていない★（usage_logs と tenants しか触らない）', async () => {
    const db = mockDb([costRow()]);
    await fetchTenantEconomics(db, '202609', snapshotOf());
    for (const sql of db.calls) {
      expect(sql).not.toMatch(/stripe_usage_reports|chat_sessions|billed_quantity/);
    }
  });

  it('60秒キャッシュが効く（リロード連打で本番DBを殴らない）', async () => {
    const db = mockDb([costRow()]);
    await fetchTenantEconomics(db, '202609', snapshotOf());
    const callsAfterFirst = db.query.mock.calls.length;
    await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(db.query.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('fetchTenantEconomics — 境界値(MAX_TENANTS)', () => {
  beforeEach(() => _clearEconomicsCache());

  function mockDb(costRows: unknown[], tenantRows: unknown[]) {
    return {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM usage_logs')) return { rows: costRows };
        return { rows: tenantRows };
      }),
    };
  }
  const snapshotOf = (): BillingSnapshotFn =>
    async () => ({ plan: 'standard', textUnits: 100, avatarMinutes: 0, revenueEstimateJpy: 10_000 });
  const costRow = (id: string) => ({
    tenant_id: id, total_requests: '10', cost_base_billable: '1000',
    cost_base_nonbillable: '0', recorded_rows: '10', all_rows: '10',
  });

  it('★ちょうど上限件数(50件)なら truncated=false★(境界値のオフバイワン)', async () => {
    const rows = Array.from({ length: MAX_TENANTS_PER_ECONOMICS_REQUEST }, (_, i) => costRow(`t${i}`));
    const db = mockDb(rows, rows.map((r) => ({ id: r.tenant_id, name: r.tenant_id })));
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.truncated).toBe(false);
    expect(res.tenants).toHaveLength(MAX_TENANTS_PER_ECONOMICS_REQUEST);
  });

  it('★上限+1件なら truncated=true で上限件数までしか返さない★', async () => {
    const rows = Array.from({ length: MAX_TENANTS_PER_ECONOMICS_REQUEST + 1 }, (_, i) => costRow(`t${i}`));
    const db = mockDb(rows, rows.map((r) => ({ id: r.tenant_id, name: r.tenant_id })));
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.truncated).toBe(true);
    expect(res.tenants).toHaveLength(MAX_TENANTS_PER_ECONOMICS_REQUEST);
  });

  it('★複数テナントの売上取得が同時に失敗しても、成功分は正しく返る★', async () => {
    const rows = [costRow('ok1'), costRow('fail'), costRow('ok2')];
    const db = mockDb(rows, rows.map((r) => ({ id: r.tenant_id, name: r.tenant_id })));
    const snapshot: BillingSnapshotFn = async (_db, tenantId) => {
      if (tenantId === 'fail') throw new Error('stripe timeout');
      return { plan: 'standard', textUnits: 100, avatarMinutes: 0, revenueEstimateJpy: 5000 };
    };
    const res = await fetchTenantEconomics(db, '202609', snapshot);
    expect(res.tenants).toHaveLength(3);
    const failRow = res.tenants.find((t) => t.tenant_id === 'fail')!;
    expect(failRow.revenue_estimate_jpy).toBeNull();
    const okRows = res.tenants.filter((t) => t.tenant_id !== 'fail');
    expect(okRows.every((t) => t.revenue_estimate_jpy === 5000)).toBe(true);
  });

  it('テナント名が DB に存在しない(names マップに欠落)場合でも tenant_id で表示できる', async () => {
    const rows = [costRow('ghost')];
    const db = mockDb(rows, []); // tenants テーブルに該当行なし
    const res = await fetchTenantEconomics(db, '202609', snapshotOf());
    expect(res.tenants[0]!.tenant_name).toBeNull();
    expect(res.tenants[0]!.tenant_id).toBe('ghost');
  });
});

describe('periodToJstRangeIso — さらなる境界値', () => {
  it('period が6桁ちょうどでない(5桁)場合は例外', () => {
    expect(() => periodToJstRangeIso('20260')).toThrow();
  });

  it('period が7桁(多すぎる)場合は例外', () => {
    expect(() => periodToJstRangeIso('2026091')).toThrow();
  });

  it('遠い未来の年(9999年)でも例外を投げず計算する(意味検証はしない)', () => {
    expect(() => periodToJstRangeIso('999909')).not.toThrow();
  });

  it('先頭ゼロの月(01月)を正しく扱う', () => {
    const r = periodToJstRangeIso('202601');
    expect(r.from).toBe('2025-12-31T15:00:00.000Z');
  });
});
