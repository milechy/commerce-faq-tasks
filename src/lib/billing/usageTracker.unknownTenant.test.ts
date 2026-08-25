// src/lib/billing/usageTracker.unknownTenant.test.ts
// GID 1217808323836843: /admin/billing のテナント別利用状況に unknown（tenant_id 未解決）
// が溜まり続けていた事故の再発防止テスト。
//
// trackUsage() は tenantId が未解決（'' / 'unknown' / undefined）のまま呼ばれた場合、
// - warn を1回出す（呼び出し元の実装ミスに早期に気づけるように）
// - 例外は投げない（計上の失敗で本番機能を止めない。CLAUDE.md の原則）
// - 正常な tenantId では warn を出さない

import { trackUsage, initUsageTracker } from './usageTracker';

function makeLogger() {
  return { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } as any;
}

// setImmediate を即時実行させ、trackUsage 内部の非同期 DB 記録も含めて待ち切る
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('usageTracker: tenantId 未解決の検知（warnのみ、非throw）', () => {
  // 各テストで trackUsage の setImmediate スケジュール分（非同期DB記録）を使い切ってから
  // 次のテストへ進む。ここで flush しないと、未消化の _insertUsageLog が後続テストの
  // pool（initUsageTracker で差し替わる）に紛れ込み、呼び出し回数のアサーションが汚染される。
  afterEach(async () => {
    await flushSetImmediate();
  });

  it('tenantId="unknown" で trackUsage を呼ぶと warn が1回出る', () => {
    const mockLogger = makeLogger();
    initUsageTracker({ query: jest.fn().mockResolvedValue({ rowCount: 1 }) } as any, mockLogger);

    trackUsage({
      tenantId: 'unknown',
      requestId: 'req-unknown-1',
      model: 'text-embedding-3-small',
      inputTokens: 10,
      outputTokens: 0,
      featureUsed: 'admin_guide',
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-unknown-1',
        featureUsed: 'admin_guide',
        model: 'text-embedding-3-small',
        tenantId: 'unknown',
      }),
      expect.stringContaining('tenantId unresolved'),
    );
  });

  it('tenantId="" (空文字) でも warn が1回出る', () => {
    const mockLogger = makeLogger();
    initUsageTracker({ query: jest.fn().mockResolvedValue({ rowCount: 1 }) } as any, mockLogger);

    trackUsage({
      tenantId: '',
      requestId: 'req-empty-1',
      model: 'fish-audio-s2-pro',
      inputTokens: 0,
      outputTokens: 0,
      featureUsed: 'avatar_config_voice',
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('warn が出ても例外を投げない（本番機能を止めない）', () => {
    const mockLogger = makeLogger();
    initUsageTracker({ query: jest.fn().mockResolvedValue({ rowCount: 1 }) } as any, mockLogger);

    expect(() => {
      trackUsage({
        tenantId: 'unknown',
        requestId: 'req-unknown-2',
        model: 'gemini-2.5-flash',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'admin_tuning',
      });
    }).not.toThrow();
  });

  it('logger が未初期化（pool未初期化前）でも warn 相当の処理で例外を投げない', () => {
    // initUsageTracker を呼ばない = _logger が null の状態を再現
    expect(() => {
      trackUsage({
        tenantId: 'unknown',
        requestId: 'req-no-logger',
        model: 'gemini-2.5-flash',
        inputTokens: 0,
        outputTokens: 0,
        featureUsed: 'admin_tuning',
      });
    }).not.toThrow();
  });

  it('正常な tenantId では warn が出ない', async () => {
    const mockLogger = makeLogger();
    const mockQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
    initUsageTracker({ query: mockQuery } as any, mockLogger);

    trackUsage({
      tenantId: 'carnation',
      requestId: 'req-normal-1',
      model: 'text-embedding-3-small',
      inputTokens: 10,
      outputTokens: 0,
      featureUsed: 'admin_guide',
      billable: false,
    });

    await flushSetImmediate();

    expect(mockLogger.warn).not.toHaveBeenCalled();
    // プラン倍率解決(SELECT plan FROM tenants)+ usage_logs INSERT の計2回
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
