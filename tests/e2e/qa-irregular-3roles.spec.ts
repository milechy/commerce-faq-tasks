import { test, expect } from '@playwright/test';

// QA irregular (異常系) sweep — 2026-07-17
// 3ロールが「イレギュラーな動作」をした場合に、拒むべき操作が正しく拒まれるか / スコープが
// 守られるかを検証する。非破壊のみ：作成・削除・kill-switch 等の副作用のある操作はしない。
// - Role A: 匿名公開API(api.r2c.biz)への不正リクエスト（キー無し/偽装/超過/未知セッション）
// - Role B: client_admin の RBAC 越境・?tenant= 偽装・判明済みRBACギャップの実害確認
// - Role C: super_admin の横断アクセス正常系 + プレビュー中のテナントスコープ挙動(既知ギャップ)
//
// 認証:
//   Role B — tests/e2e/.auth/user.json (auth.setup.ts, TEST_ADMIN_EMAIL/PASSWORD = carnation client_admin)
//   Role C — beforeAll で TEST_SUPERADMIN_EMAIL/PASSWORD からログインし superadmin.json を再生成

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const API = 'https://api.r2c.biz';
const ADMIN = 'https://admin.r2c.biz';
const DEMO_BASE = `${API}/carnation-demo`;
const USER_AUTH = 'tests/e2e/.auth/user.json';
const SA_AUTH = 'tests/e2e/.auth/superadmin.json';
const OWN_TENANT = 'carnation';
const FOREIGN_TENANT = 'r2c_default';

// ───────────────────────────────────────────────────────────────────────────
// Role A — 匿名公開API 異常系
// ───────────────────────────────────────────────────────────────────────────
test.describe('Irregular — Role A (anonymous public API)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  let apiKey = '';

  test.beforeAll(async ({ playwright }) => {
    // 公開ウィジェットに埋め込まれた tenant agent API キーを実配信HTMLから取得（秘匿情報ではない）
    const ctx = await playwright.request.newContext();
    const res = await ctx.get(`${DEMO_BASE}/index.html`);
    if (res.ok()) {
      const html = await res.text();
      const m = html.match(/data-api-key="([^"]+)"/);
      if (m) apiKey = m[1];
    }
    await ctx.dispose();
  });

  test('A-IRR-1: escalate をAPIキー無しで叩くと 401（テナント解決不可で拒否）', async ({ request }) => {
    const res = await request.post(`${API}/api/chat/escalate`, {
      data: { sessionId: 'irregular-nokey' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('A-IRR-2: escalate をデタラメなAPIキーで叩くと 401', async ({ request }) => {
    const res = await request.post(`${API}/api/chat/escalate`, {
      data: { sessionId: 'irregular-badkey' },
      headers: { 'content-type': 'application/json', 'x-api-key': 'rjc_totally_bogus_key_zzzz' },
    });
    expect(res.status()).toBe(401);
  });

  test('A-IRR-3: 2000字超のメッセージは 400（保存前にバリデーション拒否）', async ({ request }) => {
    expect(apiKey, 'anon api key extracted from demo html').not.toBe('');
    const res = await request.post(`${API}/api/chat`, {
      data: { message: 'あ'.repeat(2001) },
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      timeout: 20000,
    });
    expect(res.status()).toBe(400);
  });

  test('A-IRR-4: X-Tenant-ID ヘッダ偽装は無視され、応答は鍵のテナントにスコープされる', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.post(`${API}/api/chat`, {
      data: { message: 'こんにちは' },
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'X-Tenant-ID': FOREIGN_TENANT, // 偽装
      },
      timeout: 30000,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const resolvedTenant = body?.tenantId ?? body?.data?.tenantId;
    test.info().annotations.push({ type: 'resolved-tenant', description: String(resolvedTenant) });
    // ボディで指定した / ヘッダで偽装した FOREIGN_TENANT ではなく、鍵の carnation に解決されること
    expect(resolvedTenant).toBe(OWN_TENANT);
    expect(resolvedTenant).not.toBe(FOREIGN_TENANT);
  });

  test('A-IRR-5: escalate を空sessionIdで叩くと 400（DB変更前にバリデーション拒否＝非破壊）', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.post(`${API}/api/chat/escalate`, {
      data: { sessionId: '' },
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    });
    expect(res.status()).toBe(400);
  });

  test('A-IRR-6: poll を sessionId 無しで叩くと 400', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.get(`${API}/api/chat/poll`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(res.status()).toBe(400);
  });

  test('A-IRR-7: poll を未知のsessionIdで叩いても他人の会話は漏れず空配列', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.get(
      `${API}/api/chat/poll?sessionId=00000000-0000-0000-0000-000000000000`,
      { headers: { 'x-api-key': apiKey } },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.messages)).toBe(true);
    expect(body.messages.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Role B — client_admin 越境/RBAC 異常系（読取のみ）
// ───────────────────────────────────────────────────────────────────────────
test.describe('Irregular — Role B (client_admin RBAC/tenant boundary)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  async function gotoAdmin(page: any, path: string) {
    const apiCalls: string[] = [];
    page.on('request', (req: any) => {
      const u = req.url();
      if (u.includes('/v1/admin/')) apiCalls.push(u);
    });
    const res = await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1800);
    return { res, apiCalls };
  }

  test('B-IRR-1: super専用 /admin/tenants へ直URL → /admin へ弾かれる', async ({ page }) => {
    await gotoAdmin(page, '/admin/tenants');
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    expect(page.url()).not.toContain('/admin/tenants');
    expect(page.url()).toMatch(/\/admin\/?$/);
  });

  test('B-IRR-2: /admin/chat-history?tenant=<他テナント> でも自テナントにスコープされ越境しない', async ({ page }) => {
    const { apiCalls } = await gotoAdmin(page, `/admin/chat-history?tenant=${FOREIGN_TENANT}`);
    // client_admin は ?tenant= を無視し carnation に強制スコープされる（body/クエリ経由の指定禁止）
    const foreignLeak = apiCalls.some(
      (u) => u.includes(`tenant=${FOREIGN_TENANT}`) || u.includes(`tenantId=${FOREIGN_TENANT}`),
    );
    test.info().annotations.push({ type: 'admin-api-calls', description: JSON.stringify(apiCalls) });
    expect(foreignLeak).toBe(false);
  });

  test('B-IRR-3: 判明済みギャップ /admin/knowledge/books へ直URL到達しても他テナント選択UIは出ない', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/knowledge/books');
    // RequireAuth のため到達自体は許容され得る。実害＝クロステナント選択/データが出ないことを確認。
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    test.info().annotations.push({ type: 'status', description: String(res?.status()) });
    const selectCount = await page.locator('select').count();
    expect(selectCount).toBe(0); // テナント横断セレクタが出ない＝越境ビュー無し
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Role C — super_admin 横断アクセス + プレビュー中スコープ（既知ギャップ）
// ───────────────────────────────────────────────────────────────────────────
test.describe('Irregular — Role C (super_admin cross-tenant & preview)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  // super_admin の storageState は事前に superadmin.setup.ts で生成する（Role B の user.json と同方式）。
  // 生成済みトークンが有効セッションを含むかを確認し、無ければ skip。
  const fs = require('fs');
  let saReady = false;
  try {
    const raw = JSON.parse(fs.readFileSync(SA_AUTH, 'utf8'));
    const tokenEntry = raw?.origins?.[0]?.localStorage?.find((e: any) => /auth-token/.test(e.name));
    if (tokenEntry) {
      const parsed = JSON.parse(tokenEntry.value);
      // exp が未来（有効）か確認
      saReady = typeof parsed?.expires_at === 'number' && parsed.expires_at * 1000 > Date.now();
    }
  } catch {
    saReady = false;
  }

  test.use({ storageState: SA_AUTH });
  test.beforeEach(() => {
    test.skip(!saReady, 'super_admin storageState 未生成/期限切れ — superadmin.setup.ts を先に実行');
  });

  test('C-IRR-1: super_admin は super専用 /admin/tenants に到達できる（弾かれない）', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/tenants`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/admin/tenants');
    expect(page.url()).not.toContain('/login');
    const body = (await page.textContent('body')) ?? '';
    expect(body.length).toBeGreaterThan(0);
  });

  test('C-IRR-2: super_admin の共通ページには横断テナント選択UIが出る（client_adminとの差）', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/chat-history`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    // super_admin は全テナント集約ビュー → テナント選択セレクタ等の横断UIが存在するはず
    const selectCount = await page.locator('select').count();
    test.info().annotations.push({ type: 'select-count', description: String(selectCount) });
    expect(selectCount).toBeGreaterThan(0);
  });

  test('C-IRR-3: プレビュー導線の有無を確認（escalations/tuning のスコープ既知ギャップの足がかり）', async ({ page }) => {
    // テナント詳細を開き「クライアントビューで見る」導線が存在するかを確認する。
    // プレビュー状態は in-memory のため、ここでは導線の存在確認と、非プレビュー時の
    // escalations 横断ビュー挙動の観測に留める（完全なリーク再現は要seed fixtureのため別途）。
    await page.goto(`${ADMIN}/admin/tenants`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    const previewLink = page.getByText(/クライアントビュー|プレビュー|preview/i);
    const hasPreviewEntry = (await previewLink.count()) > 0;
    test.info().annotations.push({ type: 'preview-entry-found', description: String(hasPreviewEntry) });

    // 非プレビュー時: super_admin の escalations は横断ビュー（tenant scope=null）である想定。
    await page.goto(`${ADMIN}/admin/escalations`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/admin/escalations');
    expect(page.url()).not.toContain('/login');
  });
});
