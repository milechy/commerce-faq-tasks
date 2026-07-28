// src/api/admin/options/saiBridge.test.ts
// Phase2 (Sai接続ブリッジ): try-sai / sai-task エンドポイントのテスト

import express from 'express';
import request from 'supertest';
import { registerOptionRoutes, checkSaiMonthlyCostCeiling } from './routes';
import { logger } from '../../../lib/logger';

jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../../lib/billing/stripeSync', () => ({
  chargeOneOffJpy: jest.fn(),
}));

jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockSubmitSaiTask = jest.fn();
const mockGetSaiTask = jest.fn();
jest.mock('../../../lib/sai/saiClient', () => ({
  submitSaiTask: (...args: unknown[]) => mockSubmitSaiTask(...args),
  getSaiTask: (...args: unknown[]) => mockGetSaiTask(...args),
}));

const mockTrackUsage = jest.fn();
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

// Phase6 (Sai Judge学習ループ): デフォルトはルール0件(=現状データなし)で既存挙動と同じにする
const mockGetActiveSaiRulesForTenant = jest.fn().mockResolvedValue([]);
const mockListSaiRules = jest.fn();
const mockApproveSaiRule = jest.fn();
const mockRejectSaiRule = jest.fn();
jest.mock('../../../lib/sai/saiTaskRulesRepository', () => {
  const actual = jest.requireActual('../../../lib/sai/saiTaskRulesRepository');
  return {
    ...actual,
    getActiveSaiRulesForTenant: (...args: unknown[]) => mockGetActiveSaiRulesForTenant(...args),
    listSaiRules: (...args: unknown[]) => mockListSaiRules(...args),
    approveSaiRule: (...args: unknown[]) => mockApproveSaiRule(...args),
    rejectSaiRule: (...args: unknown[]) => mockRejectSaiRule(...args),
  };
});

function makeApp(role = 'client_admin', tenantId = 'tenant-x') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: tenantId, role } };
    next();
  });
  registerOptionRoutes(app);
  return app;
}

function superAdminApp() {
  return makeApp('super_admin', '');
}

describe('POST /v1/admin/options/:id/try-sai', () => {
  const savedCeiling = process.env.SAI_MONTHLY_COST_CEILING_CENTS;
  const savedGlobalCeiling = process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;

  beforeEach(() => {
    jest.clearAllMocks();
    // デフォルトは明示的に無制限('0')にしておき、上限そのものを検証したいテストだけが
    // 個別に上書き/未設定化する(GID 1216947740906009 で未設定時のデフォルト上限が有効化された
    // ため、上限チェックを意図しない既存テストへ副作用が及ぶのを防ぐ)。
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '0';
    process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
  });

  afterEach(() => {
    if (savedCeiling === undefined) delete process.env.SAI_MONTHLY_COST_CEILING_CENTS;
    else process.env.SAI_MONTHLY_COST_CEILING_CENTS = savedCeiling;
    if (savedGlobalCeiling === undefined) delete process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;
    else process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = savedGlobalCeiling;
  });

  it('super_admin以外は403', async () => {
    const res = await request(makeApp()).post('/v1/admin/options/order-1/try-sai').send({});
    expect(res.status).toBe(403);
    expect(mockSubmitSaiTask).not.toHaveBeenCalled();
  });

  it('存在しない発注は404', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(superAdminApp()).post('/v1/admin/options/missing/try-sai').send({});
    expect(res.status).toBe(404);
  });

  it('Saiにタスクを投げ、sai_task_idを保存して202を返す', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'FAQ登録代行' }] });
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // sai_task_id UPDATE

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ task_id: 'sai-task-1', status: 'queued' });
    expect(mockSubmitSaiTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'FAQ登録代行', orderId: 'order-1' }),
    );
    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE option_orders SET sai_task_id'),
      ['order-1', 'sai-task-1'],
    );
  });

  it('Phase6: 承認済みルールが0件なら作業内容はそのまま渡す(現状のデフォルト挙動)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'FAQ登録代行' }] });
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(mockGetActiveSaiRulesForTenant).toHaveBeenCalledWith('tenant-x');
    expect(mockSubmitSaiTask).toHaveBeenCalledWith(expect.objectContaining({ description: 'FAQ登録代行' }));
  });

  it('Phase6: trigger_patternが一致する承認済みルールがあれば作業内容の先頭に注入する', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'FAQ登録代行をお願いします' }] });
    mockGetActiveSaiRulesForTenant.mockResolvedValueOnce([
      { id: 1, tenant_id: 'tenant-x', trigger_pattern: 'FAQ登録', expected_behavior: '保存ボタンは画面右上にある', priority: 0, is_active: true, status: 'active', source: 'sai_judge', evidence: null, created_by: null, approved_at: null, rejected_at: null, created_at: '', updated_at: '' },
    ]);
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    const sentDescription = mockSubmitSaiTask.mock.calls[0]![0].description as string;
    expect(sentDescription).toContain('保存ボタンは画面右上にある');
    expect(sentDescription).toContain('FAQ登録代行をお願いします');
  });

  // GID 1216947740906009: env未設定時はデフォルト上限(テナント$50/月・全体$200/月)が適用される。
  it('SAI_MONTHLY_COST_CEILING_CENTS未設定時はデフォルト上限($50/月)が適用され、下回っていれば通常通り依頼できる', async () => {
    delete process.env.SAI_MONTHLY_COST_CEILING_CENTS;
    delete process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] }); // 発注SELECT
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // テナント上限チェックSELECT（$50未満）
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // 全体上限チェックSELECT（$200未満）
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // sai_task_id UPDATE

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(202);
    // env未設定でもデフォルト上限のチェックは行われる(発注SELECT+テナント上限SELECT+全体上限SELECT+UPDATE)
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it('env未設定でテナント使用量がデフォルト上限($50=5000セント)以上なら429で拒否される', async () => {
    delete process.env.SAI_MONTHLY_COST_CEILING_CENTS;
    delete process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '5000' }] }); // テナント上限ちょうど到達

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(429);
    expect(mockSubmitSaiTask).not.toHaveBeenCalled();
  });

  it('env未設定でテナントは上限内だが全体使用量がデフォルト上限($200=20000セント)以上なら429で拒否される', async () => {
    delete process.env.SAI_MONTHLY_COST_CEILING_CENTS;
    delete process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // テナント上限: 余裕あり
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '20000' }] }); // 全体上限ちょうど到達

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(429);
    expect(mockSubmitSaiTask).not.toHaveBeenCalled();
  });

  it('env に明示的に"0"を渡すと従来どおり無制限になる(エスカレーション時の逃げ道)', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '0';
    process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] });
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(202);
    // 明示的に0を渡すと上限チェックSELECTは発火しない(発注SELECT+UPDATEのみ)
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('月次コスト上限に達している場合は429を返しSaiに依頼しない', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '1000';
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] }); // 発注SELECT
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1000' }] }); // 上限チェックSELECT

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(429);
    expect(mockSubmitSaiTask).not.toHaveBeenCalled();
  });

  it('月次コスト上限未満なら通常通りSaiに依頼する', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '1000';
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] }); // 発注SELECT
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '500' }] }); // 上限チェックSELECT
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    expect(res.status).toBe(202);
    expect(mockSubmitSaiTask).toHaveBeenCalled();
  });

  it('バグ修正の回帰確認: 上限チェックSELECTはテナント単位(tenant_id条件)でフィルタする', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '1000';
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', tenant_id: 'tenant-x', description: 'x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '500' }] });
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-1', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});

    const ceilingCall = mockQuery.mock.calls[1]!;
    expect(ceilingCall[0]).toContain('tenant_id = $1');
    expect(ceilingCall[1]).toEqual(['tenant-x']);
  });

  it('テナント横断バグの回帰確認: テナントAが上限超過していてもテナントBは依頼できる', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '1000';

    // 1回目: テナントAの発注 → 上限超過(429、依頼しない)
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-a', tenant_id: 'tenant-a', description: 'x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1000' }] });
    const resA = await request(superAdminApp()).post('/v1/admin/options/order-a/try-sai').send({});
    expect(resA.status).toBe(429);
    expect(mockSubmitSaiTask).not.toHaveBeenCalled();

    // 2回目: テナントBの発注 → 未使用(0円)なので依頼できる
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-b', tenant_id: 'tenant-b', description: 'y' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockSubmitSaiTask.mockResolvedValueOnce({ task_id: 'sai-task-b', status: 'queued' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const resB = await request(superAdminApp()).post('/v1/admin/options/order-b/try-sai').send({});

    expect(resB.status).toBe(202);
    expect(mockSubmitSaiTask).toHaveBeenCalledWith(expect.objectContaining({ description: 'y' }));
  });

  it('SAI_API_KEY未設定時は503', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', description: 'x' }] });
    mockSubmitSaiTask.mockRejectedValueOnce(new Error('SAI_API_KEY not set'));

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});
    expect(res.status).toBe(503);
  });

  it('Sai API呼び出し失敗時は502', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', description: 'x' }] });
    mockSubmitSaiTask.mockRejectedValueOnce(new Error('Sai API error: 503'));

    const res = await request(superAdminApp()).post('/v1/admin/options/order-1/try-sai').send({});
    expect(res.status).toBe(502);
  });
});

describe('GET /v1/admin/options/:id/sai-task', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('super_admin以外は403', async () => {
    const res = await request(makeApp()).get('/v1/admin/options/order-1/sai-task');
    expect(res.status).toBe(403);
  });

  it('未試行の発注は404', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ sai_task_id: null }] });
    const res = await request(superAdminApp()).get('/v1/admin/options/order-1/sai-task');
    expect(res.status).toBe(404);
  });

  it('実行中タスクの状態(スクリーンショットなし)を返す', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-x', sai_task_id: 'sai-task-1' }] });
    mockGetSaiTask.mockResolvedValueOnce({ status: 'running', steps: 2, description: 'x', max_steps: 15 });

    const res = await request(superAdminApp()).get('/v1/admin/options/order-1/sai-task');

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('running');
    // 完了前はDBを更新しない・課金記録もしない
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('完了タスクはfinal_screenshot_base64を含めて返し、sai_outcomeを保存する（自動完了はしない）', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-x', sai_task_id: 'sai-task-1' }] });
    mockGetSaiTask.mockResolvedValueOnce({
      status: 'complete', steps: 3, description: 'x', max_steps: 15,
      outcome: 'agent_reported_done', final_screenshot_base64: 'AAAA', steps_log: [],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // sai_outcome UPDATE

    const res = await request(superAdminApp()).get('/v1/admin/options/order-1/sai-task');

    expect(res.status).toBe(200);
    expect(res.body.task.final_screenshot_base64).toBe('AAAA');
    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE option_orders SET sai_outcome'),
      ['order-1', 'agent_reported_done'],
    );
    // status/final_amount/completed_atなどは一切更新しない = /complete エンドポイントとは別経路

    // 社内原価集計: sai_agentとしてtrackUsageを呼ぶ(テナント請求には影響しない marginOverride:1)
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-x',
        requestId: 'sai-task:sai-task-1',
        featureUsed: 'sai_agent',
        marginOverride: 1,
        saiAgentSteps: 3,
      }),
    );
  });
});

describe('Phase6 (Sai Judge学習ループ): /v1/admin/sai-rules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSaiRulesForTenant.mockResolvedValue([]);
  });

  it('GET: super_admin以外は403', async () => {
    const res = await request(makeApp()).get('/v1/admin/sai-rules');
    expect(res.status).toBe(403);
  });

  it('GET: ルール一覧を返す(source/statusフィルタをクエリから渡す)', async () => {
    mockListSaiRules.mockResolvedValueOnce([{ id: 1, trigger_pattern: 'x', expected_behavior: 'y' }]);

    const res = await request(superAdminApp()).get('/v1/admin/sai-rules?source=sai_judge&status=pending');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(mockListSaiRules).toHaveBeenCalledWith(undefined, { source: 'sai_judge', status: 'pending' });
  });

  it('PUT /:id/approve: super_admin以外は403', async () => {
    const res = await request(makeApp()).put('/v1/admin/sai-rules/1/approve');
    expect(res.status).toBe(403);
    expect(mockApproveSaiRule).not.toHaveBeenCalled();
  });

  it('PUT /:id/approve: ルールを承認する', async () => {
    mockApproveSaiRule.mockResolvedValueOnce({ id: 1, status: 'active', is_active: true });

    const res = await request(superAdminApp()).put('/v1/admin/sai-rules/1/approve');

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('active');
    expect(mockApproveSaiRule).toHaveBeenCalledWith(1);
  });

  it('PUT /:id/approve: 存在しないルールは404', async () => {
    mockApproveSaiRule.mockResolvedValueOnce(null);
    const res = await request(superAdminApp()).put('/v1/admin/sai-rules/999/approve');
    expect(res.status).toBe(404);
  });

  it('PUT /:id/reject: ルールを却下する', async () => {
    mockRejectSaiRule.mockResolvedValueOnce({ id: 1, status: 'rejected', is_active: false });

    const res = await request(superAdminApp()).put('/v1/admin/sai-rules/1/reject');

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('rejected');
    expect(mockRejectSaiRule).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// checkSaiMonthlyCostCeiling: バグ修正(テナント横断集計 → テナント単位 + 任意の全体上限)の直接検証
// ---------------------------------------------------------------------------
describe('checkSaiMonthlyCostCeiling', () => {
  const savedTenantCeiling = process.env.SAI_MONTHLY_COST_CEILING_CENTS;
  const savedGlobalCeiling = process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;

  beforeEach(() => {
    mockQuery.mockReset();
    delete process.env.SAI_MONTHLY_COST_CEILING_CENTS;
    delete process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;
  });

  afterAll(() => {
    if (savedTenantCeiling === undefined) delete process.env.SAI_MONTHLY_COST_CEILING_CENTS;
    else process.env.SAI_MONTHLY_COST_CEILING_CENTS = savedTenantCeiling;
    if (savedGlobalCeiling === undefined) delete process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS;
    else process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = savedGlobalCeiling;
  });

  // GID 1216947740906009: env未設定時はデフォルト上限(テナント5000セント=$50・全体20000セント=$200)が適用される。
  it('両方未設定ならデフォルト上限($50/$200)が適用され、下回っていればokを返す', async () => {
    const pool = { query: mockQuery };

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // テナント: $50未満
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // 全体: $200未満
    const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

    expect(result).toEqual({ ok: true });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('未設定時、テナント使用量がデフォルト上限(5000セント)以上なら reason=tenant で拒否する', async () => {
    const pool = { query: mockQuery };

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '5000' }] });
    const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

    expect(result).toEqual({ ok: false, reason: 'tenant', spentCents: 5000, ceilingCents: 5000 });
  });

  it('未設定時、テナント上限は未満だが全体使用量がデフォルト上限(20000セント)以上なら reason=global で拒否する', async () => {
    const pool = { query: mockQuery };

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // テナント: 余裕あり
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '20000' }] }); // 全体: 上限到達
    const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

    expect(result).toEqual({ ok: false, reason: 'global', spentCents: 20000, ceilingCents: 20000 });
  });

  it('明示的に"0"を渡すとテナント・全体とも無制限になり、DBクエリを一切発行しない(エスカレーション時の逃げ道)', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '0';
    process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
    const pool = { query: mockQuery };
    const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

    expect(result).toEqual({ ok: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // 安全弁は fail-safe(不正な設定ならデフォルトへフォールバック)であるべきで、
  // fail-open(不正な設定で誤って無制限になる)を避ける。無制限にできるのは明示的な '0' のみ。
  describe('不正なenv値はfail-safeでデフォルトにフォールバックする(fail-openしない)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('空文字は不正値としてデフォルト値(5000セント)にフォールバックする(無制限にならない)', async () => {
      process.env.SAI_MONTHLY_COST_CEILING_CENTS = '';
      process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
      const pool = { query: mockQuery };

      mockQuery.mockResolvedValueOnce({ rows: [{ total: '5000' }] }); // デフォルト上限ちょうど到達
      const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'tenant', spentCents: 5000, ceilingCents: 5000 });
    });

    it("'abc'等のタイポ(NaN)はデフォルト値にフォールバックし、警告ログを出す", async () => {
      process.env.SAI_MONTHLY_COST_CEILING_CENTS = 'abc';
      process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
      const pool = { query: mockQuery };

      mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] });
      const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

      expect(result).toEqual({ ok: true });
      expect(mockQuery.mock.calls[0]![1]).toEqual(['tenant-a']);
      // デフォルト値(5000セント)が使われたことを、上限超過ケースで確認
      warnSpy.mockClear();
      mockQuery.mockResolvedValueOnce({ rows: [{ total: '5000' }] });
      const result2 = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');
      expect(result2).toEqual({ ok: false, reason: 'tenant', spentCents: 5000, ceilingCents: 5000 });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ envValue: 'abc', label: 'SAI_MONTHLY_COST_CEILING_CENTS' }),
        expect.stringContaining('invalid'),
      );
    });

    it("'-100'(負値)はデフォルト値にフォールバックし、警告ログを出す", async () => {
      process.env.SAI_MONTHLY_COST_CEILING_CENTS = '-100';
      process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
      const pool = { query: mockQuery };

      mockQuery.mockResolvedValueOnce({ rows: [{ total: '5000' }] }); // デフォルト上限ちょうど到達
      const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'tenant', spentCents: 5000, ceilingCents: 5000 });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ envValue: '-100', label: 'SAI_MONTHLY_COST_CEILING_CENTS' }),
        expect.stringContaining('invalid'),
      );
    });

    it("正しい数値('10000')はそのまま使われ、警告ログは出ない", async () => {
      process.env.SAI_MONTHLY_COST_CEILING_CENTS = '10000';
      process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
      const pool = { query: mockQuery };

      mockQuery.mockResolvedValueOnce({ rows: [{ total: '10000' }] });
      const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'tenant', spentCents: 10000, ceilingCents: 10000 });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('全体上限側も同じ規則が適用される(空文字→デフォルト20000セントにフォールバック)', async () => {
      process.env.SAI_MONTHLY_COST_CEILING_CENTS = '0';
      process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '';
      const pool = { query: mockQuery };

      mockQuery.mockResolvedValueOnce({ rows: [{ total: '20000' }] }); // 全体デフォルト上限ちょうど到達
      const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'global', spentCents: 20000, ceilingCents: 20000 });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ envValue: '', label: 'SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS' }),
        expect.stringContaining('invalid'),
      );
    });
  });

  it('テナントAが上限超過していてもテナントBの判定には影響しない(テナント単位)', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '1000';
    process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0'; // このテストの対象外(テナント単位の検証)
    const pool = { query: mockQuery };

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1500' }] });
    const resultA = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');
    expect(resultA).toEqual({ ok: false, reason: 'tenant', spentCents: 1500, ceilingCents: 1000 });

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    const resultB = await checkSaiMonthlyCostCeiling(pool, 'tenant-b');
    expect(resultB).toEqual({ ok: true });

    expect(mockQuery.mock.calls[0]![1]).toEqual(['tenant-a']);
    expect(mockQuery.mock.calls[1]![1]).toEqual(['tenant-b']);
  });

  it('テナント上限は未満だが全体(自社防衛)上限に達している場合は reason=global で拒否する', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '10000';
    process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '5000';
    const pool = { query: mockQuery };

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '100' }] }); // テナント単位: 余裕あり
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '5000' }] }); // 全体: 上限到達

    const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');
    expect(result).toEqual({ ok: false, reason: 'global', spentCents: 5000, ceilingCents: 5000 });
  });

  it('全体上限を明示的に0にすると全体集計クエリは発行しない(テナント上限のみ有効)', async () => {
    process.env.SAI_MONTHLY_COST_CEILING_CENTS = '1000';
    process.env.SAI_MONTHLY_COST_CEILING_GLOBAL_CENTS = '0';
    const pool = { query: mockQuery };

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    const result = await checkSaiMonthlyCostCeiling(pool, 'tenant-a');

    expect(result).toEqual({ ok: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
