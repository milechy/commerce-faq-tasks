// src/api/conversion/autoTuning.test.ts
// A2A-0g: runAutoTuningCheck が未 export で呼び出し元ゼロだったため、
// auto_tuning_suggestion 通知(ab_winnerの🏆バッジ含む)が一度も生成されて
// いなかった。ここでは export された runAutoTuningCheck / runAutoTuningSweep が
// (1) 既存の notificationExists による重複通知防止を守ること、
// (2) admin-ui(conversion/index.tsx)がポーリングする type/recipientRole と
//     一致した通知を作ること、
// (3) 稼働中テナントを巡回すること
// を固定する。

const mockQuery = jest.fn();
jest.mock('../../lib/db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const mockCreateNotification = jest.fn().mockResolvedValue(undefined);
const mockNotificationExists = jest.fn().mockResolvedValue(false);
jest.mock('../../lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  notificationExists: (...args: unknown[]) => mockNotificationExists(...args),
}));

import { runAutoTuningCheck, runAutoTuningSweep } from './autoTuning';

const AB_WINNER_ROW = {
  id: 'exp-1',
  name: 'CTA文言テスト',
  count_a: '20',
  conv_a: '10',
  count_b: '20',
  conv_b: '2',
};

function mockPoolFor(tenantsRows: Array<{ id: string }>, abRows: Array<Record<string, unknown>>) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM tenants')) {
      return Promise.resolve({ rows: tenantsRows });
    }
    if (sql.includes('FROM ab_experiments')) {
      return Promise.resolve({ rows: abRows });
    }
    // judge_repeated / effectiveness_top クエリ等は候補なしとして扱う
    return Promise.resolve({ rows: [] });
  });
}

describe('runAutoTuningCheck', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateNotification.mockClear();
    mockNotificationExists.mockClear();
  });

  it('A/B勝者候補があれば admin-ui が待ち受ける type/recipientRole で通知を作る', async () => {
    mockPoolFor([], [AB_WINNER_ROW]);

    await runAutoTuningCheck('tenant-1');

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const [payload] = mockCreateNotification.mock.calls[0];
    // conversion/index.tsx は type=auto_tuning_suggestion をポーリングし、
    // metadata.candidate_type==='ab_winner' でトロフィーバッジを描画する。
    expect(payload.type).toBe('auto_tuning_suggestion');
    expect(payload.recipientRole).toBe('client_admin');
    expect(payload.recipientTenantId).toBe('tenant-1');
    expect(payload.metadata.candidate_type).toBe('ab_winner');
  });

  it('既存パターン(notificationExists)で重複通知を作らない', async () => {
    mockPoolFor([], [AB_WINNER_ROW]);
    mockNotificationExists.mockResolvedValueOnce(true);

    await runAutoTuningCheck('tenant-1');

    expect(mockNotificationExists).toHaveBeenCalledWith(
      'auto_tuning_suggestion',
      'dedup_key',
      expect.any(String),
    );
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('候補が無ければ notificationExists/createNotification を呼ばない', async () => {
    mockPoolFor([], []);

    await runAutoTuningCheck('tenant-1');

    expect(mockNotificationExists).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('runAutoTuningSweep', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateNotification.mockClear();
    mockNotificationExists.mockClear();
  });

  it('is_active=true のテナントを巡回して各テナントに対し判定する', async () => {
    mockPoolFor([{ id: 'tenant-1' }, { id: 'tenant-2' }], [AB_WINNER_ROW]);

    await runAutoTuningSweep();

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('is_active = true'));
    // 2テナント x 1候補 = createNotification 2回
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification.mock.calls.map((c) => c[0].recipientTenantId).sort()).toEqual([
      'tenant-1',
      'tenant-2',
    ]);
  });

  it('対象テナントが無ければ何も通知しない', async () => {
    mockPoolFor([], []);

    await runAutoTuningSweep();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
