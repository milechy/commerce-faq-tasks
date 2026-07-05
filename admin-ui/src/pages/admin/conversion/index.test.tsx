// GID 1216277595663810 派生棚卸し: super_adminプレビューmode中に成約・効果分析ページも
// テナントスコープされず全テナント横断データが表示されていた不具合の回帰テスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
