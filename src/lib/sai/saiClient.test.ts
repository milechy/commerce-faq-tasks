// src/lib/sai/saiClient.test.ts
// Sai VPS 接続クライアントの単体テスト

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { submitSaiTask, getSaiTask } from './saiClient';

describe('saiClient', () => {
  const savedApiKey = process.env['SAI_API_KEY'];
  const savedBaseUrl = process.env['SAI_API_BASE_URL'];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['SAI_API_KEY'] = 'test-sai-key';
    process.env['SAI_API_BASE_URL'] = 'http://sai.example.internal:8787';
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env['SAI_API_KEY'];
    else process.env['SAI_API_KEY'] = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env['SAI_API_BASE_URL'];
    else process.env['SAI_API_BASE_URL'] = savedBaseUrl;
  });

  describe('submitSaiTask', () => {
    it('SAI_API_KEY未設定時は例外を投げAPIを呼ばない', async () => {
      delete process.env['SAI_API_KEY'];
      await expect(submitSaiTask({ description: 'x' })).rejects.toThrow('SAI_API_KEY not set');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('Bearer認証ヘッダー付きでPOSTし、task_idを返す', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task_id: 'task-1', status: 'queued' }),
      });

      const result = await submitSaiTask({ description: 'FAQ登録代行', orderId: 'order-1', maxSteps: 20 });

      expect(result).toEqual({ task_id: 'task-1', status: 'queued' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://sai.example.internal:8787/v1/tasks',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer test-sai-key' }),
        }),
      );
      const body = JSON.parse((mockFetch.mock.calls[0]![1] as any).body);
      expect(body).toEqual({ description: 'FAQ登録代行', max_steps: 20, order_id: 'order-1' });
    });

    it('max_steps省略時はデフォルト15を送る', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ task_id: 't', status: 'queued' }) });
      await submitSaiTask({ description: 'x' });
      const body = JSON.parse((mockFetch.mock.calls[0]![1] as any).body);
      expect(body.max_steps).toBe(15);
    });

    it('APIエラー時は例外を投げる', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'busy' });
      await expect(submitSaiTask({ description: 'x' })).rejects.toThrow('Sai API error: 503');
    });
  });

  describe('getSaiTask', () => {
    it('Bearer認証ヘッダー付きでGETし、タスク状態を返す', async () => {
      const taskBody = { status: 'complete', steps: 3, description: 'x', max_steps: 15, outcome: 'agent_reported_done', final_screenshot_base64: 'AAAA' };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => taskBody });

      const result = await getSaiTask('task-1');

      expect(result).toEqual(taskBody);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://sai.example.internal:8787/v1/tasks/task-1',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-sai-key' }) }),
      );
    });

    it('404などAPIエラー時は例外を投げる', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' });
      await expect(getSaiTask('missing')).rejects.toThrow('Sai API error: 404');
    });
  });
});
