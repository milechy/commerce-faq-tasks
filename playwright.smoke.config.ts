import { defineConfig } from '@playwright/test';

// デプロイ直後に本番へ向けて走らせるブラウザスモーク専用の設定。
// playwright.config.ts とは分けている:
//   - 認証(storageState / setup プロジェクト)に依存しない。埋め込みウィジェットは
//     未ログインの訪問者が触るものなので、ログインを前提にすると検証対象がズレる
//   - チャネルに実 Chrome を使う。デプロイはローカルMacから実行され、
//     Playwright 同梱の chromium が未ダウンロードのことがあるため
//     (SCRIPTS/post-deploy-widget-smoke.sh が起動可否を先に判定する)
//   - リトライ1回。本番への1発勝負でネットワーク由来の偽陽性を出さないため
export default defineConfig({
  testDir: './tests/smoke',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    // ローカル(デプロイ実行機)では実Chromeを使う。Playwright同梱の chromium が
    // 未ダウンロードのことがあるため。CI は `npx playwright install chromium` で
    // 同梱ブラウザを入れるので SMOKE_USE_BUNDLED_CHROMIUM=1 で切り替える。
    ...(process.env.SMOKE_USE_BUNDLED_CHROMIUM === '1' ? {} : { channel: 'chrome' as const }),
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // GID 1216970103691946: E2Eトラフィックであることをサーバ側(resolveTrafficSource)
    // が判定できるようにする。本番へのE2E実行がchat_sessions等の集計指標
    // (継続率・CV率・Judgeスコア)を汚染していた事故の再発防止。
    // ブラウザコンテキストの全リクエスト(widget.jsのfetch含む)に付与される。
    extraHTTPHeaders: { 'x-r2c-traffic-source': 'e2e' },
  },
});
