// src/api/avatar/fishAsrRoutes.test.ts
// POST /api/voice/asr — Fish Audio ASR
//
// GID 1216944049264977: Fish ASR は外部APIを叩くのに trackUsage が呼ばれておらず
// 原価が不可視だった。正常系で trackUsage(featureUsed='voice', asrRequestCount=1) が
// 呼ばれることを検証する。

import express from 'express';
import request from 'supertest';
import { registerFishAsrRoutes } from './fishAsrRoutes';

const mockTrackUsage = jest.fn();
jest.mock('../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeApp(tenantId: string | null = 'tenant-a') {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    if (tenantId) req.tenantId = tenantId;
    next();
  });
  const apiStack: any[] = [];
  registerFishAsrRoutes(app, apiStack);
  return app;
}

function mockFishAsrOk(text = 'こんにちは') {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ text }),
  });
}

describe('POST /api/voice/asr', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.FISH_AUDIO_API_KEY = 'test-fish-key';
    mockTrackUsage.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('正常系: 音声を送るとtextを返し、trackUsage(voice, asrRequestCount=1)を1回記録する', async () => {
    mockFishAsrOk('テスト音声のテキスト');

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'テスト音声のテキスト' });

    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        featureUsed: 'voice',
        asrRequestCount: 1,
      })
    );
  });

  it('認証エラー: tenantIdなしは401でtrackUsageを呼ばない', async () => {
    const res = await request(makeApp(null))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('音声ファイル未添付は400でtrackUsageを呼ばない', async () => {
    const res = await request(makeApp('tenant-a')).post('/api/voice/asr');

    expect(res.status).toBe(400);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('Fish Audio APIエラー時は502でtrackUsageを呼ばない（失敗した呼び出しを課金しない）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'upstream error',
    });

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(502);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('FISH_AUDIO_API_KEY未設定は503でtrackUsageを呼ばない', async () => {
    delete process.env.FISH_AUDIO_API_KEY;

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(503);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
