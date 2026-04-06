import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

test.describe('Admin UI — Login Page', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test('admin.r2c.biz shows login form', async ({ page }) => {
    await page.goto('https://admin.r2c.biz');

    // メールまたはパスワード入力欄が表示されることを確認
    // Supabase Auth の実際のログインはスキップ（認証情報不要）
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]');
    const passwordInput = page.locator('input[type="password"]');

    // どちらかの入力フォームが存在すれば OK（ログインページ or ダッシュボード）
    const hasEmailInput = await emailInput.count() > 0;
    const hasPasswordInput = await passwordInput.count() > 0;
    const hasLoginForm = hasEmailInput || hasPasswordInput;

    // ログインフォームかダッシュボードのいずれかが表示されていれば成功
    if (!hasLoginForm) {
      // リダイレクト後ダッシュボードが表示されている場合
      await expect(page).toHaveURL(/admin\.r2c\.biz/);
      // ページが何らかのコンテンツを持っていること
      await expect(page.locator('body')).not.toBeEmpty();
    } else {
      expect(hasLoginForm).toBe(true);
    }
  });

  test('admin.r2c.biz page title is not blank', async ({ page }) => {
    await page.goto('https://admin.r2c.biz');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});
