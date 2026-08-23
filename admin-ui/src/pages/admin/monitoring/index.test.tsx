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
