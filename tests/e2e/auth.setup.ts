import { test as setup } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ADMIN_BASE_URL } from './config';
import { waitForAppReady } from './helpers/gotoRetry';

const AUTH_FILE = 'tests/e2e/.auth/user.json';

setup('authenticate admin', async ({ page }) => {
  const email = process.env.TEST_ADMIN_EMAIL;
  const password = process.env.TEST_ADMIN_PASSWORD;

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  if (!email || !password) {
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }));
    console.warn('⚠️  TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD 未設定 — 認証スキップ (authenticated tests will be skipped)');
    return;
  }

  // Asana 1217048228772841: mainマージ直後のCloudflare Pagesデプロイ直撃で
  // input[type="email"]が現れない時間帯があるため、再読み込みしながら待つ。
  await waitForAppReady(page, ADMIN_BASE_URL, 'input[type="email"]');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.locator('button[type="submit"]').click();

  // Supabase Auth がログイン後にダッシュボードへリダイレクトするのを待つ
  await page.waitForURL((url) => !url.href.includes('/login'), { timeout: 20000 });

  await page.context().storageState({ path: AUTH_FILE });
  console.log('✅ 認証完了 → storageState 保存:', AUTH_FILE);
});
