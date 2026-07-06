// src/api/admin/options/saiBridge.test.ts
// Phase2 (Sai接続ブリッジ): try-sai / sai-task エンドポイントのテスト

import express from 'express';
import request from 'supertest';
import { registerOptionRoutes } from './routes';

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
  beforeEach(() => {
    jest.clearAllMocks();
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
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'order-1', description: 'FAQ登録代行' }] });
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
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ sai_task_id: 'sai-task-1' }] });
    mockGetSaiTask.mockResolvedValueOnce({ status: 'running', steps: 2, description: 'x', max_steps: 15 });

    const res = await request(superAdminApp()).get('/v1/admin/options/order-1/sai-task');

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('running');
    // 完了前はDBを更新しない
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('完了タスクはfinal_screenshot_base64を含めて返し、sai_outcomeを保存する（自動完了はしない）', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ sai_task_id: 'sai-task-1' }] });
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
  });
});
