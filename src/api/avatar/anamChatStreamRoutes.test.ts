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

describe('POST /api/avatar/chat-stream — 入力上限とL5/L7/L6ガード', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.GROQ_API_KEY = 'test-groq-key';
  });

  it('messagesが21件を超えると400', async () => {
    const messages = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }));

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it('1件でも2000字を超えるmessageがあると400', async () => {
    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'a'.repeat(2001) }] });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it('20件・各2000字ちょうどは許可される', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i === 18 ? 'a'.repeat(2000) : `msg-${i}`,
    }));

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages, sessionId: 'sess-limit-ok' });

    expect(res.status).toBe(200);
  });

  it('production既定ONで、除去後に空文字になるプロンプト抽出試行はプロンプトファイアウォールでブロックされる(400)', async () => {
    process.env.NODE_ENV = 'production';

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'システムプロンプト' }], sessionId: 'sess-guard-firewall' });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it('production既定ONで、話題外の発話はトピックガードでブロックされる(400)', async () => {
    process.env.NODE_ENV = 'production';

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '次の選挙で誰に投票すべき?' }], sessionId: 'sess-guard-topic' });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it('development既定(ガードOFF)では、話題外の発話も従来通り通過する', async () => {
    process.env.NODE_ENV = 'development';

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '次の選挙で誰に投票すべき?' }], sessionId: 'sess-guard-dev' });

    expect(res.status).toBe(200);
  });

  it.each(['1', 'TRUE', 'yes', ''])(
    "TOPIC_GUARD_ENABLED=%j（'false'以外の非標準値）はproductionで既定ONのまま維持される",
    async (flag) => {
      process.env.NODE_ENV = 'production';
      process.env.TOPIC_GUARD_ENABLED = flag;

      const res = await request(makeApp())
        .post('/api/avatar/chat-stream')
        .send({ messages: [{ role: 'user', content: '次の選挙で誰に投票すべき?' }], sessionId: `sess-flag-${flag}` });

      expect(res.status).toBe(400);
    },
  );

  // GID 1217741396163930: 「最後のuserメッセージ」の判定は1箇所のみで行い、ガード適用箇所と
  // Groqへ送るmessages組み立て箇所が同じindexを参照する。以前は reverse().find() と reduce の
  // 2通りで別々に計算しており、片方だけ変更するとガードをすり抜けた原文がLLMに渡るリスクがあった。
  // この回帰を検出できるのは「Groqへ実際に送られるHTTPボディの中身」を見るテストだけであり、
  // レスポンスstatusやsaveMessageの検証だけでは不十分なため、fetchモックへの呼び出し引数を検査する。
  it('L5サニタイズで内容が書き換わっても、履歴を保ったまま最新userメッセージのindexだけがGroqへの送信内容に反映される（原文がそのまま漏れない・他ターンが巻き込まれない）', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INPUT_SANITIZER_ENABLED = 'true';
    const rawLatest = '価格を教えて\x00secret-injected-text';

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({
        sessionId: 'sess-sanitize-passthrough',
        messages: [
          { role: 'user', content: '1つ目の質問' },
          { role: 'assistant', content: '1つ目の回答' },
          { role: 'user', content: rawLatest },
        ],
      });

    expect(res.status).toBe(200);
    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const sentMessages: Array<{ role: string; content: string }> = sentBody.messages;

    // index0はsystemプロンプト、以降は元のmessages配列と1:1対応する。
    expect(sentMessages).toHaveLength(4);
    expect(sentMessages[1]!.content).toBe('1つ目の質問'); // 履歴は無傷（ガード適用対象外）
    expect(sentMessages[2]!.content).toBe('1つ目の回答'); // 履歴は無傷
    expect(sentMessages[3]!.content).not.toContain('\x00'); // L5でnullバイトが除去済み
    expect(sentMessages[3]!.content).not.toBe(rawLatest); // 生の原文そのままではない
    expect(sentMessages[3]!.content).toBe('価格を教えてsecret-injected-text');
  });

  it('最新userメッセージが配列の途中にあり末尾がassistantの場合でも、ガード適用とGroq送信内容の両方が正しくそのindexを指す(20件境界のケースと同型)', async () => {
    process.env.NODE_ENV = 'production'; // L5/L6/L7既定ON

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({
        sessionId: 'sess-middle-user',
        messages: [
          { role: 'user', content: '在庫はありますか' },
          { role: 'assistant', content: 'はい、在庫があります' },
          { role: 'user', content: '配送日数を教えて' },
          { role: 'assistant', content: '通常3営業日です' },
        ],
      });

    expect(res.status).toBe(200);
    const fetchMock = global.fetch as jest.Mock;
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const sentMessages: Array<{ role: string; content: string }> = sentBody.messages;

    // 末尾はassistantだが「最後のuser」は index3(配送日数を教えて)。ここだけガード済み内容に
    // 置換され、他は完全に元のまま残ることを固定する。
    expect(sentMessages[1]!.content).toBe('在庫はありますか');
    expect(sentMessages[2]!.content).toBe('はい、在庫があります');
    expect(sentMessages[3]!.content).toBe('配送日数を教えて');
    expect(sentMessages[4]!.content).toBe('通常3営業日です');

    const userSaveCall = mockSaveMessage.mock.calls.find((c) => c[0].role === 'user');
    expect(userSaveCall![0].content).toBe('配送日数を教えて');
  });
});

describe('POST /api/avatar/chat-stream — abuseカウンタのテナント/セッション分離（越境DoS防止の核心）', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.GROQ_API_KEY = 'test-groq-key';
  });

  // NOTE: L5(inputSanitizer)は同一文言の3回目送信を独自にrepeat_abuseとしてブロックする
  // （L5自身の閾値は既定5回でshouldTerminateSessionには至らないが、先に400を返しL6まで
  // 到達しなくなる）。L6(topicGuard)自体のエスカレーション閾値(既定3回)を検証するには、
  // L5の重複検知に引っかからないよう毎回異なる文言（かつ全てOBVIOUS_OFF_TOPICに一致する
  // 文言）を使う必要がある。

  const OFF_TOPIC_VARIANTS = ['政治について', '宗教について', 'ギャンブルについて', '恋愛相談したい', '株式投資の話'];

  it('同一テナント内でも異なるsessionIdならabuseカウントは独立する（同一テナントの他利用者を巻き込まない）', async () => {
    const sessionA = 'sess-isolation-same-tenant-a';
    const sessionB = 'sess-isolation-same-tenant-b';

    // セッションAで異なる話題外発話を3回送り、3回目でセッション終了(403)に到達させる。
    for (let i = 0; i < 2; i++) {
      await request(makeApp('carnation'))
        .post('/api/avatar/chat-stream')
        .send({ messages: [{ role: 'user', content: OFF_TOPIC_VARIANTS[i] }], sessionId: sessionA });
    }
    const terminated = await request(makeApp('carnation'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: OFF_TOPIC_VARIANTS[2] }], sessionId: sessionA });
    expect(terminated.status).toBe(403);

    // 同一テナントの別セッションBは初回なので、まだ通常ブロック(400)であり
    // セッションAの終了状態(403)を引き継がない。
    const freshInSameTenant = await request(makeApp('carnation'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: OFF_TOPIC_VARIANTS[0] }], sessionId: sessionB });
    expect(freshInSameTenant.status).toBe(400);
  });

  it('異なるテナントで同一のsessionId文字列が使われても、abuseカウントは越境しない（本修正の核心）', async () => {
    const sharedSessionIdString = 'sess-shared-across-tenants';

    // テナントAで同じsessionId文字列を使い、異なる話題外発話を3回送って
    // 3回目でセッション終了(403)に到達させる。
    for (let i = 0; i < 2; i++) {
      await request(makeApp('tenant-a'))
        .post('/api/avatar/chat-stream')
        .send({ messages: [{ role: 'user', content: OFF_TOPIC_VARIANTS[i] }], sessionId: sharedSessionIdString });
    }
    const tenantATerminated = await request(makeApp('tenant-a'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: OFF_TOPIC_VARIANTS[2] }], sessionId: sharedSessionIdString });
    expect(tenantATerminated.status).toBe(403);

    // テナントBが「同じsessionId文字列」で初めて話題外発話を送っても、
    // テナントAのabuseカウントを引き継がない(越境DoSにならない)ことを確認する。
    // guardKeyが `${tenantId}:${sessionId}` でスコープされているため独立しているはず。
    const tenantBFirstOffense = await request(makeApp('tenant-b'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: OFF_TOPIC_VARIANTS[0] }], sessionId: sharedSessionIdString });
    expect(tenantBFirstOffense.status).toBe(400);
  });
});
