import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChatTestPage from './index';
import { useAuth } from '../../../auth/useAuth';
import { authFetch } from '../../../lib/api';

vi.mock('../../../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../../i18n/LangContext', () => ({
  useLang: () => ({ t: (k: string) => k }),
}));

vi.mock('../../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: vi.fn(),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const AVATARS_TENANT_A = [
  { id: 'av-default', name: 'R2C Default', image_url: null, is_default: true, tenant_id: 'tenant-a' },
  { id: 'av-custom-1', name: 'My Avatar', image_url: null, is_default: false, tenant_id: 'tenant-a' },
];

const AVATARS_TENANT_B = [
  { id: 'av-b-1', name: 'Tenant B Avatar', image_url: null, is_default: false, tenant_id: 'tenant-b' },
];

const mockClientAdmin = {
  user: {
    id: '1',
    email: 'client@example.com',
    role: 'client_admin' as const,
    tenantId: 'tenant-a',
    tenantName: 'Tenant A',
  },
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

const mockSuperAdmin = {
  user: {
    id: '2',
    email: 'admin@example.com',
    role: 'super_admin' as const,
    tenantId: null,
    tenantName: null,
  },
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

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function renderPage(url = '/') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ChatTestPage />
    </MemoryRouter>
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ChatTestPage', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.clearAllMocks();
  });

  it('F1: client_adminでアバター一覧をフェッチして表示する', async () => {
    vi.mocked(useAuth).mockReturnValue(mockClientAdmin);
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/v1/admin/avatar/configs'))
        return mockOk({ configs: AVATARS_TENANT_A });
      return mockOk({ token: 'tok', tenantId: 'tenant-a', expiresIn: 3600 });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'R2C Default (R2Cデフォルト)' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'My Avatar (カスタム)' })).toBeTruthy();
    });
  });

  it('F2: URLクエリのavatarConfigIdが初期選択される', async () => {
    vi.mocked(useAuth).mockReturnValue(mockClientAdmin);
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/v1/admin/avatar/configs'))
        return mockOk({ configs: AVATARS_TENANT_A });
      return mockOk({ token: 'tok', tenantId: 'tenant-a', expiresIn: 3600 });
    });

    renderPage('/?avatarConfigId=av-custom-1');

    await waitFor(() => {
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('av-custom-1');
    });
  });

  it('F3: アバタードロップダウン変更でwidgetスクリプトのdata-avatar-config-idが更新される', async () => {
    vi.mocked(useAuth).mockReturnValue(mockClientAdmin);
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/v1/admin/avatar/configs'))
        return mockOk({ configs: AVATARS_TENANT_A });
      return mockOk({ token: 'tok', tenantId: 'tenant-a', expiresIn: 3600 });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'R2C Default (R2Cデフォルト)' })).toBeTruthy();
    });

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'av-default' } });

    await waitFor(() => {
      const script = document.querySelector('script[src="http://localhost:3100/widget.js"]');
      expect(script?.getAttribute('data-avatar-config-id')).toBe('av-default');
    });
  });

  it('F4: scope=globalでアバターセクションが非表示になる', async () => {
    vi.mocked(useAuth).mockReturnValue(mockClientAdmin);
    vi.mocked(authFetch).mockImplementation(() =>
      mockOk({ token: 'tok', tenantId: 'global', expiresIn: 3600 })
    );

    renderPage('/?scope=global');

    await waitFor(() => {
      expect(screen.queryByText('🎭 テストするアバター')).toBeNull();
    });
  });

  it('F5: client_adminにはテナントセレクターがなくアバターセクションが表示される', async () => {
    vi.mocked(useAuth).mockReturnValue(mockClientAdmin);
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/v1/admin/avatar/configs'))
        return mockOk({ configs: AVATARS_TENANT_A });
      return mockOk({ token: 'tok', tenantId: 'tenant-a', expiresIn: 3600 });
    });

    renderPage();

    expect(screen.queryByText('— テナントを選択 —')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('🎭 テストするアバター')).toBeTruthy();
    });
  });

  it('F6: super_adminはテナント+アバター両セレクターが表示され、テナント変更でアバター再フェッチされる', async () => {
    vi.mocked(useAuth).mockReturnValue(mockSuperAdmin);
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/v1/admin/tenants'))
        return mockOk({ tenants: [{ id: 'tenant-a', name: 'Tenant A' }, { id: 'tenant-b', name: 'Tenant B' }] });
      if (url.includes('/v1/admin/avatar/configs') && url.includes('tenant=tenant-b'))
        return mockOk({ configs: AVATARS_TENANT_B });
      if (url.includes('/v1/admin/chat-test/token'))
        return mockOk({ token: 'tok', tenantId: 'tenant-b', expiresIn: 3600 });
      return mockOk({});
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Tenant A' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Tenant B' })).toBeTruthy();
    });

    const tenantSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(tenantSelect, { target: { value: 'tenant-b' } });

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Tenant B Avatar (カスタム)' })).toBeTruthy();
    });
  });
});
