/**
 * upsellRenderer.test.ts
 *
 * ★最重要★ テナント向けの出力に原価・マージン・粗利が1バイトも混ざらないこと。
 * 型(判別子)と実行時(列挙)の二重で守っているので、両方をここで固定する。
 */
import {
  renderUpsellForTenant,
  renderUpsellForSuperAdmin,
  type TenantUpsellFigures,
  type SuperAdminUpsellFigures,
} from './upsellRenderer';

const TENANT: TenantUpsellFigures = {
  __audience: 'tenant',
  signal: 'text_overage',
  current_plan: 'standard',
  recommended_plan: 'growth',
  current_base_monthly_jpy: 9800,
  recommended_base_monthly_jpy: 29800,
  text_included_now: 1000,
  text_included_after: 3000,
  avatar_included_minutes_now: 30,
  avatar_included_minutes_after: 150,
  text_overage: 500,
  avatar_overage_minutes: 0,
  as_of: '2026-09-04T00:00:00.000Z',
};

const SUPER: SuperAdminUpsellFigures = {
  __audience: 'super_admin',
  signal: 'text_overage',
  tenant_id: 't1',
  tenant_name: 'テナントA',
  current_plan: 'standard',
  recommended_plan: 'growth',
  current_base_monthly_jpy: 9800,
  recommended_base_monthly_jpy: 29800,
  text_overage: 500,
  avatar_overage_minutes: 0,
  revenue_estimate_jpy: 22_300,
  cost_base_jpy: 1_500,
  gross_profit_jpy: 20_800,
  gross_margin_pct: 93.3,
  as_of: '2026-09-04T00:00:00.000Z',
};

describe('renderUpsellForTenant', () => {
  it('★原価・マージン・粗利を1つも出さない★', () => {
    const out = renderUpsellForTenant(TENANT);
    const text = [out.headline, ...out.lines].join('\n');
    expect(text).not.toMatch(/原価|粗利|マージン|倍率|cost|margin|profit|\$/i);
  });

  it('★型で守る: 運営向け figures はテナント向け関数に渡せない★', () => {
    // 実行はしない（tsc が @ts-expect-error を検証する）。
    // ここが「エラーにならなくなった」瞬間に、原価入りオブジェクトを
    // テナント向けレンダラへ渡す経路ができ、Gate 1 の typecheck が落ちる。
    const neverCalled = () => {
      // @ts-expect-error __audience が 'super_admin' なので構造的部分型でも通らない
      renderUpsellForTenant(SUPER);
    };
    expect(typeof neverCalled).toBe('function');
  });

  it('フィールドが欠けた壊れたデータでも例外を投げない（通知経路を落とさない）', () => {
    const broken = { __audience: 'tenant', signal: 'text_overage' } as unknown as TenantUpsellFigures;
    expect(() => renderUpsellForTenant(broken)).not.toThrow();
    expect(renderUpsellForTenant(broken).lines.join('\n')).toContain('—');
  });

  it('★実行時にも守る: 原価入りのオブジェクトをキャストで渡しても出力に現れない★', () => {
    const contaminated = {
      ...TENANT,
      cost_base_jpy: 1500,
      gross_margin_pct: 93.3,
      margin_multiplier: 10,
    } as unknown as TenantUpsellFigures;

    const text = renderUpsellForTenant(contaminated).lines.join('\n');
    expect(text).not.toContain('1500');
    expect(text).not.toContain('93.3');
    expect(text).not.toContain('10');
  });

  it('現行プランと推奨プランの月額、込み枠の変化を出す', () => {
    const text = renderUpsellForTenant(TENANT).lines.join('\n');
    expect(text).toContain('¥9,800');
    expect(text).toContain('¥29,800');
    expect(text).toContain('1,000 件 → 3,000 件');
    expect(text).toContain('30 分 → 150 分');
    expect(text).toContain('超過分の会話: 500 件');
  });

  it('★算出不可の金額は「—」であって「¥0」ではない★', () => {
    const text = renderUpsellForTenant({
      ...TENANT, current_base_monthly_jpy: null, recommended_base_monthly_jpy: null,
    }).lines.join('\n');
    expect(text).toContain('—');
    expect(text).not.toContain('¥0');
  });

  it('enterprise への提案は金額を出さず相談へ寄せる（推測した金額を出さない）', () => {
    const text = renderUpsellForTenant({
      ...TENANT, signal: 'enterprise_nudge', current_plan: 'growth', recommended_plan: 'enterprise',
    }).lines.join('\n');
    expect(text).toContain('個別のご案内');
    expect(text).not.toMatch(/¥[\d,]+/);
  });

  it('超過が無ければ超過行を出さない（0件と書かない）', () => {
    const text = renderUpsellForTenant({
      ...TENANT, signal: 'text_near_limit', text_overage: 0, avatar_overage_minutes: 0,
    }).lines.join('\n');
    expect(text).not.toContain('超過分');
    expect(text).toContain('8割');
  });

  it('集計時点を必ず添える（いつの数字か分かる）', () => {
    expect(renderUpsellForTenant(TENANT).lines.join('\n')).toContain('2026-09-04T00:00:00.000Z');
  });

  it('内部のプランIDをそのまま画面に出さない', () => {
    const text = renderUpsellForTenant({
      ...TENANT, current_plan: 'free_ad', recommended_plan: 'starter',
    }).lines.join('\n');
    expect(text).toContain('Free（広告表示）');
    expect(text).not.toContain('free_ad');
  });

  it('LLM を通さない（同じ入力からは常に同じ出力）', () => {
    expect(renderUpsellForTenant(TENANT)).toEqual(renderUpsellForTenant(TENANT));
  });
});

describe('renderUpsellForSuperAdmin', () => {
  it('運営向けには粗利を出す（テナント向けとは意図的に非対称）', () => {
    const text = renderUpsellForSuperAdmin(SUPER).lines.join('\n');
    expect(text).toContain('粗利 ¥20,800');
    expect(text).toContain('93.3%');
    expect(text).toContain('API原価 ¥1,500');
  });

  it('固定費を含まないことを明示する', () => {
    expect(renderUpsellForSuperAdmin(SUPER).lines.join('\n')).toContain('固定費');
  });

  it('粗利が算出不可でも落ちず「—」を出す', () => {
    const text = renderUpsellForSuperAdmin({
      ...SUPER, revenue_estimate_jpy: null, gross_profit_jpy: null, gross_margin_pct: null,
    }).lines.join('\n');
    expect(text).toContain('粗利 —');
    expect(text).toContain('粗利率 —');
    expect(text).not.toContain('¥0');
  });

  it('テナント名が無ければIDで表示する', () => {
    expect(renderUpsellForSuperAdmin({ ...SUPER, tenant_name: null }).lines[0]).toContain('t1');
  });
});
