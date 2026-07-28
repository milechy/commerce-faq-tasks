// src/api/avatar/anamChatStreamRoutes.test.ts
// Phase75: 会話ログ永続化(avatar経由の会話をchat_messagesへsaveMessage)の検証

import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { registerAnamChatStreamRoutes } from './anamChatStreamRoutes';

jest.mock('../admin/chat-history/chatHistoryRepository', () => ({
  saveMessage: jest.fn(),
}));

jest.mock('../../lib/billing/usageTracker', () => ({
  trackUsage: jest.fn(),
}));

import { saveMessage } from '../admin/chat-history/chatHistoryRepository';
import { trackUsage } from '../../lib/billing/usageTracker';
const mockSaveMessage = saveMessage as jest.Mock;
const mockTrackUsage = trackUsage as jest.Mock;

// apiStack: テナントコンテキスト + requestId(requestIdMiddleware相当)をreqに注入するダミーミドルウェア
let requestIdCounter = 0;
function makeTenantStack(tenantId: string | null, requestId?: string): RequestHandler[] {
  return [
    (req, _res, next) => {
      (req as any).tenantId = tenantId;
      (req as any).requestId = requestId ?? `req-anam-${++requestIdCounter}`;
      next();
    },
  ];
}

function makeApp(tenantId: string | null = 'carnation', requestId?: string) {
  const app = express();
  app.use(express.json());
  registerAnamChatStreamRoutes(app, makeTenantStack(tenantId, requestId));
  return app;
}

/**
 * Groqのstreaming SSEレスポンスを模したReadableStream風オブジェクトを作る。
 * usage を渡すと、OpenAI互換のstream_options.include_usage同様、最終チャンクとして
 * choicesなし・usageのみのdataを追加する。
 */
function makeGroqStreamResponse(
  contentChunks: string[],
  usage?: { prompt_tokens: number; completion_tokens: number },
) {
  const lines = contentChunks.map(
    (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`,
  );
  if (usage) {
    lines.push(`data: ${JSON.stringify({ choices: [], usage })}\n`);
  }
  lines.push('data: [DONE]\n');
  const fullText = lines.join('');
  const encoder = new TextEncoder();
  const bytes = encoder.encode(fullText);

  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

/** ストリーム読み取り中にreader.read()が例外を投げる(接続断)ケースを模す。 */
function makeGroqStreamInterrupted() {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          throw new Error('socket hang up');
        },
      }),
    },
  };
}

beforeEach(() => {
  mockSaveMessage.mockReset();
  mockSaveMessage.mockResolvedValue(undefined);
  mockTrackUsage.mockReset();
  process.env.GROQ_API_KEY = 'test-groq-key';
  (global as any).fetch = jest.fn().mockResolvedValue(makeGroqStreamResponse(['こんにちは', '！']));
});

afterEach(() => {
  delete (global as any).fetch;
});

describe('POST /api/avatar/chat-stream', () => {
  it('正常系: ユーザーの最新発話とアシスタント応答(結合済み)をmetadata.source=avatarで保存する', async () => {
    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '保証はありますか' }], sessionId: 'sess-1' });

    expect(res.status).toBe(200);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'carnation',
        sessionId: 'sess-1',
        role: 'user',
        content: '保証はありますか',
        metadata: { source: 'avatar', channel: 'anam' },
      }),
    );
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'carnation',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'こんにちは！',
        metadata: { source: 'avatar', channel: 'anam' },
      }),
    );
  });

  it('sessionId未指定時はランダム生成され、user/assistant両方に同じIDが使われる', async () => {
    await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'こんにちは' }] });

    const userCall = mockSaveMessage.mock.calls.find((c) => c[0].role === 'user');
    const assistantCall = mockSaveMessage.mock.calls.find((c) => c[0].role === 'assistant');
    expect(userCall![0].sessionId).toBeTruthy();
    expect(userCall![0].sessionId).toBe(assistantCall![0].sessionId);
  });

  it('複数ターンのmessages配列では最新のuserメッセージのみ保存する(履歴の重複保存を防ぐ)', async () => {
    await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({
        sessionId: 'sess-2',
        messages: [
          { role: 'user', content: '1つ目の質問' },
          { role: 'assistant', content: '1つ目の回答' },
          { role: 'user', content: '2つ目の質問' },
        ],
      });

    const userCalls = mockSaveMessage.mock.calls.filter((c) => c[0].role === 'user');
    expect(userCalls).toHaveLength(1);
    expect(userCalls[0][0].content).toBe('2つ目の質問');
  });

  it('認証エラー: tenantId欠落は401、saveMessageは呼ばれない', async () => {
    const res = await request(makeApp(null))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'こんにちは' }] });

    expect(res.status).toBe(401);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it('バリデーションエラー: messages配列が空/不正は400', async () => {
    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [] });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/avatar/chat-stream — usage計測(trackUsage)', () => {
  it('usageが返る場合: Groqの最終チャンクのprompt_tokens/completion_tokensでtrackUsageを1回呼ぶ', async () => {
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(
        makeGroqStreamResponse(['こんにちは', '！'], { prompt_tokens: 42, completion_tokens: 7 }),
      );

    const res = await request(makeApp('carnation', 'req-usage-ok'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '保証はありますか' }], sessionId: 'sess-usage-1' });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith({
      tenantId: 'carnation',
      requestId: 'req-usage-ok',
      model: 'llama-3.3-70b-versatile',
      inputTokens: 42,
      outputTokens: 7,
      featureUsed: 'chat',
    });
  });

  it('usageが返らない場合: silentに0計上せずlogger.warnを出しつつ0でtrackUsageする', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(makeGroqStreamResponse(['こんにちは']));
    const warnSpy = jest.spyOn(require('../../lib/logger').logger, 'warn').mockImplementation(() => {});

    const res = await request(makeApp('carnation', 'req-usage-missing'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'こんにちは' }] });

    expect(res.status).toBe(200);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'carnation',
        requestId: 'req-usage-missing',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'chat',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-usage-missing', tenantId: 'carnation' }),
      expect.stringContaining('usage not returned'),
    );

    warnSpy.mockRestore();
  });

  it('ストリーム中断(接続断)の場合でも0扱いでtrackUsageを1回呼び、warnを出す(例外はレスポンスに変換される)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(makeGroqStreamInterrupted());
    const warnSpy = jest.spyOn(require('../../lib/logger').logger, 'warn').mockImplementation(() => {});

    const res = await request(makeApp('carnation', 'req-usage-interrupted'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'こんにちは' }] });

    // 最初のread()で例外なので、res.write前(headersSent=false)にouterのcatchへ抜け500になる。
    expect(res.status).toBe(500);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'carnation',
        requestId: 'req-usage-interrupted',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'chat',
      }),
    );
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('同一requestIdで再接続されても、trackUsageに渡すrequestIdは常に同じ安定キーになる(重複計上防止はDB側のON CONFLICTに委譲)', async () => {
    // 各呼び出しごとに独立したstream/readerを返す(closureの使い回しでstate漏れしないように)。
    (global as any).fetch = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          makeGroqStreamResponse(['再送されたテスト応答'], { prompt_tokens: 10, completion_tokens: 5 }),
        ),
      );

    const app = makeApp('carnation', 'req-reconnect-stable');
    await request(app)
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '1回目' }], sessionId: 'sess-reconnect' });
    await request(app)
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '2回目(再接続)' }], sessionId: 'sess-reconnect' });

    expect(mockTrackUsage).toHaveBeenCalledTimes(2);
    for (const call of mockTrackUsage.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          requestId: 'req-reconnect-stable',
          inputTokens: 10,
          outputTokens: 5,
        }),
      );
    }
    // 実際のusage_logsは request_id UNIQUE + ON CONFLICT DO NOTHING (usageTracker.ts) により
    // 同一requestIdでの複数呼び出しでも1行のみ保存される(usageTracker.test.ts で検証済み)。
  });
});
