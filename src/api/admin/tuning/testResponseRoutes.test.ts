// src/api/admin/tuning/testResponseRoutes.test.ts
// GID 1216944003337186: generateTestResponses（tuning-rules test-response生成、
// ルートとactionExecutor.tsの両方から呼ばれる共通ロジック）のtrackUsage計測を検証。

const mockPoolQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockPoolQuery }),
}));

const mockTrackUsage = jest.fn();
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { generateTestResponses } from './testResponseRoutes';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('generateTestResponses', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.GROQ_API_KEY = 'test-groq-key';
    mockPoolQuery.mockReset();
    mockTrackUsage.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  const RULE_ROW = { trigger_pattern: '価格について', expected_behavior: '料金プランを案内する', tenant_id: 'tenant-a' };
  const TENANT_ROW = { system_prompt: 'あなたは丁寧な接客AIです' };
  const GROQ_OK_BODY = {
    choices: [{ message: { content: JSON.stringify([
      { style: '丁寧版', text: 'こちらです' },
      { style: '簡潔版', text: 'こちら' },
      { style: '提案型', text: 'いかがですか' },
    ]) } }],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
  };

  it('正常系: trackUsage(admin_tuning)を実トークン数で1回記録する', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RULE_ROW] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW] });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_OK_BODY });

    const result = await generateTestResponses(1, 'tenant-a', false);

    expect(result.ok).toBe(true);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        featureUsed: 'admin_tuning',
        inputTokens: 120,
        outputTokens: 80,
      })
    );
  });

  it('ルールが見つからない場合はtrackUsageを呼ばない', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await generateTestResponses(999, 'tenant-a', false);

    expect(result.ok).toBe(false);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('テナント越境（forbidden）はGroqを呼ばずtrackUsageも呼ばない', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [RULE_ROW] });

    const result = await generateTestResponses(1, 'other-tenant', false);

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('GROQ_API_KEY未設定はtrackUsageを呼ばない', async () => {
    delete process.env.GROQ_API_KEY;
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RULE_ROW] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW] });

    const result = await generateTestResponses(1, 'tenant-a', false);

    expect(result).toEqual({ ok: false, reason: 'no_api_key' });
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('Groq APIエラー時はtrackUsageを呼ばない（失敗した呼び出しを課金しない）', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RULE_ROW] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW] });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await generateTestResponses(1, 'tenant-a', false);

    expect(result).toEqual({ ok: false, reason: 'llm_error' });
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('LLM出力がJSON配列でない場合でも、Groq呼び出し自体は成功しているのでtrackUsageは記録する', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RULE_ROW] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW] });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '不正な出力' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }),
    });

    const result = await generateTestResponses(1, 'tenant-a', false);

    expect(result).toEqual({ ok: false, reason: 'invalid_output' });
    // Groq呼び出し自体には実コストが発生しているため計測する
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
  });
});
