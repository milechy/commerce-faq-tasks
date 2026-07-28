// src/lib/avatar/lemonsliceAvatarApi.test.ts
// GID 1216944049264977: LemonSliceアバター登録（外部API呼び出し）が
// trackUsageで計測されることの検証。
//
// 注意: registerAvatarToLemonslice は現状どこからも呼ばれていない未配線の関数
// （SCRIPTS/dead-code-report.txt で検出済み）。将来配線された際にtrackUsageが
// 正しく動くことをここで保証する。

import { registerAvatarToLemonslice } from './lemonsliceAvatarApi';

const mockTrackUsage = jest.fn();
jest.mock('../billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('registerAvatarToLemonslice', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.LEMON_SLICE_ENDPOINT = 'https://lemonslice.example.com';
    process.env.LEMON_SLICE_API_TOKEN = 'test-token';
    process.env.LIVEKIT_WS_URL = 'wss://livekit.example.com';
    process.env.LIVEKIT_ACCESS_TOKEN = 'test-livekit-token';
    mockTrackUsage.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('正常系: 登録成功時にtrackUsage(avatar_config_image, lemonsliceRegistrationCount=1)を1回記録する', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ avatarId: 'avatar-123', status: 'registered' }),
    });

    const result = await registerAvatarToLemonslice({
      auth: { tenantId: 'tenant-a' },
      displayName: 'テストアバター',
      avatarImage: { storageKey: 'k', mimeType: 'image/png', sha256: 'abc' } as any,
    });

    expect(result.avatarId).toBe('avatar-123');
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        featureUsed: 'avatar_config_image',
        lemonsliceRegistrationCount: 1,
      })
    );
  });

  it('登録失敗時（API非2xx）はtrackUsageを呼ばない', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      registerAvatarToLemonslice({
        auth: { tenantId: 'tenant-a' },
        displayName: 'テストアバター',
        avatarImage: { storageKey: 'k', mimeType: 'image/png', sha256: 'abc' } as any,
      })
    ).rejects.toThrow();

    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});
