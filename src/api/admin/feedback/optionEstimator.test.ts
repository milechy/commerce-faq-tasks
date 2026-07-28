// src/api/admin/feedback/optionEstimator.test.ts
// GID 1216944003337186: estimateOptionPrice のtrackUsage計測を検証。

const mockTrackUsage = jest.fn();
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { estimateOptionPrice } from './optionEstimator';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const GROQ_OK_BODY = {
  choices: [{ message: { content: JSON.stringify({
    estimated_amount: 8000,
    breakdown: 'アバター画像生成・声設定',
    estimated_hours: 1.5,
  }) } }],
  usage: { prompt_tokens: 200, completion_tokens: 60 },
};

describe('estimateOptionPrice', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.GROQ_API_KEY = 'test-groq-key';
    mockTrackUsage.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('tenantId指定・正常系: trackUsage(admin_option_estimator)を実トークン数で記録する', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_OK_BODY });

    const result = await estimateOptionPrice('アバターのカスタマイズ', { tenantId: 'tenant-a' });

    expect(result.estimated_amount).toBe(8000);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        featureUsed: 'admin_option_estimator',
        inputTokens: 200,
        outputTokens: 60,
      })
    );
  });

  it('tenantId未指定はtrackUsageを呼ばない', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_OK_BODY });

    await estimateOptionPrice('アバターのカスタマイズ');

    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('GROQ_API_KEY未設定はフォールバックを返しtrackUsageを呼ばない', async () => {
    delete process.env.GROQ_API_KEY;

    const result = await estimateOptionPrice('アバターのカスタマイズ', { tenantId: 'tenant-a' });

    expect(result.estimated_amount).toBe(10000); // fallback()
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('Groq APIエラー時はフォールバックを返しtrackUsageを呼ばない', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await estimateOptionPrice('アバターのカスタマイズ', { tenantId: 'tenant-a' });

    expect(result.estimated_amount).toBe(10000);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('tenantContextも同時に渡せる（tenantIdとの併用）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_OK_BODY });

    await estimateOptionPrice('アバターのカスタマイズ', { tenantContext: 'Growthプラン', tenantId: 'tenant-a' });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.messages[1].content).toContain('Growthプラン');
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
  });
});
