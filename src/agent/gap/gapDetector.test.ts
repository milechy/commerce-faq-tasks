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

  it('client_admin宛の発行が失敗してもsuper_admin宛は独立して成功する(逆方向も検証)', async () => {
    // notifyFrequentGap は role ごとに個別の try/catch を持つ設計。
    // 片方が reject しても他方の呼び出しが道連れにならないことを確認する。
    mockCreateNotification.mockImplementation(async (params: { recipientRole: string }) => {
      if (params.recipientRole === 'client_admin') throw new Error('client通知DB書き込み失敗');
    });
    mockExistingGapUpdate(42, 5);

    await expect(detectGap(baseInput)).resolves.toEqual(
      expect.objectContaining({ detected: true, gapId: 42 }),
    );
    await flushPromises();

    // client_admin向けは失敗したが、呼び出し自体は行われている
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: 'client_admin' }),
    );
    // super_admin向けは client_admin の失敗に巻き込まれず成功している
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: 'super_admin' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('super_admin宛の発行が失敗してもclient_admin宛は独立して成功する', async () => {
    mockCreateNotification.mockImplementation(async (params: { recipientRole: string }) => {
      if (params.recipientRole === 'super_admin') throw new Error('super通知DB書き込み失敗');
    });
    mockExistingGapUpdate(42, 5);

    await expect(detectGap(baseInput)).resolves.toEqual(
      expect.objectContaining({ detected: true, gapId: 42 }),
    );
    await flushPromises();

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientRole: 'client_admin', recipientTenantId: 'tenant-a' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('同一テナントで異なる2件のgapが同時に頻出閾値を超えても、gapIdごとに通知が混同しない', async () => {
    // 1件目: gapId=42(質問A)がfrequency5到達
    mockExistingGapUpdate(42, 5, '返品ポリシーについて教えてください');
    await detectGap(baseInput);
    await flushPromises();

    // 2件目: gapId=77(質問B、別の会話)が同じテナントでfrequency5到達
    mockExistingGapUpdate(77, 5, '営業時間を教えてください');
    await detectGap({ ...baseInput, sessionId: '22222222-2222-2222-2222-222222222222', userMessage: '営業時間を教えてください' });
    await flushPromises();

    // 合計4件(2 gap × 2 role)、metadata.gapIdが取り違えられていない
    expect(mockCreateNotification).toHaveBeenCalledTimes(4);
    const gap42Calls = mockCreateNotification.mock.calls.filter(
      ([params]) => params.metadata?.gapId === 42,
    );
    const gap77Calls = mockCreateNotification.mock.calls.filter(
      ([params]) => params.metadata?.gapId === 77,
    );
    expect(gap42Calls).toHaveLength(2);
    expect(gap77Calls).toHaveLength(2);
    expect(gap42Calls.every(([p]) => p.message.includes('返品ポリシー'))).toBe(true);
    expect(gap77Calls.every(([p]) => p.message.includes('営業時間'))).toBe(true);
    // 重複抑止キーもgapIdごとに分離している(42_client_adminと77_client_adminが別キー)
    expect(gap42Calls.some(([p]) => p.metadata?.gap_role === '42_client_admin')).toBe(true);
    expect(gap77Calls.some(([p]) => p.metadata?.gap_role === '77_client_admin')).toBe(true);
  });

  it('frequencyが閾値ちょうどでなく一気に100へ飛んでも通知は重複せず1組(2件)のみ作られる', async () => {
    mockExistingGapUpdate(42, 100);

    await detectGap(baseInput);
    await flushPromises();

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const clientCall = mockCreateNotification.mock.calls.find(
      ([p]) => p.recipientRole === 'client_admin',
    );
    expect(clientCall?.[0].message).toContain('100回聞かれています');
  });

  it('【既知の未対応】tenantIdが空文字列の場合、recipientTenantIdは空文字列のままDB層へ渡る(nullに正規化されない)', async () => {
    // notifications.ts の createNotification は `recipientTenantId ?? null` であり、
    // ?? は null/undefined のみを対象とするため空文字列はそのまま通過する。
    // gapDetector 自身にも空文字列を弾くガードは無い(呼び出し元のtruthyチェックに依存)。
    // このテストは「バグを推奨する」ものではなく、現状の挙動を固定して可視化するもの。
    mockExistingGapUpdate(42, 5);

    await detectGap({ ...baseInput, tenantId: '' });
    await flushPromises();

    const clientCall = mockCreateNotification.mock.calls.find(
      ([p]) => p.recipientRole === 'client_admin',
    );
    expect(clientCall?.[0].recipientTenantId).toBe('');
  });
});
