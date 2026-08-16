// プラン制限(403)を「読み込み失敗」と誤表示しない回帰テスト
// (2026-08-16 本番実機検証: starterプランのcarnationで /analytics/summary 等が
//  403 plan_upgrade_required を返すのに画面は赤帯「データの読み込みに失敗しました」を表示していた)
//
// analyticsディレクトリにはこれまでテストが1本も無く、403/500の分岐が無言で戻っていた。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
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

// t() は実辞書(ja.ts)を引く。キー名をそのまま返すモックだと「間違ったキーを
// 参照していても素通りする」ため、画面に実際に出る日本語で検証する
// (KnowledgeListTab.test.tsx / escalations/[sessionId].test.tsx と同じ既存パターン)。
vi.mock('../../../i18n/LangContext', async () => {
  const jaModule = await import('../../../i18n/ja');
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string) => ja[key] ?? key;
  const stableValue = { lang: 'ja' as const, setLang: () => {}, t: stableT };
  return { useLang: () => stableValue };
});

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
    expect(screen.queryByText('データの読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeNull();
    // 読み込み失敗バナーにだけ付く再試行ボタンも出ていないこと
    expect(screen.queryByRole('button', { name: 'やり直す' })).toBeNull();
  });

  it('500など通常のエラーでは「読み込みに失敗しました」+再試行を表示し、プラン制限メッセージは出さない', async () => {
    vi.mocked(authFetch).mockImplementation(() => mockStatus(500, { error: 'internal_error' }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('データの読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'やり直す' })).toBeTruthy();
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

  // ── レビュー指摘(P2-2): 再試行ボタンが「存在する」だけでなく実際に再取得すること ──
  // ハンドラ未接続でも「ボタンがある」テストは通ってしまうため、click→再fetch→復帰まで見る。
  it('「やり直す」を押すと再取得し、成功すればエラーが消えてデータが表示される', async () => {
    let call = 0;
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      // summary 以外はプラン制限(403)のままにして未取得状態に倒す。
      // 中途半端な形の200を返すとチャート描画側が落ち、再試行の検証にならない。
      if (!u.includes('/v1/admin/analytics/summary')) {
        return mockStatus(403, { error: 'plan_upgrade_required', message: 'Growthプラン以上でご利用いただけます' });
      }
      call += 1;
      if (call === 1) return mockStatus(500, { error: 'internal_error' });
      return mockStatus(200, {
        period: '30d', tenant_id: 'carnation', total_sessions: 456,
        avg_judge_score: null, total_knowledge_gaps: 0, avg_messages_per_session: 0,
        avatar_session_count: 0, avatar_rate: 0, prev_total_sessions: 0, sessions_change_pct: 0,
        sentiment_distribution: { positive: 0, negative: 0, neutral: 0, total: 0 },
        cv_count_30d: 0, cv_total_value_30d: 0,
        cv_types_breakdown: { purchase: 0, inquiry: 0, reservation: 0, signup: 0, other: 0 },
        cv_fired_status: 'not_fired', cv_days_since_first_session: null,
      });
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('データの読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'やり直す' }));

    await waitFor(() => expect(screen.getByText('456')).toBeTruthy());
    expect(screen.queryByText('データの読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeNull();
  });

  // ── レビュー指摘(P2-3): 非JSONのエラーボディ(nginxの502 HTML等) ──
  // res.json() が throw する経路。実運用で最も起きやすい失敗形なのに未検証だった。
  it('エラーボディがJSONでない(502のHTML等)場合もプラン制限と誤判定せず読み込み失敗にする', async () => {
    vi.mocked(authFetch).mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      } as unknown as Response),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('データの読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy());
    expect(screen.queryByText(/プラン/)).toBeNull();
  });

  // ── レビュー指摘(P2-4): 403と500が混在したとき ──
  // 「一部は制限・一部は本当に壊れている」状況。復旧行動が必要な方(読み込み失敗)を優先する。
  it('403と500が混在するときは読み込み失敗を優先し、プラン制限バナーは出さない', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/analytics/summary')) {
        return mockStatus(403, { error: 'plan_upgrade_required', message: 'Growthプラン以上でご利用いただけます' });
      }
      return mockStatus(500, { error: 'internal_error' });
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('データの読み込みに失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy());
    expect(screen.queryByText(/Growthプラン以上でご利用いただけます/)).toBeNull();
  });
});
