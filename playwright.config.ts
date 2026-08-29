import { defineConfig } from '@playwright/test';
import { ADMIN_BASE_URL } from './tests/e2e/config';

const AUTH_FILE = 'tests/e2e/.auth/user.json';
const SUPERADMIN_AUTH_FILE = 'tests/e2e/.auth/superadmin.json';

export default defineConfig({
  testDir: './tests/e2e',
  // tests/ 配下は Jest と Playwright の二重所有。*.test.ts は Jest の領域であり、
  // Playwrightが拾うと収集エラー(ReferenceError: describe is not defined)で
  // E2E全件が0件になるため、ここで .spec.ts / .setup.ts のみに限定する。
  testMatch: /\.(spec|setup)\.ts$/,
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
    // テナントロールで /copilot-preview を通しで見るスイート。
    // 「実際に目で見えるUI」で回すことが目的なので、CI以外では実Chromeを headed で立ち上げ、
    // 各テストの録画とスクリーンショットを残す(失敗時だけでなく常に。後から通しで見返せる)。
    // API応答はすべて page.route でブラウザ内に閉じるため(helpers/copilotTenantHarness.ts)、
    // 本番DB・本番の集計指標・外部APIの従量課金には一切到達しない。
    {
      name: 'copilot-tenant',
      testMatch: /qa-copilot-tenant-(journey|irregular)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        channel: 'chrome',
        headless: !!process.env.CI,
        storageState: AUTH_FILE,
        video: process.env.CI ? 'retain-on-failure' : 'on',
        screenshot: 'on',
        viewport: { width: 1440, height: 900 },
      },
      dependencies: ['setup'],
    },
    // copilot-tenant のうち、描画・レイアウトに実ブラウザ差が出うるテストだけを
    // WebKit でも回す限定セット(`@cross-browser` タグを付けた6本のみ)。
    // Playwright の WebKit は実機 iOS Safari の代替ではない(型崩れの検知まで)。
    // ITP による sessionStorage 制限・100vh とソフトキーボード・DataTransfer の挙動差は
    // このプロジェクトでは検知できない既知の限界として受け入れる。
    // `pnpm exec playwright test --project=copilot-tenant-webkit` で実行する
    // (既定の `pnpm test:e2e` には含めない。72本の主張を2エンジン分毎回検証する
    // 価値が薄い一方、失敗時の切り分けコストだけが倍になるため)。
    {
      name: 'copilot-tenant-webkit',
      testMatch: /qa-copilot-tenant-(journey|irregular)\.spec\.ts/,
      grep: /@cross-browser/,
      use: {
        browserName: 'webkit',
        headless: !!process.env.CI,
        storageState: AUTH_FILE,
        video: process.env.CI ? 'retain-on-failure' : 'on',
        screenshot: 'on',
        viewport: { width: 1440, height: 900 },
      },
      dependencies: ['setup'],
    },
    // super_admin ロールで管理画面(旧UI = /admin/*)を通しで見るスイート。
    // copilot-tenant と同じ方針: CI以外では実Chromeを headed で立ち上げ、
    // 録画とスクリーンショットを常時保存する(失敗時だけでなく毎回。後から見返すため)。
    // API応答はすべて page.route でブラウザ内に閉じるため(helpers/superAdminHarness.ts)、
    // 本番DB・本番の集計指標・他テナントの設定には一切到達しない。
    {
      name: 'superadmin',
      testMatch: /qa-superadmin-(journey|irregular)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        channel: 'chrome',
        headless: !!process.env.CI,
        storageState: SUPERADMIN_AUTH_FILE,
        video: process.env.CI ? 'retain-on-failure' : 'on',
        screenshot: 'on',
        viewport: { width: 1440, height: 900 },
      },
      dependencies: ['superadmin-setup'],
    },
    {
      name: 'chromium',
      // superadmin.setup.ts は既定の testMatch(*.spec.ts / *.test.ts)に一致しないため
      // 現状は拾われないが、将来 testMatch を緩めたときに setup が本テストとして
      // 二重実行されるのを防ぐため、auth.setup.ts と同様に明示的に除外しておく。
      testIgnore: /(auth|superadmin)\.setup\.ts|(responsive|avatar-test-button|visual-regression)\.spec\.ts|qa-(copilot-tenant|superadmin)-(journey|irregular)\.spec\.ts/,
      use: { browserName: 'chromium' },
      // Role C(super_admin)テストは storageState をファイルから直接読むため
      // storageState 指定は不要だが、生成の順序保証のために依存を張る。
      dependencies: ['setup', 'superadmin-setup'],
    },
  ],
});
