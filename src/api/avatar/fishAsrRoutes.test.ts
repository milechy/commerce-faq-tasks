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

// GID 1217083837550916: 44.1kHz/16bit/モノラルの最小WAVバッファ（parseWavDurationSeconds が
// 実測できる形式）。dataBytes=44100 は byteRate=88200 に対して 0.5 秒に相当する。
function buildWavBuffer(dataBytes = 44100): Buffer {
  const sampleRate = 44100;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const fmtChunkSize = 16;
  const riffChunkSize = 4 + (8 + fmtChunkSize) + (8 + dataBytes);

  const buf = Buffer.alloc(12 + 8 + fmtChunkSize + 8 + dataBytes);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(riffChunkSize, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(fmtChunkSize, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(numChannels, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(byteRate, o); o += 4;
  buf.writeUInt16LE(blockAlign, o); o += 2;
  buf.writeUInt16LE(bitsPerSample, o); o += 2;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataBytes, o); o += 4;
  return buf;
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

  it('GID 1217083837550916: WAVで実測できる場合はasrAudioSecondsを計上し、asrRequestCountは渡さない（二重計上防止）', async () => {
    mockFishAsrOk('テスト音声のテキスト');

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', buildWavBuffer(44100), { filename: 'test.wav', contentType: 'audio/wav' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ asrAudioSeconds: 0.5 }),
    );
    const call = mockTrackUsage.mock.calls[0][0];
    expect('asrRequestCount' in call).toBe(false);
  });

  it('GID 1217083837550916: 実測できない音声（非WAV等）はasrRequestCount:1にフォールバックする', async () => {
    mockFishAsrOk();

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('not-a-wav-file'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ asrRequestCount: 1 }),
    );
    const call = mockTrackUsage.mock.calls[0][0];
    expect('asrAudioSeconds' in call).toBe(false);
  });

  it('GID 1217083837550916: 20MB超過の録音は400で親切な日本語メッセージを返し、trackUsageを呼ばない', async () => {
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', oversized, { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('20MB');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
