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
    // 禁止34: 母数不足時に出してはいけない表現の否定側アサーション
    // (「判定に足りない」が出ていることの確認だけでは、他の禁止表現との
    // 同時描画を見逃す)
    expect(screen.queryByText("効果なし")).toBeNull();
    expect(screen.queryByText(/[↑↓▲▼]/)).toBeNull();
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

// GID 1218086068468866(4-1): 👍👎の集計は既にあったが誰も表示していなかった。
// 画面に描画されること・母数が少ないときは実数のみ出すこと・undefinedでも落ちないことを検証する。
describe("MonitoringPage — 回答への👍👎", () => {
  const BASE_HEALTH = {
    sourceBreakdown: [{ source: "user", count: 13 }],
    emptySessionCount: 0,
    cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
    outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
    validUserSessionCount: 13,
  };

  it("answerFeedbackが無い(古いAPI応答)ときでも落ちずプレースホルダを表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) return mockOk(BASE_HEALTH);
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("回答への👍👎")).toBeTruthy();
    });
    expect(screen.getAllByText("取得中...").length).toBeGreaterThan(0);
  });

  it("母数(up+down)が30件未満のとき、割合ではなく実数を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({ ...BASE_HEALTH, answerFeedback: { upCount: 7, downCount: 3 } });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("回答への👍👎")).toBeTruthy();
    });
    expect(screen.getByText(/👍 7 \/ 👎 3/)).toBeTruthy();
    expect(screen.getByText(/件数が少ないため割合は出しません/)).toBeTruthy();
  });

  it("母数が30件以上のとき、👍の割合と実数を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({ ...BASE_HEALTH, answerFeedback: { upCount: 24, downCount: 6 } });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("👍 80%")).toBeTruthy();
    });
    expect(screen.getByText(/👍 24 \/ 👎 6/)).toBeTruthy();
  });
});

// GID 1218086189953625(0-5): 離脱率の分母(chat_open)に混ざっていたsource未フィルタを
// 修正した。NULL(不明)は除外するのではなく件数を出す(黙って除外しない)。
describe("MonitoringPage — 開いたのに話さなかった割合(不明の除外表示)", () => {
  const BASE_HEALTH = {
    sourceBreakdown: [{ source: "user", count: 13 }],
    emptySessionCount: 0,
    cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
    outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
    validUserSessionCount: 13,
  };

  it("母数が十分なとき、不明N件を除外している旨を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          chatOpenDropoff: {
            trackingSince: "2026-08-01T00:00:00Z",
            visitorsOpened: 100,
            visitorsConversed: 25,
            dropoffRate: 75,
            sessionCoverage: { numerator: 100, denominator: 100, rate: 100 },
            unknownSourceVisitorCount: 42,
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("75%")).toBeTruthy();
    });
    expect(screen.getByText(/不明 42 件を除外しています/)).toBeTruthy();
  });

  it("母数不足のときも不明N件を除外している旨を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          chatOpenDropoff: {
            trackingSince: "2026-08-24T01:13:30Z",
            visitorsOpened: 10,
            visitorsConversed: 0,
            dropoffRate: null,
            sessionCoverage: { numerator: 25, denominator: 39, rate: 64.1 },
            unknownSourceVisitorCount: 5,
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/判定に足りません/)).toBeTruthy();
    });
    expect(screen.getByText(/不明 5 件を除外しています/)).toBeTruthy();
  });

  it("unknownSourceVisitorCountが無い(古いAPI応答)ときでも落ちず0件と表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          chatOpenDropoff: {
            trackingSince: "2026-08-01T00:00:00Z",
            visitorsOpened: 100,
            visitorsConversed: 25,
            dropoffRate: 75,
            sessionCoverage: { numerator: 100, denominator: 100, rate: 100 },
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("75%")).toBeTruthy();
    });
    expect(screen.getByText(/不明 0 件を除外しています/)).toBeTruthy();
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
    // 禁止34: 母数不足時に出してはいけない表現の否定側アサーション
    expect(screen.queryByText("効果なし")).toBeNull();
    expect(screen.queryByText(/[↑↓▲▼]/)).toBeNull();
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

// H-11(GID 1217973238377692): 自動昇格(memoryDistiller.distillAndPromote)が
// Prompt Firewallに弾かれた件数。従来はlogger.warnのみで画面に一切出ず、
// 手動昇格(HTTPレスポンスでreasonが返る)と非対称だった。「学習機能の点火状態」
// カードに常時表示することで、母数が少ない現状での誤検知による静かな取りこぼしに
// 気づけるようにした。
describe("MonitoringPage — 学習機能の点火状態(自動昇格のPrompt Firewall弾かれ件数)", () => {
  const BASE_HEALTH = {
    sourceBreakdown: [{ source: "user", count: 13 }],
    emptySessionCount: 0,
    cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
    outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
    validUserSessionCount: 13,
  };

  it("0件のときも「見送られたことはない」ことを明示して表示する(監視できていることが分かる)", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          ignitionStatus: {
            rows: [],
            envControlledFeatures: [],
            anyEnabled: false,
            autoPromotionBlockedByFirewall: { count: 0, lookbackDays: 30 },
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("学習機能の点火状態")).toBeTruthy();
    });
    expect(
      screen.getByText("自動での学習データ保存は、不審な内容を検知して見送られたことはありません（直近30日）。"),
    ).toBeTruthy();
  });

  it("1件以上のときは件数と期間を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          ignitionStatus: {
            rows: [],
            envControlledFeatures: [],
            anyEnabled: false,
            autoPromotionBlockedByFirewall: { count: 3, lookbackDays: 30 },
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("学習機能の点火状態")).toBeTruthy();
    });
    expect(
      screen.getByText("自動での学習データ保存が、不審な内容を検知して直近30日で3件見送られています。"),
    ).toBeTruthy();
    // 0件のときの文言(監視できていない/見送りが無いかのような誤読)を混ぜて出さない
    expect(screen.queryByText(/見送られたことはありません/)).toBeNull();
  });

  it("client_admin(APIがignitionStatusを返さない)のときはカード・件数表示ともに出さない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) return mockOk(BASE_HEALTH);
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("会話完了率")).toBeTruthy();
    });
    expect(screen.queryByText("学習機能の点火状態")).toBeNull();
    expect(screen.queryByText(/見送られ/)).toBeNull();
  });
});

// A2A-0i: 固定費(LemonSlice/LiveKit)クォータ消費率カード。判定ロジック自体
// (80%/50%閾値・3ヶ月連続判定)はbillingHealthCheck.test.tsで検証済みなので、
// ここではAPIレスポンスのフィールドに応じた表示の出し分けだけを検証する。
describe("MonitoringPage — 固定費クォータ消費率(LemonSlice/LiveKit)", () => {
  const BASE_HEALTH = {
    sourceBreakdown: [{ source: "user", count: 13 }],
    emptySessionCount: 0,
    cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
    outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
    validUserSessionCount: 13,
  };

  it("上げ方向シグナル(80%以上)のとき引き上げの示唆を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          fixedCostQuota: {
            lemonslice: { used: 13500, quota: 15000, ratio: 0.9, upSignal: true, downSignal: false, historyMonths: 3 },
            livekit: { used: 0, quota: null, ratio: null, upSignal: false, downSignal: false, historyMonths: 0 },
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("固定費クォータ消費率(LemonSlice/LiveKit)")).toBeTruthy();
    });
    expect(screen.getByText("込み枠の80%以上を消費しています。引き上げを検討してください。")).toBeTruthy();
    // LiveKitは込み枠未設定なので判定保留の注記を出す
    expect(screen.getByText(/込み枠\(LIVEKIT_MONTHLY_ROOM_QUOTA\)が未設定/)).toBeTruthy();
  });

  it("下げ方向シグナル(3ヶ月連続50%未満)のとき引き下げの示唆を表示する", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          fixedCostQuota: {
            lemonslice: { used: 1000, quota: 15000, ratio: 0.067, upSignal: false, downSignal: true, historyMonths: 3 },
            livekit: { used: 10, quota: 100, ratio: 0.1, upSignal: false, downSignal: true, historyMonths: 3 },
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("直近3ヶ月連続で込み枠の50%未満です。引き下げを検討できます。").length).toBe(2);
    });
  });

  it("平常時(80%未満・下げシグナルなし)は示唆メッセージを出さない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) {
        return mockOk({
          ...BASE_HEALTH,
          fixedCostQuota: {
            lemonslice: { used: 6000, quota: 15000, ratio: 0.4, upSignal: false, downSignal: false, historyMonths: 1 },
            livekit: { used: 0, quota: null, ratio: null, upSignal: false, downSignal: false, historyMonths: 0 },
            asOf: "2026-08-30T00:00:00.000Z",
          },
        });
      }
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("固定費クォータ消費率(LemonSlice/LiveKit)")).toBeTruthy();
    });
    expect(screen.queryByText(/引き上げを検討/)).toBeNull();
    expect(screen.queryByText(/引き下げを検討/)).toBeNull();
  });

  it("client_admin(APIがfixedCostQuotaを返さない)のときカード自体を出さない", async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes("/monitoring/kpis")) return mockOk(KPIS_OK);
      if (url.includes("/measurement-health")) return mockOk(BASE_HEALTH);
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("会話完了率")).toBeTruthy();
    });
    expect(screen.queryByText("固定費クォータ消費率(LemonSlice/LiveKit)")).toBeNull();
  });
});
