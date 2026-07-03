// src/api/avatar/anamChatStreamRoutes.test.ts
// Phase75: 会話ログ永続化(avatar経由の会話をchat_messagesへsaveMessage)の検証

import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { registerAnamChatStreamRoutes } from './anamChatStreamRoutes';

jest.mock('../admin/chat-history/chatHistoryRepository', () => ({
  saveMessage: jest.fn(),
}));

import { saveMessage } from '../admin/chat-history/chatHistoryRepository';
const mockSaveMessage = saveMessage as jest.Mock;

// apiStack: テナントコンテキストをreqに注入するダミーミドルウェア
function makeTenantStack(tenantId: string | null): RequestHandler[] {
  return [
    (req, _res, next) => {
      (req as any).tenantId = tenantId;
      next();
    },
  ];
}

function makeApp(tenantId: string | null = 'carnation') {
  const app = express();
  app.use(express.json());
  registerAnamChatStreamRoutes(app, makeTenantStack(tenantId));
  return app;
}

/** Groqのstreaming SSEレスポンスを模したReadableStream風オブジェクトを作る。 */
function makeGroqStreamResponse(contentChunks: string[]) {
  const lines = contentChunks.map(
    (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`,
  );
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

beforeEach(() => {
  mockSaveMessage.mockReset();
  mockSaveMessage.mockResolvedValue(undefined);
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
