import { test as setup } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// super_admin 用 storageState 生成（auth.setup.ts の client_admin 版と同方式）。
// TEST_SUPERADMIN_EMAIL / TEST_SUPERADMIN_PASSWORD が無い場合は空スケルトンを書き、
// Role C テストは spec 側の有効性チェックで skip される。
const SA_AUTH = 'tests/e2e/.auth/superadmin.json';

setup('authenticate super_admin', async ({ page }) => {
  const email = process.env.TEST_SUPERADMIN_EMAIL;
  const password = process.env.TEST_SUPERADMIN_PASSWORD;

  fs.mkdirSync(path.dirname(SA_AUTH), { recursive: true });

  if (!email || !password) {
    fs.writeFileSync(SA_AUTH, JSON.stringify({ cookies: [], origins: [] }));
    console.warn('⚠️  TEST_SUPERADMIN_EMAIL / TEST_SUPERADMIN_PASSWORD 未設定 — super_admin 認証スキップ');
    return;
  }

  await page.goto('https://admin.r2c.biz', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.locator('input[type="email"]').waitFor({ timeout: 15000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.href.includes('/login'), { timeout: 20000 });

  await page.context().storageState({ path: SA_AUTH });
  console.log('✅ super_admin 認証完了 → storageState 保存:', SA_AUTH);
});
