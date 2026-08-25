// src/agent/gap/gapDetectorTriggers.test.ts
//
// ナレッジ配線是正 P13 (Asana GID 1217811237462903):
// 4トリガー(no_rag / low_confidence / fallback / judge_low)それぞれに
// 発火する実例が無く、synthesisTool.ts の呼び出し元が
// `_topScore > 0 ? _topScore : undefined` としていたため、ヒットは
// あるが実スコアがちょうど0.0のケースで low_confidence が判定されず
// 4トリガー全てをすり抜けていた(0.0 は falsy ではないが `> 0` は false)。

jest.mock('pino', () => () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../../lib/db', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock('../../lib/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  notificationExists: jest.fn().mockResolvedValue(false),
}));

import { detectGap } from './gapDetector';

const TENANT = 'tenant-a';
const SESSION = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockQuery.mockReset();
  // 新規gap: 既存検索は0件 → INSERT
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // 既存gap検索(見つからない)
    .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT RETURNING id
});

describe('detectGap — 4トリガーそれぞれの発火', () => {
  it('no_rag: ragResultCount=0 で発火する', async () => {
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問A',
      ragResultCount: 0,
    });
    expect(result.detected).toBe(true);
    expect(result.source).toBe('no_rag');
  });

  it('low_confidence: ヒットありでも topRerankScore が閾値未満なら発火する', async () => {
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問B',
      ragResultCount: 2,
      topRerankScore: 0.1,
    });
    expect(result.detected).toBe(true);
    expect(result.source).toBe('low_confidence');
  });

  it('回帰(是正対象のバグ): topRerankScore がちょうど0.0でも low_confidence が発火する', async () => {
    // 是正前は synthesisTool.ts 側で `_topScore > 0 ? _topScore : undefined` と
    // なっており、この 0.0 が undefined に化けて全トリガーをすり抜けていた。
    // detectGap 自体はスコアをそのまま受け取れば正しく判定できることを固定する。
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問C',
      ragResultCount: 3,
      topRerankScore: 0.0,
    });
    expect(result.detected).toBe(true);
    expect(result.source).toBe('low_confidence');
  });

  it('fallback: templateSource=fallback で発火する(ヒット・スコアとも十分でも)', async () => {
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問D',
      ragResultCount: 5,
      topRerankScore: 0.9,
      templateSource: 'fallback',
    });
    expect(result.detected).toBe(true);
    expect(result.source).toBe('fallback');
  });

  it('judge_low: judgeScore が閾値未満なら発火する', async () => {
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問E',
      ragResultCount: 5,
      topRerankScore: 0.9,
      judgeScore: 30,
    });
    expect(result.detected).toBe(true);
    expect(result.source).toBe('judge_low');
  });

  it('回帰: ヒット十分・スコア十分・templateSource/judgeScoreも無しなら発火しない', async () => {
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問F',
      ragResultCount: 5,
      topRerankScore: 0.9,
    });
    expect(result.detected).toBe(false);
    expect(result.source).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('優先順位: no_rag が low_confidence/fallback/judge_low より先に判定される', async () => {
    const result = await detectGap({
      tenantId: TENANT,
      sessionId: SESSION,
      userMessage: '質問G',
      ragResultCount: 0,
      topRerankScore: 0.9, // 高スコアでもno_ragが優先
      templateSource: 'fallback',
      judgeScore: 90,
    });
    expect(result.source).toBe('no_rag');
  });
});
