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

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runAutoTuningCheck, runAutoTuningSweep, autoTuningMonitor } from './autoTuning';
import { logger } from '../../lib/logger';

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

  it('テナント一覧取得(listActiveTenantIds)自体が失敗しても例外を投げずに終える。ログに残す', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants')) return Promise.reject(new Error('connection terminated'));
      return Promise.resolve({ rows: [] });
    });

    await expect(runAutoTuningSweep()).resolves.toBeUndefined();

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('1テナントの通知作成が例外を投げても、残りのテナントの処理は続き、失敗はログに残る(握り潰さない)', async () => {
    mockPoolFor([{ id: 'broken' }, { id: 'ok' }], [AB_WINNER_ROW]);
    // 1件目(broken)の createNotification だけ失敗させる。以降の呼び出しはモジュール既定の
    // mockResolvedValue(undefined) に戻る(afterEachでの復元を要しない)。
    mockCreateNotification.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));

    await runAutoTuningSweep();

    expect(mockCreateNotification.mock.calls.map((c) => (c[0] as { recipientTenantId?: string }).recipientTenantId)).toEqual(
      ['broken', 'ok'],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'broken' }),
      expect.stringContaining('failed for tenant'),
    );
  });
});

describe('detectABWinners の境界値', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateNotification.mockClear();
    mockNotificationExists.mockClear();
  });

  it('引き分け(rateA === rateB)のときは勝者を通知しない(差 > 0.05 の境界)', async () => {
    mockPoolFor([], [{ ...AB_WINNER_ROW, conv_a: '10', count_a: '20', conv_b: '10', count_b: '20' }]);

    await runAutoTuningCheck('tenant-1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('母数0件(count_a=0, count_b=0)でも0除算でNaN化せず、通知しない', async () => {
    mockPoolFor([], [{ ...AB_WINNER_ROW, conv_a: '0', count_a: '0', conv_b: '0', count_b: '0' }]);

    await runAutoTuningCheck('tenant-1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ★既知の欠陥(未修正・報告のみ): notificationExists による重複排除は
// type + description(文字列)の完全一致で行っている(runAutoTuningCheck 内)。
// judge_repeated / effectiveness_top の description には件数(cnt/total)が
// そのまま埋め込まれるため、同じ提案が継続しているだけで件数が増える(3回→4回、
// 5回→6回)と別物と判定され、同じ提案に対して毎回新しい通知が出てしまう。
// このテストは「あるべき挙動」ではなく現状の挙動を記録するもの。dedupキーを
// principle/rule 等の安定値にする是正は別タスクとして報告する(このタスクでは直さない)。
// ---------------------------------------------------------------------------
describe('通知の重複排除キー(description文字列)の弱点', () => {
  function mockPoolForPrinciple(rows: Array<Record<string, unknown>>) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM conversion_attributions')) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateNotification.mockClear();
  });

  it('★欠陥: 同じ心理原則でもCV件数が増えて説明文の数字が変わるだけで、別物として重複通知が出る', async () => {
    // notificationExists の実装(src/lib/notifications.ts)は description の完全一致で
    // 過去の通知を検索する。ここではその挙動を「一度見た description は既存扱いにする」
    // 集合で模す(単純に false 固定するより実挙動に近い)。
    const seenDescriptions = new Set<string>();
    mockNotificationExists.mockImplementation((_type: string, _key: string, description: string) => {
      const exists = seenDescriptions.has(description);
      seenDescriptions.add(description);
      return Promise.resolve(exists);
    });

    mockPoolForPrinciple([{ principle: '返報性', total: '5', avg_temp: '42' }]);
    await runAutoTuningCheck('tenant-1'); // 1回目: 5回のCV

    mockPoolForPrinciple([{ principle: '返報性', total: '6', avg_temp: '42' }]);
    await runAutoTuningCheck('tenant-1'); // 2回目: 同じ原則が6回目のCVに達しただけ

    // 本来は「継続的に効いている同じ提案」として2件目は抑止されてほしいが、
    // description に total 件数が入っているため notificationExists は別物と判定し、
    // 2件とも通知される。
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });
});

describe('autoTuningMonitor(定期実行ラッパー)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateNotification.mockClear();
    mockNotificationExists.mockClear();
    mockPoolFor([], []); // タイマー系テストはsweepの中身ではなくスケジューラ挙動を見るため空巡回にする
    jest.useFakeTimers();
  });

  afterEach(() => {
    autoTuningMonitor.stop();
    jest.useRealTimers();
  });

  // ★禁止30: 費用が発生する定期処理を多重起動しうる形で登録しない★
  it('start() を2回呼んでもタイマーは1本だけ登録される(二重起動防止)', () => {
    autoTuningMonitor.start();
    autoTuningMonitor.start();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('起動直後に1回実行される(次の周期を待たない)', async () => {
    autoTuningMonitor.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('1時間ごとに再実行される', async () => {
    autoTuningMonitor.start();
    await jest.advanceTimersByTimeAsync(0);
    const callsAfterStart = mockQuery.mock.calls.length;

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockQuery.mock.calls.length).toBeGreaterThan(callsAfterStart);
  });

  it('stop() 後はタイマーが残らない(テストプロセスのリーク防止)', () => {
    autoTuningMonitor.start();
    autoTuningMonitor.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stop() の後に start() すると1本だけタイマーが再登録され、初回tickも再実行される', async () => {
    autoTuningMonitor.start();
    autoTuningMonitor.stop();
    autoTuningMonitor.start();

    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('sweep中にエラーが起きてもタイマーは生き続け、次のtickも実行される', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants')) return Promise.reject(new Error('connection terminated'));
      return Promise.resolve({ rows: [] });
    });

    autoTuningMonitor.start();
    await jest.advanceTimersByTimeAsync(0);
    mockQuery.mockClear();

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockQuery).toHaveBeenCalled(); // 次のtickが来ている = monitor自体は死んでいない
  });
});
