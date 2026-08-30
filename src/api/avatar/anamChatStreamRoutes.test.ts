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

// E5: この経路は RAG を介さないため本番では既定で封鎖されている。以下のテスト群は
// 「有効化した場合の中身」を検証するものなので、明示的にフラグを立てて実行する。
// 封鎖そのものの検証は describe('E5: RAGを介さない回答経路の封鎖') 側で行う。
beforeEach(() => {
  process.env.ANAM_CHAT_STREAM_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.ANAM_CHAT_STREAM_ENABLED;
});

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
      model: 'openai/gpt-oss-120b',
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

describe('POST /api/avatar/chat-stream — gpt-oss の reasoning_effort', () => {
  // 2026-08-23: gpt-oss は推論トークンを max_tokens から消費する。この指定が無いと
  // max_tokens=150 のうち 136 を推論が食い、本文が1バイトも出ないまま
  // HTTP 200 / size=0 で返る（本番でアバターチャットが無言停止した実際の症状）。
  it('Groqへ送るボディに reasoning_effort=low が入る', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(makeGroqStreamResponse(['はい']));

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '営業時間は' }], sessionId: 'sess-re-1' });

    expect(res.status).toBe(200);
    const fetchMock = global.fetch as jest.Mock;
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sentBody.reasoning_effort).toBe('low');
    // 既存パラメータを壊していないこと
    expect(sentBody.model).toBe('openai/gpt-oss-120b');
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(sentBody.max_tokens).toBe(150);
    expect(sentBody.temperature).toBe(0.7);
  });

  it('404で退避した2回目のリクエストにも reasoning_effort が付く（退避先も gpt-oss のため）', async () => {
    const notFound = {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { code: 'model_not_found' } }),
    };
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce(notFound as any)
      .mockResolvedValueOnce(makeGroqStreamResponse(['はい']) as any);

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '営業時間は' }], sessionId: 'sess-re-2' });

    expect(res.status).toBe(200);
    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(first.model).toBe('openai/gpt-oss-120b');
    expect(second.model).toBe('openai/gpt-oss-20b'); // フォールバックチェーンの退避先
    // 退避後に設定が抜け落ちると、退避先で同じ無言停止が起きる
    expect(first.reasoning_effort).toBe('low');
    expect(second.reasoning_effort).toBe('low');
  });
});

describe('E5: RAGを介さない回答経路の封鎖', () => {
  // この経路は本体API /api/chat と違い RAG(FAQ/pgvector/learned_memory/tuning_rules)を
  // 通さないため、有効化すると顧客に知識ゼロの回答が出る。既定は封鎖。
  beforeEach(() => {
    delete process.env.ANAM_CHAT_STREAM_ENABLED;
  });

  it('フラグ未設定なら 503 を返し、Groq を呼ばない', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const res = await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '営業時間は' }], sessionId: 'sess-blocked' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('anam_chat_stream_disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('封鎖時は会話ログを保存せず、課金も計上しない', async () => {
    global.fetch = jest.fn() as any;
    mockSaveMessage.mockClear();
    mockTrackUsage.mockClear();

    await request(makeApp())
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '営業時間は' }], sessionId: 'sess-blocked-2' });

    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("'true' 以外の値では有効にならない（1 / yes / TRUE を有効と誤読しない）", async () => {
    for (const value of ['1', 'yes', 'TRUE', 'True', '']) {
      process.env.ANAM_CHAT_STREAM_ENABLED = value;
      const res = await request(makeApp())
        .post('/api/avatar/chat-stream')
        .send({ messages: [{ role: 'user', content: 'x' }], sessionId: 'sess-flag' });
      expect(res.status).toBe(503);
    }
  });

  it('未認証(401)の判定は封鎖より先に行われる', async () => {
    const res = await request(makeApp(null))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'x' }] });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/avatar/chat-stream — L8 出力ガード(guardOutput: PII/システムプロンプト片/過長RAG抜粋)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.GROQ_API_KEY = 'test-groq-key';
  });

  /** ストリーム応答(改行区切りJSON)の content フィールドを結合して返す。 */
  function collectStreamContent(body: string): string {
    return body
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { content?: string; error?: string })
      .map((o) => o.content ?? '')
      .join('');
  }

  it('チャンク境界で分割されたPII(電話番号)も、全文再ガードによりマスクされる', async () => {
    process.env.OUTPUT_GUARD_ENABLED = 'true';
    // 電話番号がGroqのdeltaチャンク境界で割れて届くケース。
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(makeGroqStreamResponse(['お電話は ', '03-1234', '-5678', ' までどうぞ。']));

    const res = await request(makeApp('carnation', 'req-pii'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '電話番号は' }], sessionId: 'sess-pii' });

    expect(res.status).toBe(200);
    const streamed = collectStreamContent(res.text);
    expect(streamed).not.toContain('03-1234-5678');
    expect(streamed).toContain('[個人情報のため非表示]');

    // 保存されるassistant本文もマスク済み(漏洩をログにも残さない)。
    const assistantSave = mockSaveMessage.mock.calls.find((c) => c[0].role === 'assistant');
    expect(assistantSave![0].content).not.toContain('03-1234-5678');
    expect(assistantSave![0].content).toContain('[個人情報のため非表示]');
  });

  it('システムプロンプト片(スニペット)が応答に混入するとマスクされる', async () => {
    process.env.OUTPUT_GUARD_ENABLED = 'true';
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(
        makeGroqStreamResponse(['内部実装では ', 'ragExcerpt.slice(0, 200)', ' を使います。']),
      );

    const res = await request(makeApp('carnation', 'req-snippet'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '仕組みを教えて' }], sessionId: 'sess-snippet' });

    expect(res.status).toBe(200);
    const streamed = collectStreamContent(res.text);
    expect(streamed).not.toContain('ragExcerpt.slice(0, 200)');
    expect(streamed).toContain('[内部情報が検出されたため非表示]');
  });

  it('過長なRAG抜粋(区切り無しの長い塊)は上限で切り詰められる', async () => {
    process.env.OUTPUT_GUARD_ENABLED = 'true';
    process.env.MAX_RAG_EXCERPT_LENGTH = '20';
    // 句読点・改行を含まない50文字の塊 → 20文字 + '...' に切り詰められる。
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(makeGroqStreamResponse(['あ'.repeat(50)]));

    const res = await request(makeApp('carnation', 'req-rag'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '詳しく' }], sessionId: 'sess-rag' });

    expect(res.status).toBe(200);
    const streamed = collectStreamContent(res.text);
    expect(streamed).toBe('あ'.repeat(20) + '...');
  });

  it('正常な応答はガードで書き換わらず素通りする(結合後に元の全文と一致)', async () => {
    process.env.OUTPUT_GUARD_ENABLED = 'true';
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(
        makeGroqStreamResponse(['こんにちは、', '本日はどのような', 'ご用件でしょうか。']),
      );

    const res = await request(makeApp('carnation', 'req-normal'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: 'こんにちは' }], sessionId: 'sess-normal' });

    expect(res.status).toBe(200);
    const streamed = collectStreamContent(res.text);
    expect(streamed).toBe('こんにちは、本日はどのようなご用件でしょうか。');

    const assistantSave = mockSaveMessage.mock.calls.find((c) => c[0].role === 'assistant');
    expect(assistantSave![0].content).toBe('こんにちは、本日はどのようなご用件でしょうか。');
  });

  it('OUTPUT_GUARD_ENABLED未設定でも、本番相当(NODE_ENV=production)では既定ONでPIIがマスクされる(顧客chatと同じfail-safe)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OUTPUT_GUARD_ENABLED;
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(makeGroqStreamResponse(['ご連絡先は ', '03-9876-5432', ' です。']));

    const res = await request(makeApp('carnation', 'req-failsafe'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '連絡先を教えてください' }], sessionId: 'sess-failsafe' });

    expect(res.status).toBe(200);
    const streamed = collectStreamContent(res.text);
    expect(streamed).not.toContain('03-9876-5432');
    expect(streamed).toContain('[個人情報のため非表示]');
  });

  it('社内用語(redactInternalTerms)はguardOutputフラグに関係なく常に伏せられる', async () => {
    // OUTPUT_GUARD_ENABLED は既定OFF(NODE_ENV=test)のまま。それでも社内用語は伏せる。
    delete process.env.OUTPUT_GUARD_ENABLED;
    (global as any).fetch = jest
      .fn()
      .mockResolvedValue(makeGroqStreamResponse(['これは ', 'RAJIUCEの法則', ' に基づきます。']));

    const res = await request(makeApp('carnation', 'req-internal'))
      .post('/api/avatar/chat-stream')
      .send({ messages: [{ role: 'user', content: '根拠は' }], sessionId: 'sess-internal' });

    expect(res.status).toBe(200);
    const streamed = collectStreamContent(res.text);
    expect(streamed).not.toContain('RAJIUCE');
    expect(streamed).toContain('独自の考え方');
  });
});
