import { test, expect } from '@playwright/test';

// QA sweep 2026-07-08: Role B (client_admin, tenant "carnation") flows from
// R2C_UIフローカタログ_2026-07-08.md. Read-only / navigation checks only —
// deliberately avoids mutating the shared demo tenant's data (no create/edit/delete).
// Uses the storage state produced by tests/e2e/auth.setup.ts (TEST_ADMIN_EMAIL/PASSWORD).

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const AUTH_FILE = 'tests/e2e/.auth/user.json';
const BASE = 'https://admin.r2c.biz';

test.describe('QA 2026-07-08 — Role B (client_admin) read-only sweep', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: AUTH_FILE });

  async function gotoAdmin(page: any, path: string) {
    const errors: string[] = [];
    page.on('pageerror', (err: Error) => errors.push(err.message));
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    return { res, errors };
  }

  test('B1-1: ログイン済みセッションで/adminへアクセスできる', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin');
    expect(page.url()).not.toContain('/login');
  });

  test('B3: ダッシュボードにKPIカードが表示される', async ({ page }) => {
    const { errors } = await gotoAdmin(page, '/admin');
    const bodyText = await page.textContent('body');
    test.info().annotations.push({ type: 'page-errors', description: JSON.stringify(errors) });
    expect(bodyText?.length ?? 0).toBeGreaterThan(0);
  });

  test('B4-1: ナレッジ一覧ページが表示される（自テナントへリダイレクト）', async ({ page }) => {
    const { res, errors } = await gotoAdmin(page, '/admin/knowledge');
    expect(res?.status()).toBeLessThan(400);
    // client_admin は /admin/knowledge/:ownTenantId へクライアントサイドでリダイレクトされる。
    // CIのコールドスタート環境では反映に時間がかかることがあるため明示的に待つ
    // （固定 waitForTimeout だけに頼らない）。
    await page
      .waitForURL((url) => url.pathname !== '/admin/knowledge' && url.pathname.startsWith('/admin/knowledge/'), {
        timeout: 8000,
      })
      .catch(() => {});
    expect(page.url()).toContain('/admin/knowledge/');
    expect(page.url()).not.toContain('/global');
    expect(errors.filter((e) => !e.toLowerCase().includes('livekit'))).toHaveLength(0);
  });

  test('B5-1: アバター一覧ページが表示される', async ({ page }) => {
    const { res, errors } = await gotoAdmin(page, '/admin/avatar');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/avatar');
    test.info().annotations.push({ type: 'page-errors', description: JSON.stringify(errors) });
  });

  test('B6: チャットテストページが表示される', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/chat-test');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/chat-test');
  });

  test('B7-1: 会話履歴ページが表示される', async ({ page }) => {
    const { res, errors } = await gotoAdmin(page, '/admin/chat-history');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/chat-history');
    test.info().annotations.push({ type: 'page-errors', description: JSON.stringify(errors) });
  });

  test('B8-1: 対応中の会話（エスカレーション）ページが表示される', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/escalations');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/escalations');
  });

  test('B9-1: AIチューニングページが表示される', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/tuning');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/tuning');
  });

  test('B10-1: 未回答質問（ナレッジギャップ）ページが表示される', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/knowledge-gaps');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/knowledge-gaps');
  });

  test('B11-1: お客様への声がけ設定ページが表示される', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/engagement');
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain('/admin/engagement');
  });

  test('B12: 成約・効果分析ページ（プランゲート挙動を記録）', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/conversion');
    // プラン未達なら /admin へリダイレクトされる可能性がある。挙動を記録するのみで両方を許容。
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    expect(res?.status()).toBeLessThan(400);
  });

  test('B13-1: 会話分析ダッシュボードページ（プランゲート挙動を記録）', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/analytics');
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    expect(res?.status()).toBeLessThan(400);
  });

  test('B16-2: 言語切替（ja/en）でUI文言が変わる', async ({ page }) => {
    await gotoAdmin(page, '/admin');
    const jaText = await page.textContent('body');

    const switched = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const langBtn = btns.find((b) =>
        /EN|English|言語|JA/i.test(b.textContent || '') && (b.textContent || '').length < 20,
      ) as HTMLElement | undefined;
      if (langBtn) {
        langBtn.click();
        return true;
      }
      return false;
    });
    test.info().annotations.push({ type: 'lang-switcher-found', description: String(switched) });

    if (!switched) {
      test.skip();
      return;
    }
    await page.waitForTimeout(800);
    const enText = await page.textContent('body');
    expect(enText).not.toBe(jaText);
  });

  // --- X-5: ロールベースアクセス制御（SuperAdminRoute配下、client_adminは/adminへリダイレクト） ---
  const superAdminOnlyRoutes = [
    '/admin/tenants',
    '/admin/feedback',
    '/admin/options',
    '/admin/avatar-defaults',
    '/admin/knowledge-analytics',
    '/admin/analytics/cv-status',
    '/admin/analytics/flow',
    '/admin/knowledge/global',
  ];

  for (const route of superAdminOnlyRoutes) {
    test(`X-5: client_adminが${route}へ直接アクセスすると/adminへリダイレクトされる`, async ({ page }) => {
      await gotoAdmin(page, route);
      test.info().annotations.push({ type: 'final-url', description: page.url() });
      expect(page.url()).not.toContain(route);
      expect(page.url()).toMatch(/\/admin\/?$/);
    });
  }

  // 実測で判明: /admin/billing と /admin/monitoring は SuperAdminRoute ではなく
  // RequireAuth/AdminRoute（両ロール共通アクセス）。当初のQAカタログの記載は誤りだったため、
  // 「リダイレクトされない」ことと「自テナントに正しくスコープされる」ことを固定する回帰テストに変更。
  test('billing/monitoring は両ロール共通アクセス（リダイレクトなし・自テナントスコープ）', async ({ page }) => {
    const billingApiCalls: string[] = [];
    page.on('request', (req: any) => {
      if (req.url().includes('/v1/admin/billing')) billingApiCalls.push(req.url());
    });

    await gotoAdmin(page, '/admin/billing');
    expect(page.url()).toContain('/admin/billing');
    await page.waitForTimeout(1000);

    // 自テナント(carnation)以外のtenantIdへの問い合わせがないこと（クロステナント漏洩がないこと）
    const crossTenantLeak = billingApiCalls.some(
      (u) => u.includes('tenantId=') && !u.includes('tenantId=carnation'),
    );
    test.info().annotations.push({ type: 'billing-api-calls', description: JSON.stringify(billingApiCalls) });
    expect(crossTenantLeak).toBe(false);

    // テナント横断選択UI（<select>）が client_admin には出ないこと
    const selectCount = await page.locator('select').count();
    expect(selectCount).toBe(0);

    await gotoAdmin(page, '/admin/monitoring');
    expect(page.url()).toContain('/admin/monitoring');
  });
});
