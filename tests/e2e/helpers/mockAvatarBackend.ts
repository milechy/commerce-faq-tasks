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

// テキストチャット経路を検証する E2E 用: アバターを**完全に無効化**する。
//
// mockAvatarBackend との違い(重要):
//   mockAvatarBackend は anam-session を enabled:false にする一方、room-token は
//   enabled:true + livekitUrl:'wss://e2e-mock.invalid' を返す。これは「アバターを
//   有効にしたうえで接続先を無効ホストへ向ける」形であり、widget 側は接続を試みて
//   失敗する。その結果ウィジェットの初期化が途中で止まり、挨拶メッセージすら
//   描画されない(.msg-wrapper が 0 件)状態になる。
//
// テキスト送信や有人エスカレーションのように「アバターを介さない経路」を検証する
// テストは、接続を失敗させるのではなく最初から無効を返す本関数を使うこと。
// 2026-08-29、A2-6 / M6 の失敗を trace で追った際、両テストとも /api/chat への
// リクエストが 1 件も無く、検証したい経路にそもそも入っていないことが判明した。
export async function mockAvatarDisabled(page: Page): Promise<void> {
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
      body: JSON.stringify({ enabled: false }),
    }),
  );
}
