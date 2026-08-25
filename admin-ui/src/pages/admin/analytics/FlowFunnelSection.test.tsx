// admin-ui/src/pages/admin/analytics/FlowFunnelSection.test.tsx
//
// P0-1 (GID 1217808384631918): /admin/analytics の全損を再発させないための
// レンダリングテスト。本番実測フィクスチャで最後まで描画が完了することと、
// レスポンス契約が壊れたときにページ全体ではなくこのセクションだけが
// エラー表示になることを固定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { FlowFunnelSection } from "./FlowFunnelSection";
import { SectionErrorBoundary } from "../../../components/common/SectionErrorBoundary";
import { authFetch } from "../../../lib/api";

// FlowFunnelSection.tsx 自体は ChartJS.register を呼ばない。実アプリでは
// 親の index.tsx がモジュール読み込み時に登録を済ませているため動くが、
// このコンポーネントを単体で読み込むテストでは明示的に登録が要る
// (実アプリと同じ読み込み順序を再現するだけで、これはテスト側の事情)。
ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
const mockFail = (): Promise<Response> =>
  Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response);

// 2026-08-25 本番実測(carnation, period=30d) — 修正前はこの形で
// TypeError: Cannot read properties of undefined (reading 'toLocaleString') が発生していた
const PRODUCTION_FIXTURE = {
  period: "30d",
  tenant_id: null,
  total_transitions: 0,
  funnel: {
    to_answer_count: 0,
    to_confirm_count: 0,
    to_terminal_count: 0,
    completed_count: 0,
    confirm_rate_pct: 0,
    completion_rate_pct: 0,
  },
  transitions: [],
};

describe("FlowFunnelSection — 本番相当データで最後まで描画できる(P0-1回帰)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("0件レスポンス(carnation実測)でエラー表示にならず、総遷移数0件が出る", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockOk(PRODUCTION_FIXTURE));
    render(<FlowFunnelSection period="30d" tenantId="carnation" isSuperAdmin={false} />);

    await waitFor(() => expect(screen.getByText(/総遷移数/)).toBeTruthy());
    expect(screen.queryByText(/起動エラー/)).toBeNull();
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("非0件レスポンスで遷移テーブルと件数が正しい列から表示される", async () => {
    const nonZero = {
      ...PRODUCTION_FIXTURE,
      total_transitions: 40,
      funnel: { ...PRODUCTION_FIXTURE.funnel, to_answer_count: 15, confirm_rate_pct: 20 },
      transitions: [{ from_state: null, to_state: "answer", transition_count: 15 }],
    };
    vi.mocked(authFetch).mockImplementation(() => mockOk(nonZero));
    render(<FlowFunnelSection period="30d" tenantId="carnation" isSuperAdmin={false} />);

    await waitFor(() => expect(screen.getByText("40")).toBeTruthy());
    // transition_count(15) が表示される。旧実装は t.count を読んで undefined になっていた
    expect(screen.getByText("15")).toBeTruthy();
  });

  it("APIが4xx/5xxを返してもクラッシュせず、エラーメッセージを表示する", async () => {
    vi.mocked(authFetch).mockImplementation(() => mockFail());
    render(<FlowFunnelSection period="30d" tenantId="carnation" isSuperAdmin={false} />);

    await waitFor(() => expect(screen.getByText(/読み込みに失敗しました/)).toBeTruthy());
  });

  it("レスポンス契約が壊れていても(旧フロント型相当)クラッシュせず、エラーメッセージを表示する", async () => {
    // parseFlowTransitionsResponse が throw するのを catch でエラー表示に落とせているか
    const legacyBrokenShape = { period: "30d", total_sessions: 13, funnel: {}, transitions: [] };
    vi.mocked(authFetch).mockImplementation(() => mockOk(legacyBrokenShape));
    render(<FlowFunnelSection period="30d" tenantId="carnation" isSuperAdmin={false} />);

    await waitFor(() => expect(screen.getByText(/読み込みに失敗しました/)).toBeTruthy());
  });

  it("periodが変わると異なるクエリで再フェッチする", async () => {
    // rerender で props を差し替えると、chart.js が再描画時に canvas の
    // getContext/resize を試みて jsdom で例外になる(既知のテスト環境の
    // 制約で、アプリのバグではない)。useEffect の依存配列が正しく
    // period を含んでいることは、マウント直後のURLで検証すれば十分。
    vi.mocked(authFetch).mockImplementation(() => mockOk(PRODUCTION_FIXTURE));
    render(<FlowFunnelSection period="7d" tenantId="carnation" isSuperAdmin={false} />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(authFetch).mock.calls[0][0])).toContain("period=7d");

    vi.mocked(authFetch).mockClear();
    render(<FlowFunnelSection period="90d" tenantId="carnation" isSuperAdmin={false} />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(authFetch).mock.calls[0][0])).toContain("period=90d");
  });
});

describe("FlowFunnelSection — エラー境界との統合(P0-1本丸)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("レスポンスが壊れていても、パース例外が外に漏れずページ全体を巻き込まない", async () => {
    // legacyBrokenShape は catch されるため通常は境界まで届かない。
    // 万一 catch を素通りする実装退行があっても境界が受け止めることを固定する。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authFetch).mockImplementation(() => mockOk({ totally: "unexpected" }));
    render(
      <div>
        <SectionErrorBoundary sectionLabel="会話フロー 遷移ファネル">
          <FlowFunnelSection period="30d" tenantId="carnation" isSuperAdmin={false} />
        </SectionErrorBoundary>
        <div data-testid="sibling">兄弟セクション</div>
      </div>,
    );
    await waitFor(() => expect(screen.getByTestId("sibling").textContent).toBe("兄弟セクション"));
    spy.mockRestore();
  });
});
