// src/agent/report/weeklyReportGenerator.test.ts
// Phase46: 週次レポートジェネレーターのユニットテスト

import {
  generateReportText,
  postReportToSlack,
  saveWeeklyReport,
  WeeklyMetrics,
} from './weeklyReportGenerator';

jest.mock('../llm/groqClient', () => ({
  callGroqWith429Retry: jest.fn().mockResolvedValue('テストレポート文です。'),
}));

const makeMetrics = (overrides: Partial<WeeklyMetrics> = {}): WeeklyMetrics => ({
  avgScore: 75,
  prevAvgScore: 70,
  appointmentRate: 0.3,
  prevAppointmentRate: 0.25,
  variantComparison: [
    { variantId: 'v1', variantName: 'バリアントA', avgScore: 80 },
    { variantId: 'v2', variantName: 'バリアントB', avgScore: 70 },
  ],
  newObjectionPatterns: 3,
  pendingTuningRules: 2,
  ...overrides,
});

const periodStart = new Date('2026-03-16T00:00:00.000Z');
const periodEnd = new Date('2026-03-23T00:00:00.000Z');

describe('generateReportText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('モックデータ → レポート生成: 文字列を返す', async () => {
    const metrics = makeMetrics();
    const result = await generateReportText(metrics, periodStart, periodEnd);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Groqモックが返す値
    expect(result).toBe('テストレポート文です。');
  });

  it('データなし: avgScore=0 のとき「今週は対象会話がありませんでした」を含む', async () => {
    const metrics = makeMetrics({ avgScore: 0 });
    const result = await generateReportText(metrics, periodStart, periodEnd);

    expect(result).toContain('今週は対象会話がありませんでした');
    // データなしの場合はGroqを呼ばない
    const { callGroqWith429Retry } = jest.requireMock('../llm/groqClient');
    expect(callGroqWith429Retry).not.toHaveBeenCalled();
  });
});

describe('postReportToSlack', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('SLACK_WEBHOOK_URL設定時にfetchを呼ぶ', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test/webhook';

    const result = await postReportToSlack('テストレポート', periodStart, periodEnd);

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/test/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const callArgs = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.text).toContain('📊 R2C 週次改善レポート');
    expect(body.text).toContain('テストレポート');
    expect(body.text).toContain('Admin UI > AI改善レポート');
  });

  it('SLACK_WEBHOOK_URL未設定時はfalseを返し、fetchを呼ばない', async () => {
    delete process.env.SLACK_WEBHOOK_URL;

    const result = await postReportToSlack('テストレポート', periodStart, periodEnd);

    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('saveWeeklyReport', () => {
  it('poolのqueryメソッドをモックして、INSERTが呼ばれることを確認', async () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    const mockPool = { query: mockQuery } as any;

    const metrics = makeMetrics();

    await saveWeeklyReport({
      tenantId: 'test-tenant',
      reportText: 'テストレポート',
      periodStart,
      periodEnd,
      metrics,
      slackPosted: true,
      pool: mockPool,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);

    const callArgs = mockQuery.mock.calls[0];
    const sql: string = callArgs[0];
    expect(sql).toContain('INSERT INTO weekly_reports');
    expect(sql).toContain('tenant_id');
    expect(sql).toContain('report_text');
    expect(sql).toContain('period_start');
    expect(sql).toContain('period_end');
    expect(sql).toContain('metrics');
    expect(sql).toContain('slack_posted');

    const params: any[] = callArgs[1];
    expect(params[0]).toBe('test-tenant');
    expect(params[1]).toBe('テストレポート');
    expect(params[4]).toBe(JSON.stringify(metrics));
    expect(params[5]).toBe(true);
  });
});
