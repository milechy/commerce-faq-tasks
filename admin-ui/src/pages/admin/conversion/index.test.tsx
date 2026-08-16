// GID 1216277595663810 派生棚卸し: super_adminプレビューmode中に成約・効果分析ページも
// テナントスコープされず全テナント横断データが表示されていた不具合の回帰テスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConversionDashboardPage from './index';
import { useAuth } from '../../../auth/useAuth';
import { authFetch } from '../../../lib/api';

vi.mock('../../../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../../i18n/LangContext', () => ({
  useLang: () => ({ t: (k: string) => k, lang: 'ja' }),
}));

vi.mock('../../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: vi.fn(),
}));

const SUPER_ADMIN_PREVIEWING = {
  user: { id: '1', email: 'admin@example.com', role: 'super_admin', tenantId: null, tenantName: null },
  isSuperAdmin: false,
  isClientAdmin: true,
  isLoading: false,
  logout: vi.fn(),
  previewMode: true,
  previewTenantId: 'lp-demo-avator',
  previewTenantName: 'LP Demo',
  enterPreview: vi.fn(),
  exitPreview: vi.fn(),
};

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function renderPage() {
  return render(
    <MemoryRouter>
      <ConversionDashboardPage />
    </MemoryRouter>,
  );
}

describe('ConversionDashboardPage — super_adminプレビューmodeのテナントスコープ', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({}));
  });

  it('プレビューmode中はpreviewTenantIdでtenant_idパラメータをリクエストに含める（修正前は空のuser.tenantIdでフィルタ無しになっていた）', async () => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING as ReturnType<typeof useAuth>);
    renderPage();

    await waitFor(() => {
      const attrCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes('/v1/admin/conversion/attributions'),
      );
      expect(attrCall).toBeTruthy();
      expect(String(attrCall![0])).toContain('tenant_id=lp-demo-avator');

      const expCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes('/v1/admin/ab/experiments'),
      );
      expect(expCall).toBeTruthy();
      expect(String(expCall![0])).toContain('tenant_id=lp-demo-avator');
    });
  });
});

// プラン制限(403)を「読み込み失敗」「0件」と誤表示しない回帰テスト
// (2026-08-16 本番実機検証: starterプランのcarnationで /conversion/effectiveness が
//  403 plan_upgrade_required を返すのに画面は「合計成約数 0」を平然と表示していた)
const mockStatus = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);

describe('ConversionDashboardPage — プラン制限(403)の表示', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING as ReturnType<typeof useAuth>);
    vi.mocked(authFetch).mockReset();
  });

  it('3本とも403 plan_upgrade_requiredのとき「0」を描画せず、プラン制限メッセージを出す(赤帯は出さない)', async () => {
    const PLAN_MSG = 'CV計測はGrowthプラン以上でご利用いただけます';
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { notifications: [] });
      return mockStatus(403, { error: 'plan_upgrade_required', message: PLAN_MSG });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(new RegExp(PLAN_MSG))).toBeTruthy();
    });
    // 「合計成約数」のKPIカードに「0」という実データ風の値が出ていないこと
    expect(screen.queryByText('0')).toBeNull();
    // エラー赤帯(「読み込みに失敗しました」)は出ない — 403は正常系の分岐
    expect(screen.queryByText(/読み込みに失敗しました/)).toBeNull();
  });

  it('500など通常のエラーでは「読み込みに失敗しました」+再試行を出し、プラン制限メッセージは出さない', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { notifications: [] });
      return mockStatus(500, { error: 'internal_error' });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/読み込みに失敗しました/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
    expect(screen.queryByText(/プランでご利用いただけます|プランのアップグレード/)).toBeNull();
  });

  it('一部だけ200・一部だけ403でも、200で取得できたデータは表示される(並列取得の分離)', async () => {
    vi.mocked(authFetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v1/admin/notifications')) return mockStatus(200, { notifications: [] });
      if (u.includes('/v1/admin/conversion/attributions')) {
        return mockStatus(200, { summary: { total: 7, by_type: {}, by_principle: {}, avg_temp_score: 42 } });
      }
      return mockStatus(403, { error: 'plan_upgrade_required', message: 'Growthプラン以上でご利用いただけます' });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('7')).toBeTruthy();
    });
  });
});
