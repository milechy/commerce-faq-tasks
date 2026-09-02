// src/api/conversion/autoTuning.poolUndefined.test.ts
// A2A-0g 強化: pool が undefined(DATABASE_URL 未設定などでDB未接続。src/lib/db.ts の
// export する pool がそのまま undefined になるケース)でも、runAutoTuningCheck /
// runAutoTuningSweep / autoTuningMonitor.start() が例外を投げず、クエリも通知も
// 一切試みないことを固定する。
//
// src/index.ts の起動時配線は `if (db) { autoTuningMonitor.start(); }`
// (db は pool のエイリアス)で同じ「pool が truthy か」をガードしている。ここで
// autoTuning.ts 側の `if (!pool) return` を固定しておけば、index.ts 側のガードを
// 誤って外す変更が入っても本体側で落ちないことまでは保証できる(index.ts はサーバ
// 起動全体を伴うため、この配線条件そのものをユニットテストするのは対象外とした)。
//
// jest.mock は同一テストファイル内で `../../lib/db` を差し替える必要があるため、
// autoTuning.test.ts とは別ファイルに分離した。

jest.mock('../../lib/db', () => ({ pool: undefined }));

const mockCreateNotification = jest.fn();
const mockNotificationExists = jest.fn();
jest.mock('../../lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  notificationExists: (...args: unknown[]) => mockNotificationExists(...args),
}));

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runAutoTuningCheck, runAutoTuningSweep, autoTuningMonitor } from './autoTuning';

describe('pool 未接続(pool === undefined)のとき', () => {
  afterEach(() => {
    autoTuningMonitor.stop();
    jest.useRealTimers();
  });

  it('runAutoTuningCheck は例外を投げず、通知も作らない', async () => {
    await expect(runAutoTuningCheck('tenant-1')).resolves.toBeUndefined();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('runAutoTuningSweep は例外を投げず、通知も作らない', async () => {
    await expect(runAutoTuningSweep()).resolves.toBeUndefined();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('autoTuningMonitor.start() はスケジューラを起動しても例外を投げない(起動直後の初回tickを含む)', async () => {
    jest.useFakeTimers();
    expect(() => autoTuningMonitor.start()).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
