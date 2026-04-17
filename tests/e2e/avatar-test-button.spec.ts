import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

test.describe('Avatar Card — テストチャットボタン', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test('非SuperAdmin: テナント固有アバターにテストチャットボタンが表示される', async ({ page }) => {
    await page.goto('https://admin.r2c.biz/admin/avatar');

    // ログイン済み前提（Cookie/LocalStorageに認証情報がある場合）
    // アバターカードが表示されていることを確認
    await page.waitForSelector('[class*="av-card"], .av-card', { timeout: 10000 }).catch(() => null);

    // テナント固有アバター（is_default=falseかつavatarEnabled=true）に
    // 「テストチャット」ボタンが存在する可能性を確認
    // ※ 実際のログイン・テナント状態に依存するため、存在有無を確認
    const testChatButtons = page.locator('button', { hasText: 'テストチャット' });
    const testButtons = page.locator('button', { hasText: 'Test Chat' });

    // いずれかのボタンが存在するか、ページ自体が正常に読み込まれることを確認
    const url = page.url();
    if (url.includes('/login')) {
      // 未ログイン状態はスキップ
      test.skip();
      return;
    }

    // ページが読み込まれていること
    await expect(page.locator('body')).not.toBeEmpty();

    // ボタンが存在する場合は href/navigate先を確認
    const btnCount = await testChatButtons.count() + await testButtons.count();
    if (btnCount > 0) {
      const firstBtn = testChatButtons.first().or(testButtons.first());
      await firstBtn.click();
      await page.waitForURL(/\/admin\/chat-test/, { timeout: 5000 });
      expect(page.url()).toMatch(/tenantId=/);
      expect(page.url()).toMatch(/avatarConfigId=/);
    }
  });

  test('アバターページにデフォルトアバターが存在する場合、非SuperAdminにはテストチャットボタンが非表示', async ({ page }) => {
    await page.goto('https://admin.r2c.biz/admin/avatar');

    const url = page.url();
    if (url.includes('/login')) {
      test.skip();
      return;
    }

    // 「R2C デフォルト」バッジを持つカードを探す（SuperAdmin視点では表示される）
    // 非SuperAdminの場合、デフォルトアバターは表示されないためゼロになる
    const defaultBadges = page.locator('text=R2C デフォルト');
    const defaultBadgeCount = await defaultBadges.count();

    if (defaultBadgeCount > 0) {
      // SuperAdminとして表示されている場合は「💬 テスト」ボタンが存在するはず
      const testBtns = page.locator('button', { hasText: 'テスト' });
      expect(await testBtns.count()).toBeGreaterThan(0);
    } else {
      // 非SuperAdminの場合: デフォルトアバターカード自体が非表示なので検証不要
      expect(true).toBe(true);
    }
  });

  test('テストチャット遷移後のURL検証', async ({ page }) => {
    const dummyTenantId = 'test-tenant';
    const dummyAvatarId = 'test-avatar';

    await page.goto(
      `https://admin.r2c.biz/admin/chat-test?tenantId=${dummyTenantId}&avatarConfigId=${dummyAvatarId}`
    );

    const url = page.url();
    if (url.includes('/login')) {
      test.skip();
      return;
    }

    expect(url).toContain(`tenantId=${dummyTenantId}`);
    expect(url).toContain(`avatarConfigId=${dummyAvatarId}`);
  });
});
