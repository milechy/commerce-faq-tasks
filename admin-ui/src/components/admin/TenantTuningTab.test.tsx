// GID 1215923339719876: 判定ルールトグルがFEのPATCH/BEのPUT不一致で404していた不具合の回帰テスト
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TenantTuningTab from './TenantTuningTab';
import { useAuth } from '../../auth/useAuth';
import { authFetch } from '../../lib/api';

vi.mock('../../auth/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  API_BASE: 'http://localhost:3100',
  authFetch: vi.fn(),
}));

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

const RULE = {
  id: 42,
  tenant_id: 'tenant-a',
  trigger_pattern: '価格について質問',
  expected_behavior: '社会的証明を活用',
  priority: 5,
  is_active: true,
  created_by: 'system',
  created_at: '2026-01-01T00:00:00Z',
};

describe('TenantTuningTab — 判定ルールトグル', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({ isSuperAdmin: true } as ReturnType<typeof useAuth>);
    vi.mocked(authFetch).mockReset();
  });

  it('無効化ボタンクリック時、PUTメソッドで/v1/admin/tuning-rules/:idを呼ぶ（修正前はPATCHで404していた）', async () => {
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).includes('/tuning-rules?')) return mockOk({ rules: [RULE] });
      return mockOk({});
    });

    render(<TenantTuningTab tenantId="tenant-a" tenantName="Tenant A" />);

    const toggleBtn = await screen.findByRole('button', { name: '無効化' });
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      const toggleCall = vi.mocked(authFetch).mock.calls.find(
        ([url]) => String(url) === 'http://localhost:3100/v1/admin/tuning-rules/42',
      );
      expect(toggleCall).toBeTruthy();
      expect(toggleCall![1]).toEqual(
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ is_active: false }) }),
      );
    });
  });
});
