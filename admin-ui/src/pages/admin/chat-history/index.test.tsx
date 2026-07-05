// GID 1216277595663810: super_adminプレビューmode中に会話履歴が
// テナントスコープされず全テナント横断データが表示されていた不具合の回帰テスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChatHistoryPage from './index';
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
  isSuperAdmin: false, // プレビュー中は client_admin 相当にフォールバック
  isClientAdmin: true,
  isLoading: false,
  logout: vi.fn(),
  previewMode: true,
  previewTenantId: 'lp-demo-avator',
  previewTenantName: 'LP Demo',
  enterPreview: vi.fn(),
  exitPreview: vi.fn(),
};

const SUPER_ADMIN_NOT_PREVIEWING = {
  user: { id: '1', email: 'admin@example.com', role: 'super_admin', tenantId: null, tenantName: null },
  isSuperAdmin: true,
  isClientAdmin: false,
  isLoading: false,
  logout: vi.fn(),
  previewMode: false,
  previewTenantId: null,
  previewTenantName: null,
  enterPreview: vi.fn(),
  exitPreview: vi.fn(),
};

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function renderPage() {
  return render(
    <MemoryRouter>
      <ChatHistoryPage />
    </MemoryRouter>,
  );
}

describe('ChatHistoryPage — super_adminプレビューmodeのテナントスコープ', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/evaluations')) return mockOk({ evaluations: [] });
      return mockOk({ sessions: [], total: 0 });
    });
  });

  it('プレビューmode中はpreviewTenantIdでスコープされたリクエストを送る（修正前は tenant パラメータ無しで全件取得していた）', async () => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_PREVIEWING as ReturnType<typeof useAuth>);
    renderPage();

    await waitFor(() => {
      const sessionCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes('/v1/admin/chat-history/sessions'),
      );
      expect(sessionCall).toBeTruthy();
      expect(String(sessionCall![0])).toContain('tenant=lp-demo-avator');
    });
  });

  it('プレビューしていない通常のsuper_adminはtenantパラメータ無しで全テナント取得のまま（回帰確認）', async () => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN_NOT_PREVIEWING as ReturnType<typeof useAuth>);
    renderPage();

    await waitFor(() => {
      const sessionCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes('/v1/admin/chat-history/sessions'),
      );
      expect(sessionCall).toBeTruthy();
      expect(String(sessionCall![0])).not.toContain('tenant=');
    });
  });
});
