// src/api/admin/agent/engagementSuggest.test.ts
// GID 1216944003337186: suggestEngagementRuleFromText のtrackUsage計測を検証。

const mockTrackUsage = jest.fn();
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

import { suggestEngagementRuleFromText } from './engagementSuggest';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const GROQ_OK_BODY = {
  choices: [{ message: { content: JSON.stringify({
    trigger_type: 'exit_intent',
    trigger_config: {},
    message_template: 'お待ちください！',
    priority: 50,
    reason: '離脱防止のため',
  }) } }],
  usage: { prompt_tokens: 90, completion_tokens: 40 },
};

describe('suggestEngagementRuleFromText', () => {
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

  it('tenantId指定・正常系: trackUsage(admin_engagement_suggest)を実トークン数で記録する', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_OK_BODY });

    const result = await suggestEngagementRuleFromText('離脱しそうな人に声をかけたい', 'tenant-a');

    expect(result.message_template).toBe('お待ちください！');
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        featureUsed: 'admin_engagement_suggest',
        inputTokens: 90,
        outputTokens: 40,
      })
    );
  });

  it('tenantId未指定はtrackUsageを呼ばない（原価を誰にも帰属できないため）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => GROQ_OK_BODY });

    await suggestEngagementRuleFromText('離脱しそうな人に声をかけたい');

    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('GROQ_API_KEY未設定はtrackUsageを呼ばない', async () => {
    delete process.env.GROQ_API_KEY;

    const result = await suggestEngagementRuleFromText('声がけしたい', 'tenant-a');

    expect(result.message_template).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it('Groq APIエラー時はtrackUsageを呼ばない', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await suggestEngagementRuleFromText('声がけしたい', 'tenant-a');

    expect(result.message_template).toBe('');
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
