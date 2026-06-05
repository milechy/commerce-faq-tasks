import { test, expect } from '@playwright/test';

// Phase C: ビジュアルリグレッションテスト
// storageState (auth.setup.ts) で認証済み状態で実行される
// baselineは tests/e2e/__screenshots__/ に保存
// 更新: pnpm test:visual:update

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

test.describe('Visual Regression — Admin UI', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test.beforeEach(async ({ page }) => {
    // storageStateが空（認証情報なし）の場合はスキップ
    await page.goto('https://admin.r2c.biz');
    if (page.url().includes('/login')) {
      test.skip();
    }
  });

  test('dashboard — desktop 1280x800', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://admin.r2c.biz');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    // 動的な要素（時刻・通知バッジ）をマスクして差分を安定化
    await expect(page).toHaveScreenshot('dashboard-desktop.png', {
      mask: [
        page.locator('[data-testid="notification-count"]'),
        page.locator('time'),
        page.locator('[class*="timestamp"]'),
        page.locator('[class*="date"]'),
      ],
      fullPage: false,
    });
  });

  test('dashboard — mobile 390x844', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('https://admin.r2c.biz');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('dashboard-mobile-390.png', {
      mask: [
        page.locator('time'),
        page.locator('[class*="timestamp"]'),
        page.locator('[class*="date"]'),
      ],
      fullPage: false,
    });
  });

  test('sessions list — desktop 1280x800', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // セッション一覧ページ（AI提案ルール含む）
    await page.goto('https://admin.r2c.biz/admin/sessions');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('sessions-desktop.png', {
      mask: [
        page.locator('time'),
        page.locator('[class*="timestamp"]'),
        page.locator('[class*="date"]'),
        page.locator('[class*="session-id"]'),
      ],
      fullPage: false,
    });
  });
});

test.describe('Visual Regression — Public Pages', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test('carnation-demo index — desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://api.r2c.biz/carnation-demo/index.html');
    await page.waitForLoadState('networkidle');
    // widget初期化を待つ
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('carnation-demo-desktop.png', {
      fullPage: false,
    });
  });

  test('carnation-demo index — mobile 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('https://api.r2c.biz/carnation-demo/index.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('carnation-demo-mobile-390.png', {
      fullPage: false,
    });
  });
});
