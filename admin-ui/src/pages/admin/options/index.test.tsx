// Phase4 (Sai接続ブリッジ管理UI): Saiセクションの表示・依頼・結果レビューの回帰テスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OptionManagementPage from './index';
import { useAuth } from '../../../auth/useAuth';
import { authFetch } from '../../../lib/api';

vi.mock('../../../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: vi.fn(),
}));

const SUPER_ADMIN = {
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

const ORDER = {
  id: 'order-1',
  tenant_id: 'tenant-x',
  chat_session_id: null,
  description: 'FAQ登録代行',
  llm_estimate_amount: 10000,
  final_amount: null,
  status: 'pending' as const,
  stripe_usage_recorded: false,
  ordered_at: '2026-07-01T00:00:00Z',
  completed_at: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const mockOk = (data: unknown, status = 200): Promise<Response> =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(data) } as Response);

describe('OptionManagementPage — Sai(Agent S)セクション', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue(SUPER_ADMIN as ReturnType<typeof useAuth>);
    vi.mocked(authFetch).mockReset();
  });

  async function openOrderDetail() {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/v1/admin/options?')) return mockOk({ items: [ORDER], total: 1 });
      if (url.includes('/sai-task')) return mockOk({}, 404);
      return mockOk({});
    });

    render(<OptionManagementPage />);
    await waitFor(() => expect(screen.queryByText('FAQ登録代行')).toBeTruthy());
    fireEvent.click(screen.getByText('FAQ登録代行'));
    await waitFor(() => expect(screen.queryByText('▶ Saiに依頼する')).toBeTruthy());
  }

  it('未試行の発注では「Saiに依頼する」ボタンが表示される', async () => {
    await openOrderDetail();
    expect(screen.getByText('▶ Saiに依頼する')).toBeTruthy();
  });

  it('依頼するとtry-saiを叩き、以後sai-taskをポーリングして状態を表示する', async () => {
    await openOrderDetail();

    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/try-sai')) return mockOk({ task_id: 'sai-task-1', status: 'queued' });
      if (url.includes('/sai-task')) {
        return mockOk({ task: { status: 'running', steps: 2, max_steps: 15, description: 'x', last_action: 'click(100,200)' } });
      }
      if (url.includes('/v1/admin/options?')) return mockOk({ items: [ORDER], total: 1 });
      return mockOk({});
    });

    window.confirm = vi.fn().mockReturnValue(true);
    fireEvent.click(screen.getByText('▶ Saiに依頼する'));

    await waitFor(() => expect(screen.queryByText('実行中')).toBeTruthy());
    expect(screen.getByText(/click\(100,200\)/)).toBeTruthy();
  });

  it('完了タスクはスクリーンショットと自己申告の注意書きを表示する（自動完了はしない）', async () => {
    await openOrderDetail();

    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (url.includes('/try-sai')) return mockOk({ task_id: 'sai-task-1', status: 'queued' });
      if (url.includes('/sai-task')) {
        return mockOk({
          task: {
            status: 'complete', steps: 3, max_steps: 15, description: 'x',
            outcome: 'agent_reported_done', final_screenshot_base64: 'AAAA', steps_log: [],
          },
        });
      }
      if (url.includes('/v1/admin/options?')) return mockOk({ items: [ORDER], total: 1 });
      return mockOk({});
    });

    window.confirm = vi.fn().mockReturnValue(true);
    fireEvent.click(screen.getByText('▶ Saiに依頼する'));

    await waitFor(() => expect(screen.queryByText('Saiが完了を報告')).toBeTruthy());
    expect(screen.getByAltText('Sai実行後の最終スクリーンショット')).toBeTruthy();
    expect(screen.getByText(/実際の成否は下のスクリーンショットを目視確認/)).toBeTruthy();
    // 完了マークボタンは既存のまま独立して存在する(Saiが自動で押すことはない)
    expect(screen.getByText('✅ 完了マーク')).toBeTruthy();
  });
});
