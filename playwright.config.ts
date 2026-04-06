import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 1,
  // E2E_ENABLED=1 または CI 環境でのみ実行
  // 未設定の場合は全テストがスキップされる（各テストファイル内で制御）
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://admin.r2c.biz',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
