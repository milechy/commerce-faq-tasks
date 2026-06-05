import { defineConfig } from '@playwright/test';

const AUTH_FILE = 'tests/e2e/.auth/user.json';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://admin.r2c.biz',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'admin-ui',
      testMatch: /(responsive|avatar-test-button|visual-regression)\.spec\.ts/,
      use: {
        browserName: 'chromium',
        storageState: AUTH_FILE,
      },
      dependencies: ['setup'],
    },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts|(responsive|avatar-test-button|visual-regression)\.spec\.ts/,
      use: { browserName: 'chromium' },
    },
  ],
});
