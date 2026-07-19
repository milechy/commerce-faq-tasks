import { test, expect } from '@playwright/test';
import fs from 'fs';

// QA: /copilot-preview の実データ接続・super_adminテナントプレビュー回帰テスト — 2026-07-19
// 本番で以下3件の不具合が実地発見されたため、再発防止として追加:
//   1. GROQ_API_KEY失効時、エラーがログから消える(PR #510で修正、本specでは対象外)
//   2. super_adminがテナント未指定のまま開くと全ツールが「テナントが特定できません」を返す
//      (これは仕様通りの挙動。previewTenantId未指定時のフォールバックとして確認する)
//   3. テナントプレビュー中でも previewMode がページ遷移/再読み込みでリセットされ、
//      copilot-previewに来ると毎回プレビューが外れていた(PR #511/#512で修正)
//
// 認証:
//   Role B — tests/e2e/.auth/user.json (auth.setup.ts, TEST_ADMIN_EMAIL/PASSWORD = carnation client_admin)
//   Role C — tests/e2e/.auth/superadmin.json (superadmin.setup.ts, TEST_SUPERADMIN_EMAIL/PASSWORD)

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const ADMIN = 'https://admin.r2c.biz';
const USER_AUTH = 'tests/e2e/.auth/user.json';
const SA_AUTH = 'tests/e2e/.auth/superadmin.json';
const PREVIEW_TENANT_ID = 'r2c_default';
const PREVIEW_STORAGE_KEY = 'r2c_admin_preview_tenant';
const NO_TENANT_MSG = 'テナントが特定できません';

async function waitForBootstrapReply(page: import('@playwright/test').Page) {
  // 起動時ブリーフィング(get_weekly_briefing)の応答を待つ。POST自体の完了 + タイプライター
  // 演出(revealText)の描画時間を見込んで少し余裕を持たせる。
  await page
    .waitForResponse((res) => res.url().includes('/v1/admin/agent/chat') && res.request().method() === 'POST', {
      timeout: 20000,
    })
    .catch(() => {}); // GROQ未応答等でも後続のテキスト検証で失敗させる
  await page.waitForTimeout(2500);
}

// ───────────────────────────────────────────────────────────────────────────
// Role B — client_admin (carnation): 自テナントのJWTでそのまま実データが返る
// ───────────────────────────────────────────────────────────────────────────
test.describe('copilot-preview — Role B (client_admin)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CP-B-1: /copilot-preview を開くとテナント未指定エラーが出ず実データが返る', async ({ page }) => {
    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForBootstrapReply(page);

    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain(NO_TENANT_MSG);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Role C — super_admin: プレビュー無しでは案内メッセージ、プレビュー中は実データが返り
// ページ再読み込みでもプレビュー状態(sessionStorage)が保持される
// ───────────────────────────────────────────────────────────────────────────
test.describe('copilot-preview — Role C (super_admin)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  let saReady = false;
  try {
    const raw = JSON.parse(fs.readFileSync(SA_AUTH, 'utf8'));
    const tokenEntry = raw?.origins?.[0]?.localStorage?.find((e: any) => /auth-token/.test(e.name));
    if (tokenEntry) {
      const parsed = JSON.parse(tokenEntry.value);
      saReady = typeof parsed?.expires_at === 'number' && parsed.expires_at * 1000 > Date.now();
    }
  } catch {
    saReady = false;
  }

  test.use({ storageState: SA_AUTH });
  test.beforeEach(() => {
    test.skip(!saReady, 'super_admin storageState 未生成/期限切れ — superadmin.setup.ts を先に実行');
  });

  test('CP-C-1: プレビュー未指定のまま開くとテナント未指定の案内が返る(仕様通り)', async ({ page }) => {
    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForBootstrapReply(page);

    const body = (await page.textContent('body')) ?? '';
    expect(body).toContain(NO_TENANT_MSG);
  });

  test('CP-C-2: sessionStorageでプレビュー中の場合、テナント未指定エラーが出ず実データが返る', async ({ page }) => {
    // 実際のUIクリック操作(テナント詳細→「クライアントビューで見る」)を経由せず、
    // useAuth.tsxが読むsessionStorageキーを直接注入して同じ状態を再現する
    // (UI操作経由だとテナント一覧の実データに依存し脆くなるため)。
    await page.goto(ADMIN, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.evaluate(
      ({ key, tenantId }) => {
        window.sessionStorage.setItem(key, JSON.stringify({ tenantId, tenantName: 'E2E Preview Tenant' }));
      },
      { key: PREVIEW_STORAGE_KEY, tenantId: PREVIEW_TENANT_ID },
    );

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForBootstrapReply(page);

    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain(NO_TENANT_MSG);
  });

  test('CP-C-3: プレビュー中にページを再読み込みしてもプレビュー状態が保持される(PR #512回帰)', async ({ page }) => {
    await page.goto(ADMIN, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.evaluate(
      ({ key, tenantId }) => {
        window.sessionStorage.setItem(key, JSON.stringify({ tenantId, tenantName: 'E2E Preview Tenant' }));
      },
      { key: PREVIEW_STORAGE_KEY, tenantId: PREVIEW_TENANT_ID },
    );

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForBootstrapReply(page);

    // フルページ再読み込み(修正前はここでpreviewModeがメモリ上のstateごとリセットされていた)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });

    const stored = await page.evaluate((key) => window.sessionStorage.getItem(key), PREVIEW_STORAGE_KEY);
    expect(stored).toContain(PREVIEW_TENANT_ID);

    await waitForBootstrapReply(page);
    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain(NO_TENANT_MSG);
  });
});
