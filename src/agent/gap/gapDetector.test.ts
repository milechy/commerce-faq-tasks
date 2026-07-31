// src/agent/gap/gapDetector.test.ts
// GID:1217040958080651 — 頻出未回答質問(frequency>=5)の通知先を
// client_admin(recipientTenantId付き) + super_admin の2件発行に修正した回帰テスト。
// 通知先の間違いは画面に何も出ないため、このテストが唯一の検知手段。

jest.mock('pino', () => () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../../lib/db', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

const mockCreateNotification = jest.fn().mockResolvedValue(undefined);
const mockNotificationExists = jest.fn().mockResolvedValue(false);
jest.mock('../../lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  notificationExists: (...args: unknown[]) => mockNotificationExists(...args),
}));

import { detectGap } from './gapDetector';

/** notifyFrequentGap は fire-and-forget (void) で呼ばれるため、
 *  detectGap の resolve 後もマイクロタスクが残る。テスト側で明示的にフラッシュする。 */
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

const baseInput = {
  tenantId: 'tenant-a',
  sessionId: '11111111-1111-1111-1111-111111111111',
  userMessage: '返品ポリシーについて教えてください',
  ragResultCount: 0, // no_rag トリガーで確実に upsertGap へ入る
};

function mockExistingGapUpdate(gapId: number, frequency: number, question = baseInput.userMessage) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: gapId }] }) // 既存gap検索
    .mockResolvedValueOnce({ rows: [{ frequency, user_question: question }] }); // UPDATE
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCreateNotification.mockReset().mockResolvedValue(undefined);
  mockNotificationExists.mockReset().mockResolvedValue(false);
});

describe('gapDetector — frequency>=5 の通知先', () => {
  it('frequency5到達でclient_admin宛通知がrecipientTenantId付きで作られる', async () => {
    mockExistingGapUpdate(42, 5);

    const result = await detectGap(baseInput);
    await flushPromises();

    expect(result.detected).toBe(true);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: 'client_admin',
        recipientTenantId: 'tenant-a',
        type: 'knowledge_gap_frequent',
        link: '/admin/knowledge-gaps',
        metadata: expect.objectContaining({ gapId: 42 }),
      }),
    );
  });

  it('同時にsuper_admin宛も作られる', async () => {
    mockExistingGapUpdate(42, 5);

    await detectGap(baseInput);
    await flushPromises();

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: 'super_admin',
        type: 'knowledge_gap_frequent',
        link: '/admin/knowledge-gaps',
        metadata: expect.objectContaining({ gapId: 42 }),
      }),
    );
    // super_admin 宛には recipientTenantId を付けない
    const superAdminCall = mockCreateNotification.mock.calls.find(
      ([params]) => params.recipientRole === 'super_admin',
    );
    expect(superAdminCall?.[0].recipientTenantId).toBeUndefined();

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('frequency5未満では通知が作られない', async () => {
    mockExistingGapUpdate(42, 4);

    await detectGap(baseInput);
    await flushPromises();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('6回目・7回目でclient_admin宛が重複しない', async () => {
    // 1回目(freq=6)の通知は既に存在する想定
    mockNotificationExists.mockImplementation(async (_type, _key, value: string) =>
      value === '42_client_admin',
    );
    mockExistingGapUpdate(42, 6);

    await detectGap(baseInput);
    await flushPromises();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: 'super_admin' }),
    );
  });

  it('6回目・7回目でsuper_admin宛が重複しない(片方だけ抑止が効いて他方が毎回増える状態にならない)', async () => {
    // super_admin 宛は既に存在する想定。client_admin 宛は未通知のため作られるべき
    mockNotificationExists.mockImplementation(async (_type, _key, value: string) =>
      value === '42_super_admin',
    );
    mockExistingGapUpdate(42, 7);

    await detectGap(baseInput);
    await flushPromises();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: 'client_admin', recipientTenantId: 'tenant-a' }),
    );
  });

  it('createNotificationが失敗してもgap検出自体は成功する(throwしない)', async () => {
    mockCreateNotification.mockRejectedValue(new Error('insert failed'));
    mockExistingGapUpdate(42, 5);

    await expect(detectGap(baseInput)).resolves.toEqual(
      expect.objectContaining({ detected: true, gapId: 42 }),
    );
    // 失敗した通知呼び出し由来の unhandled rejection が漏れていないことも確認
    await flushPromises();
  });

  it('他テナントのgapが混ざらない(tenantIdがクエリパラメータに正しく渡る)', async () => {
    mockExistingGapUpdate(99, 5);

    await detectGap({ ...baseInput, tenantId: 'tenant-b' });
    await flushPromises();

    // 既存gap検索のSQLパラメータにtenant-bが渡っている(他テナントの行を拾わない)
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['tenant-b']),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: 'client_admin', recipientTenantId: 'tenant-b' }),
    );
  });
});
