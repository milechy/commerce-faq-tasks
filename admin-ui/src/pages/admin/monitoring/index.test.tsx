// GID 1216970103691946 (PR-7): 計測ヘルスカードの表示テスト。
// CLAUDE.md 禁止34: 母数不足(denominator=0)のとき「判定に足りない」を表示し、
// 0% や矢印を出さないことを検証する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MonitoringPage from "./index";
import { authFetch } from "../../../lib/api";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "t" } } }),
    },
  },
}));

const KPIS_OK = {
  completionRate: 90,
  loopRate: 2,
  fallbackRate: 5,
  searchP95Ms: 500,
  errorRate: 0.1,
  killSwitchActive: false,
  sla: { completionRateMin: 70, loopRateMax: 10, fallbackRateMax: 30, searchP95Max: 1500, errorRateMax: 1 },
};

function mockOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MonitoringPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("MonitoringPage — 計測ヘルス", () => {
  it("母数(denominator)が0のとき「判定に足りない」を表示し、0%や矢印を出さない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          sourceBreakdown: [{ source: "user", count: 13 }],
          emptySessionCount: 0,
          cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
          outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
          validUserSessionCount: 13,
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("判定に足りない").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("母数が十分なとき、パーセンテージと実件数を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          sourceBreakdown: [
            { source: "user", count: 13 },
            { source: "e2e", count: 407 },
            { source: "(null)", count: 598 },
          ],
          emptySessionCount: 0,
          cvSessionLinkRate: { numerator: 100, denominator: 100, rate: 100 },
          outcomeRecordRate: { numerator: 50, denominator: 100, rate: 50, autoRecorded: 30 },
          validUserSessionCount: 13,
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("100%")).toBeTruthy();
    });
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText(/うち自動記録: 30件/)).toBeTruthy();
    expect(screen.getByText("e2e")).toBeTruthy();
    expect(screen.getByText("(null)")).toBeTruthy();
  });

  it("計測ヘルスAPIが失敗しても、KPIカードの表示は妨げない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) return Promise.resolve({ ok: false } as Response);
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("会話完了率")).toBeTruthy();
    });
    expect(screen.getByText("計測ヘルスの取得に失敗しました")).toBeTruthy();
  });
});

// H-7(GID 1217972930945091): Hermes提案の採択率カード。super_adminのときだけ
// hermesAcceptanceRateがAPIレスポンスに含まれる(サーバ側の合成条件は
// schemaHealthRoute.test.tsで検証済み)。ここではフィールドの有無でカードの
// 出し分けと、CLAUDE.md禁止34(母数不足で0%を出さない)を検証する。
describe("MonitoringPage — Hermes提案の採択率", () => {
  const BASE_HEALTH = {
    sourceBreakdown: [{ source: "user", count: 13 }],
    emptySessionCount: 0,
    cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
    outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
    validUserSessionCount: 13,
  };

  it("母数0(Hermes提案が1件も無い)のとき「判定に足りない」を表示し、0%を出さない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          hermesAcceptanceRate: {
            acceptanceRate: { numerator: 0, denominator: 0, rate: null },
            pendingCount: 0,
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Hermes提案の採択率")).toBeTruthy();
    });
    expect(screen.getAllByText("判定に足りない").length).toBeGreaterThan(0);
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("pendingのみ(active/rejectedが0件)のときも「判定に足りない」を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          hermesAcceptanceRate: {
            acceptanceRate: { numerator: 0, denominator: 0, rate: null },
            pendingCount: 7,
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/未判断\(pending\): 7件/)).toBeTruthy();
    });
    expect(screen.getAllByText("判定に足りない").length).toBeGreaterThan(0);
  });

  it("active/rejectedが混在するとき、採択率と集計時点を表示する(矢印は出さない)", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          hermesAcceptanceRate: {
            acceptanceRate: { numerator: 3, denominator: 4, rate: 75 },
            pendingCount: 5,
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("75%")).toBeTruthy();
    });
    expect(screen.getByText(/未判断\(pending\): 5件/)).toBeTruthy();
    expect(screen.queryByText(/[↑↓]/)).toBeNull();
  });

  it("母数1(承認1件のみ)でも率自体は表示される", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          hermesAcceptanceRate: {
            acceptanceRate: { numerator: 1, denominator: 1, rate: 100 },
            pendingCount: 0,
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("100%")).toBeTruthy();
    });
    expect(screen.queryByText(/[↑↓]/)).toBeNull();
  });

  it("client_admin(APIがhermesAcceptanceRateを返さない)のときカード自体を出さない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) return mockOk(BASE_HEALTH);
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("会話完了率")).toBeTruthy();
    });
    expect(screen.queryByText("Hermes提案の採択率")).toBeNull();
  });
});
