import { defineConfig } from '@playwright/test';
import { ADMIN_BASE_URL } from './tests/e2e/config';

const AUTH_FILE = 'tests/e2e/.auth/user.json';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: ADMIN_BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // GID 1216970103691946: E2Eトラフィックであることをサーバ側(resolveTrafficSource)
    // が判定できるようにする。本番へのE2E実行がchat_sessions等の集計指標
    // (継続率・CV率・Judgeスコア)を汚染していた事故の再発防止。
    // ブラウザコンテキストの全リクエスト(widget.jsのfetch含む)に付与される。
    extraHTTPHeaders: { 'x-r2c-traffic-source': 'e2e' },
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // super_admin 用 storageState(tests/e2e/.auth/superadmin.json)を生成する。
    // これが無いと qa-irregular-3roles.spec.ts の Role C(super_admin)群は
    // saReady=false で恒久的に skip される。
    // superadmin.setup.ts は .setup.ts のため既定の testMatch(*.spec.ts / *.test.ts)に
    // 一致せず、chromium プロジェクトの testIgnore にも該当しないため、
    // 専用プロジェクトで明示的に拾わないとどこからも実行されない。
    {
      name: 'superadmin-setup',
      testMatch: /superadmin\.setup\.ts/,
    },
    {
      name: 'admin-ui',
      testMatch: /(responsive|avatar-test-button)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        storageState: AUTH_FILE,
      },
      dependencies: ['setup'],
    },
    {
      name: 'visual-regression',
      testMatch: /visual-regression\.spec\.ts/,
      use: {
        browserName: 'chromium',
        storageState: AUTH_FILE,
      },
      dependencies: ['setup'],
    },
    {
      name: 'chromium',
      // superadmin.setup.ts は既定の testMatch(*.spec.ts / *.test.ts)に一致しないため
      // 現状は拾われないが、将来 testMatch を緩めたときに setup が本テストとして
      // 二重実行されるのを防ぐため、auth.setup.ts と同様に明示的に除外しておく。
      testIgnore: /(auth|superadmin)\.setup\.ts|(responsive|avatar-test-button|visual-regression)\.spec\.ts/,
      use: { browserName: 'chromium' },
      // Role C(super_admin)テストは storageState をファイルから直接読むため
      // storageState 指定は不要だが、生成の順序保証のために依存を張る。
      dependencies: ['setup', 'superadmin-setup'],
    },
  ],
});
