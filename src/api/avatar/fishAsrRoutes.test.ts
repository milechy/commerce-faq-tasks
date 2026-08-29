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

// プランゲート(requireVoicePlan)が `SELECT plan FROM tenants` を1回引く。
// ASRハンドラ自体はDBを引かないので、リクエストあたりのDBクエリはこの1回のみ。
// 既定は standard(通過)にし、ゲートを検証するテストだけ plan を差し替える。
const mockQuery = jest.fn();
jest.mock('../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
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
    mockQuery.mockReset();
    // 既定: voice を含む standard プラン。ゲート検証テストで上書きする。
    mockQuery.mockResolvedValue({ rows: [{ plan: 'standard' }] });
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

  // ── 境界値 ───────────────────────────────────────────────────────────
  // 実機で確認した挙動: multer/busboyのfileSize上限は「以下」ではなく「未満」で
  // 判定される(ちょうど20MBも拒否される)。エラー文言は「20MB未満」に是正済み。
  // ここでは実際の閾値が20MB-1バイトであることを両境界で固定する。
  it('境界値: 20MBちょうどの録音は400で拒否される(multer/busboyのfileSize上限は"未満"判定)', async () => {
    const exactly20MB = Buffer.alloc(20 * 1024 * 1024);

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', exactly20MB, { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('20MB');
  });

  it('境界値: 20MB-1バイトの録音は拒否されない(実際に許容される最大サイズ)', async () => {
    mockFishAsrOk();
    const justUnder20MB = Buffer.alloc(20 * 1024 * 1024 - 1);

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', justUnder20MB, { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(200);
  });

  it('境界値: 0バイトの音声ファイルはクラッシュせず送信を試み、asrRequestCount:1にフォールバックする', async () => {
    mockFishAsrOk();

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.alloc(0), { filename: 'empty.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ asrRequestCount: 1 }),
    );
  });

  // ── イレギュラーなアップロード操作（実機で確認した実害バグの回帰ガード） ──
  // 修正前はどちらもExpressのデフォルトエラー処理に落ち、HTMLの500エラー
  // (内部スタックトレース・サーバーのファイルパスを含む)が返っていた。
  it('イレギュラー: 音声以外のMIMEタイプ(.txt等)は400のJSONで返り、スタックトレースを含むHTMLにならない', async () => {
    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('not audio content'), { filename: 'test.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toBeTruthy();
    expect(res.text).not.toContain('<html');
    expect(res.text).not.toContain('at fileFilter');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('イレギュラー: 同一フィールド名(audio)に複数ファイルを添付しても400のJSONで返る(HTMLの500にならない)', async () => {
    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('a1'), { filename: 'a.webm', contentType: 'audio/webm' })
      .attach('audio', Buffer.from('a2'), { filename: 'b.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.text).not.toContain('<html');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('実世界パターン: LISTチャンク付きのWAV(録音アプリのメタデータ混在)でも秒数を正しく計上する', async () => {
    mockFishAsrOk();

    function chunk(id: string, data: Buffer): Buffer {
      const header = Buffer.alloc(8);
      header.write(id, 0);
      header.writeUInt32LE(data.length, 4);
      const padding = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
      return Buffer.concat([header, data, padding]);
    }
    const fmtData = Buffer.alloc(16);
    fmtData.writeUInt16LE(1, 0); fmtData.writeUInt16LE(1, 2);
    fmtData.writeUInt32LE(44100, 4); fmtData.writeUInt32LE(88200, 8);
    fmtData.writeUInt16LE(2, 12); fmtData.writeUInt16LE(16, 14);

    const body = Buffer.concat([
      chunk('fmt ', fmtData),
      chunk('LIST', Buffer.from('INFOIART\x05\x00\x00\x00Me\x00\x00\x00')), // 奇数長パディング検証も兼ねる
      chunk('data', Buffer.alloc(44100)), // 0.5秒
    ]);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0);
    header.writeUInt32LE(4 + body.length, 4);
    header.write('WAVE', 8);
    const wavWithList = Buffer.concat([header, body]);

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', wavWithList, { filename: 'recorded.wav', contentType: 'audio/wav' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ asrAudioSeconds: 0.5 }),
    );
  });

  // ── プランゲート（原価保護 / 匿名コスト増幅DoS 対策） ──────────────────────
  // ゲートは multer(最大20MBバッファ)の前で判定する。未認可プランは Fish ASR を
  // 呼ばず(=請求不能な原価を発生させず)、アップロードも buffer させない。
  it('プランゲート: free_ad は 403 で multer より前に弾き、Fish/trackUsage を呼ばない', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ plan: 'free_ad' }] });

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_upgrade_required');
    expect(res.body.feature).toBe('voice');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('プランゲート: starter も 403（voice は Standard 以上）', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ plan: 'starter' }] });

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('プランゲート: DB取得失敗時も fail-closed で 403（free_ad へ倒れる）', async () => {
    mockQuery.mockReset();
    mockQuery.mockRejectedValue(new Error('db down')); // queryTenantPlan の catch が free_ad を返す

    const res = await request(makeApp('tenant-a'))
      .post('/api/voice/asr')
      .attach('audio', Buffer.from('fake-audio-bytes'), { filename: 'test.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
