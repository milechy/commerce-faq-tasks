// src/api/events/eventRoutes.answerFeedbackGapBridge.test.ts
// ナレッジ配線是正 P14 (Asana): answer_feedback(👎) → knowledge_gaps ブリッジの
// ユニットテスト。message_ref はクライアント側乱数IDで chat_messages と直接
// ひも付かないため、近似として「セッション内最新の実ユーザー発話」を対象質問に
// している点(bridgeAnswerFeedbackToGaps 実装コメント参照)の挙動を固定する。

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
