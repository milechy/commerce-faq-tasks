import type { Page } from '@playwright/test';

// widget.js は apiKey が有る埋め込みページを開いた時点(.fab クリックの有無に関係なく)
// fetchAvatarConfig() を即座に呼び、POST /api/avatar/anam-session →(フォールバック)
// POST /api/avatar/room-token を connect:true で送る。room-token 側は
// dispatchAgentToRoom をレスポンスを返す前に fire-and-forget で呼ぶため、サーバー側で
// 実際に LiveKit エージェント経由の LemonSlice アバターセッションが起動して課金が発生し、
// クライアント側でレスポンスをどう扱っても後から止められない。
//
// アバター設定済みテナントの埋め込みページ(carnation-demo 等)へ page.goto する、または
// .fab をクリックする E2E は、本関数を必ず先に呼んでリクエストをブラウザ側でインターセプトし、
// 本番バックエンドに一切到達させないこと。
export async function mockAvatarBackend(page: Page): Promise<void> {
  await page.route('**/api/avatar/anam-session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false }),
    }),
  );
  await page.route('**/api/avatar/room-token', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        livekitUrl: 'wss://e2e-mock.invalid',
        token: 'e2e-mock-token',
        roomName: 'e2e-mock-room',
        agentId: 'e2e-mock-agent',
        imageUrl:
          'https://rpqrwifbrhlebbelyqog.supabase.co/storage/v1/object/public/avatar-defaults/default_01.png',
        avatarName: 'E2E Mock Avatar',
        preDispatchEnabled: false,
      }),
    }),
  );
}
