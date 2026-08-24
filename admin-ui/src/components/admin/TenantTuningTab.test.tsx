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

// features は sales_stage_continuity トグルの描画に使う。未設定=無効(fail-safe)。
const TENANT = {
  id: "tenant-a",
  name: "Tenant A",
  features: { avatar: false, voice: false, rag: true },
} as unknown as import("../../pages/admin/tenants/types").TenantDetail;

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

    render(<TenantTuningTab tenantId="tenant-a" tenantName="Tenant A" tenant={TENANT} onUpdate={() => {}} />);

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

// D1: 会話の段階引き継ぎ(SalesFlow)のトグル。実装済みだが featuresSchema に無く
// DB直更新でしか開けられなかった機能を、画面から開閉できるようにした。
describe('TenantTuningTab — 会話の流れを引き継ぐ', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation((url: string) => {
      if (String(url).includes('/tuning-rules?')) return mockOk({ rules: [] });
      return mockOk({});
    });
  });

  it('未設定なら無効として描画し、「ふりだしに戻る」と伝える', async () => {
    render(<TenantTuningTab tenantId="tenant-a" tenantName="Tenant A" tenant={TENANT} onUpdate={() => {}} />);

    expect(await screen.findByText('会話の流れを引き継ぐ')).toBeTruthy();
    expect(screen.getByRole('button', { name: '⬜ 無効' })).toBeTruthy();
    expect(screen.getByText(/毎回ふりだしに戻ります/)).toBeTruthy();
  });

  it('有効なテナントでは有効として描画する', async () => {
    const on = { ...TENANT, features: { ...TENANT.features, sales_stage_continuity: true } };
    render(<TenantTuningTab tenantId="tenant-a" tenantName="Tenant A" tenant={on} onUpdate={() => {}} />);

    expect(await screen.findByRole('button', { name: '✅ 有効' })).toBeTruthy();
  });

  it('押すと既存の PATCH /v1/admin/tenants/:id を叩き、他の features キーを落とさない', async () => {
    const withConsent = {
      ...TENANT,
      features: { ...TENANT.features, hermes_raw_data_consent: true },
    };
    render(<TenantTuningTab tenantId="tenant-a" tenantName="Tenant A" tenant={withConsent} onUpdate={() => {}} />);

    const btn = await screen.findByRole('button', { name: '⬜ 無効' });
    fireEvent.click(btn);

    await waitFor(() => {
      const call = vi.mocked(authFetch).mock.calls.find((c) => /\/v1\/admin\/tenants\/tenant-a$/.test(String(c[0])));
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.features.sales_stage_continuity).toBe(true);
      // 既存キーを落とさない
      expect(body.features.hermes_raw_data_consent).toBe(true);
      expect(body.features.rag).toBe(true);
    });
  });
});
