// src/lib/onboardingWidgetSeen.test.ts
// Asana 1217040715801275: recordWidgetSeenOnce のテスト

import { recordWidgetSeenOnce } from "./onboardingWidgetSeen";

jest.mock("./logger", () => ({
  logger: { warn: jest.fn() },
}));

import { logger } from "./logger";
const mockWarn = logger.warn as jest.Mock;

function makeMockDb(queryImpl: jest.Mock) {
  return { query: queryImpl } as unknown as import("pg").Pool;
}

beforeEach(() => {
  mockWarn.mockReset();
});

describe("recordWidgetSeenOnce", () => {
  it("onboarding_widget_seen_at を更新するUPDATEを、WHERE IS NULLガード付きで発行する", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rowCount: 1 });
    const db = makeMockDb(queryMock);

    await recordWidgetSeenOnce(db, "tenant-1");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain("UPDATE tenants SET onboarding_widget_seen_at = NOW()");
    expect(String(sql)).toContain("onboarding_widget_seen_at IS NULL");
    expect(params).toEqual(["tenant-1"]);
  });

  it("既に記録済み(rowCount=0)でも例外を投げない", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rowCount: 0 });
    const db = makeMockDb(queryMock);

    await expect(recordWidgetSeenOnce(db, "tenant-1")).resolves.toBeUndefined();
  });

  it("DBエラー時は例外を投げず、logger.warnに記録するだけ(fire-and-forget)", async () => {
    const queryMock = jest.fn().mockRejectedValue(new Error("connection lost"));
    const db = makeMockDb(queryMock);

    await expect(recordWidgetSeenOnce(db, "tenant-1")).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain("onboardingWidgetSeen");
  });
});
