// src/api/admin/tuning/upsellProposalsRoutes.test.ts
//
// GET/PUT /v1/admin/upsell-proposals* — 運営向けアップセル提案一覧の配線テスト。
//
// ★このテストが守っているもの★
// - super_admin 限定であること(原価・粗利が同じ応答に載るため)
// - adopt/dismiss が behavior 提案には効かないこと(誤操作でFAQ提案を
//   このエンドポイントから承認/却下できてしまうと、URL分離の意味が無くなる)
// - evidence が壊れている行でも一覧取得全体をクラッシュさせないこと

jest.mock('../../../lib/db', () => ({
  pool: null,
  getPool: () => ({}),
}));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

const mockListRules = jest.fn().mockResolvedValue([]);
jest.mock('./tuningRulesRepository', () => ({
  listRules: (...args: any[]) => mockListRules(...args),
  createRule: jest.fn(),
  updateRule: jest.fn(),
  deleteRule: jest.fn(),
}));
jest.mock('../../../lib/knowledgeSearchUtil', () => ({
  searchKnowledgeForSuggestion: jest.fn(),
  formatKnowledgeContext: jest.fn(),
}));
jest.mock('../../../lib/crossTenantContext', () => ({
  getCrossTenantContext: jest.fn(),
  formatCrossTenantContext: jest.fn(),
}));
jest.mock('../../../lib/research', () => ({ getResearchProvider: jest.fn() }));
jest.mock('../../../lib/research/featureCheck', () => ({ isDeepResearchEnabled: jest.fn() }));
jest.mock('../../../lib/research/queryBuilder', () => ({ buildResearchQuery: jest.fn() }));

const mockApproveTuningRule = jest.fn();
const mockRejectTuningRule = jest.fn();
jest.mock('../evaluations/evaluationsRepository', () => ({
  approveTuningRule: (...a: unknown[]) => mockApproveTuningRule(...a),
  rejectTuningRule: (...a: unknown[]) => mockRejectTuningRule(...a),
}));

const mockNotify = jest.fn().mockResolvedValue(undefined);
jest.mock('../evaluations/routes', () => ({
  notifyTenantOfApprovedUpsell: (...a: unknown[]) => mockNotify(...a),
}));

const mockBuildFigures = jest.fn();
jest.mock('../../../lib/billing/billingApi', () => ({
  buildSuperAdminUpsellFigures: (...a: unknown[]) => mockBuildFigures(...a),
}));

jest.mock('../../../lib/billing/upsellRenderer', () => ({
  renderUpsellForSuperAdmin: jest.fn(() => ({
    headline: 'アップセル候補', lines: ['粗利 ¥20,800（粗利率 93.3%）'],
  })),
}));

import express from 'express';
import { request } from "../../../../tests/helpers/testServer";
import { registerTuningRoutes } from './routes';

function makeApp(role: string | null, tenantId = 'tenant-a') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = role ? { email: 'a@example.com', app_metadata: { tenant_id: tenantId, role } } : null;
    next();
  });
  registerTuningRoutes(app);
  return app;
}

beforeEach(() => {
  mockListRules.mockReset().mockResolvedValue([]);
  mockApproveTuningRule.mockReset();
  mockRejectTuningRule.mockReset();
  mockNotify.mockReset().mockResolvedValue(undefined);
  mockBuildFigures.mockReset().mockResolvedValue({
    __audience: 'super_admin', signal: 'text_overage',
    tenant_id: 't1', tenant_name: 'T1',
    current_plan: 'standard', recommended_plan: 'growth',
    current_base_monthly_jpy: 9800, recommended_base_monthly_jpy: 29800,
    text_overage: 500, avatar_overage_minutes: 0,
    revenue_estimate_jpy: 22300, cost_base_jpy: 1500,
    gross_profit_jpy: 20800, gross_margin_pct: 93.3,
    as_of: '2026-09-04T00:00:00.000Z',
  });
});

describe('GET /v1/admin/upsell-proposals', () => {
  it('★client_admin は到達できない(原価・粗利が漏れる面)★', async () => {
    const res = await request(makeApp('client_admin')).get('/v1/admin/upsell-proposals');
    expect(res.status).toBe(403);
  });

  it('未認証は403(または401相当)', async () => {
    const res = await request(makeApp(null)).get('/v1/admin/upsell-proposals');
    expect([401, 403]).toContain(res.status);
  });

  it('super_admin は一覧を取得できる', async () => {
    mockListRules.mockResolvedValue([{
      id: 1, tenant_id: 't1', trigger_pattern: 'upsell:202609:text_overage',
      expected_behavior: 'Growthへの変更を提案', is_active: false, proposal_type: 'upsell',
      status: 'pending', created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
      created_by: null, source_message_id: null,
      evidence: { rationale: 'x', upsell: { signal: 'text_overage', current_plan: 'standard', recommended_plan: 'growth', period_yyyymm: '202609' } },
    }]);
    const res = await request(makeApp('super_admin')).get('/v1/admin/upsell-proposals');
    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0].renderable).toBe(true);
    expect(res.body.proposals[0].headline).toBe('アップセル候補');
  });

  it('★listRules に proposalType=upsell, status=pending が渡る★', async () => {
    await request(makeApp('super_admin')).get('/v1/admin/upsell-proposals');
    expect(mockListRules).toHaveBeenCalledWith(
      undefined, expect.objectContaining({ proposalType: 'upsell', status: 'pending' }),
    );
  });

  it('evidence が壊れている(upsell欠落)行は renderable:false で返し、一覧全体は落ちない', async () => {
    mockListRules.mockResolvedValue([{
      id: 2, tenant_id: 't2', trigger_pattern: 'x', expected_behavior: 'y',
      is_active: false, proposal_type: 'upsell', status: 'pending',
      created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
      created_by: null, source_message_id: null,
      evidence: { rationale: 'no upsell field here' },
    }]);
    const res = await request(makeApp('super_admin')).get('/v1/admin/upsell-proposals');
    expect(res.status).toBe(200);
    expect(res.body.proposals[0].renderable).toBe(false);
    expect(mockBuildFigures).not.toHaveBeenCalled();
  });

  it('evidence.upsell.signal が未知の値(改ざん)でも renderable:false に倒す', async () => {
    mockListRules.mockResolvedValue([{
      id: 3, tenant_id: 't3', trigger_pattern: 'x', expected_behavior: 'y',
      is_active: false, proposal_type: 'upsell', status: 'pending',
      created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
      created_by: null, source_message_id: null,
      evidence: { upsell: { signal: 'drop_tables', current_plan: 'standard', recommended_plan: 'growth', period_yyyymm: '202609' } },
    }]);
    const res = await request(makeApp('super_admin')).get('/v1/admin/upsell-proposals');
    expect(res.body.proposals[0].renderable).toBe(false);
  });

  it('★figures 計算が1件失敗しても他の行は返る(1件の失敗で一覧を落とさない)★', async () => {
    mockListRules.mockResolvedValue([
      { id: 1, tenant_id: 'fail', trigger_pattern: 'x', expected_behavior: 'y', is_active: false, proposal_type: 'upsell', status: 'pending', created_at: 'x', updated_at: 'x', created_by: null, source_message_id: null, evidence: { upsell: { signal: 'text_overage', current_plan: 'standard', recommended_plan: 'growth', period_yyyymm: '202609' } } },
      { id: 2, tenant_id: 'ok', trigger_pattern: 'y', expected_behavior: 'y', is_active: false, proposal_type: 'upsell', status: 'pending', created_at: 'x', updated_at: 'x', created_by: null, source_message_id: null, evidence: { upsell: { signal: 'text_overage', current_plan: 'standard', recommended_plan: 'growth', period_yyyymm: '202609' } } },
    ]);
    mockBuildFigures
      .mockRejectedValueOnce(new Error('stripe timeout'))
      .mockResolvedValueOnce({ __audience: 'super_admin', signal: 'text_overage', tenant_id: 'ok', tenant_name: 'OK', current_plan: 'standard', recommended_plan: 'growth', current_base_monthly_jpy: null, recommended_base_monthly_jpy: null, text_overage: 0, avatar_overage_minutes: 0, revenue_estimate_jpy: null, cost_base_jpy: null, gross_profit_jpy: null, gross_margin_pct: null, as_of: 'x' });

    const res = await request(makeApp('super_admin')).get('/v1/admin/upsell-proposals');
    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(2);
    expect(res.body.proposals.find((p: any) => p.tenant_id === 'fail').renderable).toBe(false);
    expect(res.body.proposals.find((p: any) => p.tenant_id === 'ok').renderable).toBe(true);
  });
});

describe('PUT /v1/admin/upsell-proposals/:id/adopt', () => {
  it('★client_admin は到達できない★', async () => {
    const res = await request(makeApp('client_admin')).put('/v1/admin/upsell-proposals/1/adopt');
    expect(res.status).toBe(403);
  });

  it('採用に成功したら通知を送りテナント側へ届く経路を発火する', async () => {
    mockApproveTuningRule.mockResolvedValue({ id: 1, tenant_id: 't1', status: 'active', is_active: false, proposal_type: 'upsell', approved_at: 'x', rejected_at: null, updated_at: 'x' });
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/1/adopt');
    expect(res.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledWith(1);
  });

  it('★behavior 提案(proposal_type違い)はこのエンドポイントから承認できない★(URL分離の実効性)', async () => {
    mockApproveTuningRule.mockResolvedValue({ id: 5, tenant_id: 't1', status: 'active', is_active: true, proposal_type: 'behavior', approved_at: 'x', rejected_at: null, updated_at: 'x' });
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/5/adopt');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_an_upsell_proposal');
    // 通知は飛ばさない(誤って承認扱いにした FAQ ルールをテナントへ通知しない)
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('存在しないIDは404', async () => {
    mockApproveTuningRule.mockResolvedValue(null);
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/999/adopt');
    expect(res.status).toBe(404);
  });

  it('id が数値でなければ400(パス改ざん)', async () => {
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/abc/adopt');
    expect(res.status).toBe(400);
  });

  it('id が負の数なら400', async () => {
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/-1/adopt');
    expect(res.status).toBe(400);
  });

  it('approveTuningRule が例外を投げたら500で落ち着く', async () => {
    mockApproveTuningRule.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/1/adopt');
    expect(res.status).toBe(500);
  });
});

describe('PUT /v1/admin/upsell-proposals/:id/dismiss', () => {
  it('見送りに成功したら通知は送らない(却下は通知の対象外)', async () => {
    mockRejectTuningRule.mockResolvedValue({ id: 1, tenant_id: 't1', status: 'rejected', is_active: false, proposal_type: 'upsell', approved_at: null, rejected_at: 'x', updated_at: 'x' });
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/1/dismiss');
    expect(res.status).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('behavior 提案はこのエンドポイントから却下できない', async () => {
    mockRejectTuningRule.mockResolvedValue({ id: 5, tenant_id: 't1', status: 'rejected', is_active: false, proposal_type: 'behavior', approved_at: null, rejected_at: 'x', updated_at: 'x' });
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/5/dismiss');
    expect(res.status).toBe(409);
  });

  it('存在しないIDは404', async () => {
    mockRejectTuningRule.mockResolvedValue(null);
    const res = await request(makeApp('super_admin')).put('/v1/admin/upsell-proposals/999/dismiss');
    expect(res.status).toBe(404);
  });
});
