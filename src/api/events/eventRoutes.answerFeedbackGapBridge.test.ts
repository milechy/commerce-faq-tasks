// src/api/events/eventRoutes.answerFeedbackGapBridge.test.ts
// ナレッジ配線是正 P14 (Asana): answer_feedback(👎) → knowledge_gaps ブリッジの
// ユニットテスト。
//
// 是正4-2(GID 1218086286324510)以降: message_ref が /api/chat の返す実
// chat_messages.id(数字文字列)であれば、その回答に対応する直前のuser発話を
// 厳密に対応付ける。message_ref が非数字(旧クライアントの乱数ID等)、または
// 実IDで解決できない場合のみ、近似として「セッション内最新の実ユーザー発話」を
// 対象質問にフォールバックする(bridgeAnswerFeedbackToGaps 実装コメント参照)。

import { bridgeAnswerFeedbackToGaps, resolveChatSessionUuid } from './eventRoutes';

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
import { logger } from '../../lib/logger';

const mockDetectGap = jest.fn();
jest.mock('../../agent/gap/gapDetector', () => ({
  detectGap: (...args: unknown[]) => mockDetectGap(...args),
}));

// resolveChatSessionUuid は同ファイルからexportされる実装をそのまま使うため、
// DBクエリレベルでモックする(bridgeConversionEvents.test.tsと同じ方針)。
const mockQuery = jest.fn();
const mockDb = { query: mockQuery } as any;

beforeEach(() => {
  mockQuery.mockReset();
  mockDetectGap.mockReset().mockResolvedValue({ detected: true, source: 'user_negative', gapId: 1 });
  (logger.warn as jest.Mock).mockClear();
});

describe('bridgeAnswerFeedbackToGaps', () => {
  it('down評価が無ければDBに一切問い合わせない', async () => {
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'up', message_ref: 'm1' } },
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockDetectGap).not.toHaveBeenCalled();
  });

  it('down評価かつセッション解決・直近ユーザー発話取得ができればdetectGapをuserNegativeFeedback=trueで呼ぶ', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] }) // resolveChatSessionUuid
      .mockResolvedValueOnce({ rows: [{ content: '返品したいのですが' }] }); // chat_messages 直近ユーザー発話
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
    ]);
    expect(mockDetectGap).toHaveBeenCalledTimes(1);
    expect(mockDetectGap).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        sessionId: 'session-uuid-1',
        userMessage: '返品したいのですが',
        userNegativeFeedback: true,
      }),
    );
  });

  it('セッションが解決できなければdetectGapを呼ばない(質問内容を特定できないため)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // chat_session_id不一致、visitor_id未指定
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-unknown' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
    ]);
    expect(mockDetectGap).not.toHaveBeenCalled();
  });

  it('セッションは解決できても直近ユーザー発話が無ければdetectGapを呼ばない', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockResolvedValueOnce({ rows: [] }); // chat_messagesに実ユーザー発話なし
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
    ]);
    expect(mockDetectGap).not.toHaveBeenCalled();
  });

  it('壊れやすいポイント: 直近ユーザー発話が空白のみ(スペース/改行)のときもdetectGapを呼ばない(無意味なギャップ起票を防ぐ)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockResolvedValueOnce({ rows: [{ content: '   \n\t  ' }] });
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
    ]);
    expect(mockDetectGap).not.toHaveBeenCalled();
  });

  it('1バッチに複数のdown評価があっても、同一質問でdetectGapがその件数分呼ばれる(重複起票はupsertGap側の7日ILIKE一致で吸収)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockResolvedValueOnce({ rows: [{ content: '在庫はありますか' }] });
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm2' } },
    ]);
    expect(mockDetectGap).toHaveBeenCalledTimes(2);
  });

  it('session解決が例外を投げてもスローせずbest-effortで終わる', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));
    await expect(
      bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
        { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
      ]),
    ).resolves.toBeUndefined();
    expect(mockDetectGap).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→gap bridge] session resolve failed' }),
    );
  });

  it('chat_messages問い合わせが例外を投げてもスローせずbest-effortで終わる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockRejectedValueOnce(new Error('DB connection lost'));
    await expect(
      bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
        { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
      ]),
    ).resolves.toBeUndefined();
    expect(mockDetectGap).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→gap bridge] message lookup failed' }),
    );
  });

  it('message_refが実ID(数字)で解決できれば、その回答直前のuser発話を厳密に使う(近似の"直近発話"クエリは呼ばない)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] }) // resolveChatSessionUuid
      .mockResolvedValueOnce({ rows: [{ content: '古い質問(実際に対応する発話)' }] }); // 実IDでの厳密解決
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: '4242' } },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(2); // 近似クエリは呼ばれていない
    expect(mockDetectGap).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: '古い質問(実際に対応する発話)',
        userNegativeFeedback: true,
      }),
    );
  });

  it('message_refが実IDの形でも対応するassistantメッセージが無ければ、近似(直近のuser発話)にフォールバックする', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] }) // resolveChatSessionUuid
      .mockResolvedValueOnce({ rows: [] }) // 実ID解決: 該当なし
      .mockResolvedValueOnce({ rows: [{ content: '近似で拾われた質問' }] }); // 近似フォールバック
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: '9999' } },
    ]);
    expect(mockDetectGap).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: '近似で拾われた質問' }),
    );
  });

  it('旧クライアント(乱数ID等、数字でないmessage_ref)は実ID解決を試みず、従来通り近似のみで動く(500にならない)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockResolvedValueOnce({ rows: [{ content: '近似で拾われた質問(旧クライアント)' }] });
    await expect(
      bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
        { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'msg-1700000000000-ab12cd' } },
      ]),
    ).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(2); // セッション解決 + 近似のみ(実ID解決クエリは発行しない)
    expect(mockDetectGap).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: '近似で拾われた質問(旧クライアント)' }),
    );
  });

  it('1バッチ内で複数のdown評価が異なるmessage_refを持つ場合、近似クエリは1回だけ発行して使い回す', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] }) // resolveChatSessionUuid
      .mockResolvedValueOnce({ rows: [{ content: '近似の質問' }] }); // 近似(1回のみ)
    await bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'msg-a' } },
      { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'msg-b' } },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(2); // セッション解決 + 近似(1回、使い回し)
    expect(mockDetectGap).toHaveBeenCalledTimes(2);
  });

  it('実ID解決クエリが例外を投げても、近似にフォールバックしてbest-effortで続行する', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockRejectedValueOnce(new Error('DB connection lost')) // 実ID解決が失敗
      .mockResolvedValueOnce({ rows: [{ content: '近似の質問(実ID解決失敗後)' }] }); // 近似
    await expect(
      bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
        { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: '123' } },
      ]),
    ).resolves.toBeUndefined();
    expect(mockDetectGap).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: '近似の質問(実ID解決失敗後)' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→gap bridge] message lookup failed' }),
    );
  });

  it('detectGapが例外を投げてもスローせずbest-effortで終わる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'session-uuid-1' }] })
      .mockResolvedValueOnce({ rows: [{ content: 'ご質問' }] });
    mockDetectGap.mockRejectedValueOnce(new Error('detectGap boom'));
    await expect(
      bridgeAnswerFeedbackToGaps(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
        { event_type: 'answer_feedback', event_data: { rating: 'down', message_ref: 'm1' } },
      ]),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→gap bridge] detectGap failed' }),
    );
  });
});

// resolveChatSessionUuidの再利用自体は eventRoutes.conversionBridge.test.ts で
// 既にカバー済みのため、ここではimportして型の整合のみ確認する。
describe('bridgeAnswerFeedbackToGaps — resolveChatSessionUuidを再利用している', () => {
  it('関数がexportされている', () => {
    expect(typeof resolveChatSessionUuid).toBe('function');
  });
});
