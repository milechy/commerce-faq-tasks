import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const DEMO_BASE = 'https://api.r2c.biz/carnation-demo';

test.describe('Phase65 carnation-demo サイト', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  // test 1: 各ページが表示されること
  const pages = [
    { path: '/index.html',             title: 'BROSS新潟' },
    { path: '/stock.html',             title: '在庫' },
    { path: '/stock-detail.html?id=1', title: 'ハリアー' },
    { path: '/inquiry.html',           title: 'お問い合わせ' },
    { path: '/inquiry-thanks.html',    title: 'ありがとう' },
    { path: '/reservation.html',       title: '試乗予約' },
    { path: '/reservation-thanks.html',title: 'ありがとう' },
    { path: '/purchase.html',          title: '購入' },
    { path: '/purchase-thanks.html',   title: 'ありがとう' },
  ];

  for (const { path, title } of pages) {
    test(`ページ表示: ${path}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      const res = await page.goto(`${DEMO_BASE}${path}`);
      expect(res?.status()).toBe(200);

      // widget.js ロードエラーは許容（ネットワーク制約の可能性あり）
      const fatal = errors.filter(
        (e) => !e.includes('widget') && !e.includes('api-key') && !e.includes('unauthorized') && !e.includes('livekit'),
      );
      expect(fatal).toHaveLength(0);

      const content = await page.textContent('body');
      expect(content).toContain(title.slice(0, 4)); // 部分一致
    });
  }

  // test 2: inquiry-thanks.html でCV APIが呼ばれること
  test('inquiry-thanks: POST /api/conversion/attribute が呼ばれる', async ({ page }) => {
    const cvRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/conversion/attribute') && req.method() === 'POST') {
        cvRequests.push(req.url());
      }
    });

    await page.goto(`${DEMO_BASE}/inquiry-thanks.html`);
    // polling最大5秒 + 余裕1秒
    await page.waitForTimeout(6000);

    expect(cvRequests.length).toBeGreaterThanOrEqual(1);

    // cv-statusの表示確認
    const statusText = await page.locator('#cv-status').textContent();
    expect(statusText).toContain('CV記録');
  });

  // test 3: purchase-thanks.html で価格付きCVが送信されること
  test('purchase-thanks: price付きCVが送信される', async ({ page }) => {
    const cvBodies: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/conversion/attribute') && req.method() === 'POST') {
        cvBodies.push(req.postData() ?? '');
      }
    });

    await page.goto(`${DEMO_BASE}/purchase-thanks.html?price=3190000`);
    await page.waitForTimeout(6000);

    expect(cvBodies.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(cvBodies[0] ?? '{}');
    expect(body.conversion_type).toBe('purchase');
    expect(body.conversion_value).toBe(3190000);
  });

  // test 4b: 旧URL /carnation-demo.html が 301 で新URLへリダイレクトされること
  test('旧URL /carnation-demo.html が /carnation-demo/index.html へリダイレクトされる', async ({ page }) => {
    // Playwrightはリダイレクトを自動追跡するため、最終URLを確認する
    await page.goto('https://api.r2c.biz/carnation-demo.html');
    expect(page.url()).toContain('/carnation-demo/index.html');
    const title = await page.title();
    expect(title).toContain('BROSS新潟');
  });

  // test 4: モバイル幅(390px)で表示崩れがないこと
  test('モバイル幅390pxで主要ページが崩れない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    for (const path of ['/index.html', '/stock.html', '/inquiry.html']) {
      await page.goto(`${DEMO_BASE}${path}`);
      // 水平スクロールが発生していないこと
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const clientWidth = await page.evaluate(() => document.body.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5); // 5px 誤差許容
    }
  });
});
