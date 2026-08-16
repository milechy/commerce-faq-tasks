// プラン制限(403)を「読み込み失敗」と誤表示しない回帰テスト
// (2026-08-16 本番実機検証: starterプランのcarnationで /analytics/summary 等が
//  403 plan_upgrade_required を返すのに画面は赤帯「データの読み込みに失敗しました」を表示していた)
//
// analyticsディレクトリにはこれまでテストが1本も無く、403/500の分岐が無言で戻っていた。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsDashboardPage from './index';
import { useAuth } from '../../../auth/useAuth';
import { authFetch } from '../../../lib/api';

vi.mock('../../../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: vi.fn(),
}));

// happy-dom は canvas 2d context を提供しないため、Chart.js を経由する
// react-chartjs-2 のコンポーネントはテスト用スタブに差し替える(本番コードは触らない)。
vi.mock('react-chartjs-2', () => ({
  Line: () => null,
  Bar: () => null,
  Doughnut: () => null,
  Radar: () => null,
  Pie: () => null,
}));

const CLIENT_ADMIN = {
  user: { id: '1', email: 'admin@carnation.example.com', role: 'client_admin', tenantId: 'carnation', tenantName: 'carnation' },
  isSuperAdmin: false,
  isClientAdmin: true,
  isLoading: false,
  logout: vi.fn(),
  previewMode: false,
  previewTenantId: null,
  previewTenantName: null,
  enterPreview: vi.fn(),
  exitPreview: vi.fn(),
};

const mockStatus = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);

function renderPage() {
  return render(
    <MemoryRouter>
      <AnalyticsDashboardPage />
    </MemoryRouter>,
  );
}

describe('AnalyticsDashboardPage — プラン制限(403)の表示', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(CLIENT_ADMIN as ReturnType<typeof useAuth>);
    vi.mocked(authFetch).mockReset();
  });

  it('4本とも403 plan_upgrade_requiredのとき、赤帯を出さずプラン制限メッセージを表示する', async () => {
    const PLAN_MSG = '高度なAnalyticsはGrowthプラン以上でご利用いただけます';
    vi.mocked(authFetch).mockImplementation(() =>
      mockStatus(403, { error: 'plan_upgrade_required', message: PLAN_MSG }),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(PLAN_MSG))).toBeTruthy();
    });
    // このページ固有のエラー赤帯(「時間をおいて再試行してください」)が出ていないこと。
    // FlowFunnelSectionは自前で「フロー遷移データの読み込みに失敗しました」を出すため
    // (どのstatusでも常に出る・plan-limit非対応)、部分一致だと誤ってヒットする。
    // 完全一致で本ページのエラー文言だけを見る。
    expect(
      screen.queryByText('データの読み込みに失敗しました。時間をおいて再試行してください。'),
    ).toBeNull();
    // 本ページのエラー赤帯にだけ付く再試行ボタンも出ていないこと
    expect(screen.queryByRole('button', { name: '再試行' })).toBeNull();
  });

  it('500など通常のエラーでは「読み込みに失敗しました」+再試行を表示し、プラン制限メッセージは出さない', async () => {
    vi.mocked(authFetch).mockImplementation(() => mockStatus(500, { error: 'internal_error' }));

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText('データの読み込みに失敗しました。時間をおいて再試行してください。'),
      ).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
    expect(screen.queryByText(/プランでご利用いただけます|プランのアップグレード/)).toBeNull();
  });

  it('一部のエンドポイントだけ403でも、200で取得できたデータは表示される(並列取得の分離)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/analytics/summary')) {
        return mockStatus(200, {
          period: '30d',
          tenant_id: 'carnation',
          total_sessions: 123,
          avg_judge_score: null,
          total_knowledge_gaps: 0,
          avg_messages_per_session: 0,
          avatar_session_count: 0,
          avatar_rate: 0,
          prev_total_sessions: 0,
          sessions_change_pct: 0,
          sentiment_distribution: { positive: 0, negative: 0, neutral: 0, total: 0 },
          cv_count_30d: 0,
          cv_total_value_30d: 0,
          cv_types_breakdown: { purchase: 0, inquiry: 0, reservation: 0, signup: 0, other: 0 },
          cv_fired_status: 'not_fired',
          cv_days_since_first_session: null,
        });
      }
      // trends/evaluations/conversions と、FlowFunnelSectionが独自に叩く flow-transitions は403
      return mockStatus(403, { error: 'plan_upgrade_required', message: 'Growthプラン以上でご利用いただけます' });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('123')).toBeTruthy();
    });
  });
});
