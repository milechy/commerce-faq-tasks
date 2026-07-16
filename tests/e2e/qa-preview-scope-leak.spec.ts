import { test, expect } from '@playwright/test';

// 既知バグ再現: super_admin の「クライアントビューで見る」プレビュー中、escalations ページが
// previewTenantId でスコープされず全テナントの対応中会話を返してしまう（chat-history で修正された
// GID 1216277595663810 / PR #463 と同じパターンが escalations/index.tsx に未適用）。
//
// escalations/index.tsx:36 は `/v1/admin/chat-history/escalations` を tenant パラメータ無しで呼ぶ。
// preview はフロント専用(JWTは super_admin のまま)なので、バックエンドは全テナントを返す。
// → carnation をプレビュー中でも r2c_default 等の escalation が混入する。
//
// 実データ前提: escalations は carnation=9 / r2c_default=1（2026-07-17 時点）。r2c_default の1件が
// カナリア。プレビュー先=carnation の一覧にこれが出れば越境リーク。
//
// 注: preview 状態は useAuth の in-memory state（永続化なし）。投入後にページを reload すると状態が
// 消えるため、escalations へは SPA 内リンククリックで遷移する（page.goto は使わない）。

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const ADMIN = 'https://admin.r2c.biz';
const SA_AUTH = 'tests/e2e/.auth/superadmin.json';
const PREVIEW_TENANT = 'carnation';

// super_admin storageState の有効性チェック（未生成/期限切れなら skip）
const fs = require('fs');
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

test.describe('Preview scope leak (known bug) — escalations が preview テナントにスコープされない', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: SA_AUTH });
  test.beforeEach(() => {
    test.skip(!saReady, 'super_admin storageState 未生成/期限切れ');
  });

  test('C-LEAK-1: carnation プレビュー中の escalations に他テナント行が混入しない（現状=混入する）', async ({
    page,
  }) => {
    // 既知バグ: escalations/index.tsx が previewTenantId を見ずバックエンドJWTスコープに依存するため、
    // preview中も全テナントが返る。修正(chat-history と同じ previewTenantId スコープ適用)が入ると本
    // アサーションは通り、test.fail により「失敗するはずが成功」で赤くなる → 修正検知＆本注釈の除去合図。
    test.fail(true, '既知の preview スコープ漏洩バグ (escalations/index.tsx, GID 1216277595663810 と同パターン)');

    // 1. テナント詳細を開き、プレビュー投入
    await page.goto(`${ADMIN}/admin/tenants/${PREVIEW_TENANT}`, { waitUntil: 'domcontentloaded' });
    const previewBtn = page.getByRole('button', { name: /クライアントビューで見る/ });
    await previewBtn.waitFor({ timeout: 15000 });
    await previewBtn.click();

    // 2. プレビュー有効を確認（バナー表示）
    await expect(page.getByText(/プレビューモード|元に戻す/).first()).toBeVisible({ timeout: 10000 });

    // 3. SPA 内遷移で escalations へ（reload するとプレビュー状態が消えるため）
    const escResP = page.waitForResponse(
      (r) => r.url().includes('/v1/admin/chat-history/escalations') && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.getByText('対応中の会話').first().click();
    const escRes = await escResP;
    const body = await escRes.json();
    const rows: Array<{ tenant_id: string }> = body?.escalations ?? [];
    const tenants = rows.map((e) => e.tenant_id);
    const foreign = tenants.filter((t) => t !== PREVIEW_TENANT);

    test.info().annotations.push({ type: 'escalation-tenants', description: JSON.stringify(tenants) });

    // 正しい挙動: プレビュー先(carnation)のみが返る。
    expect(
      foreign,
      `プレビュー中(carnation)に他テナントの escalation が漏洩: ${JSON.stringify(foreign)}`,
    ).toHaveLength(0);
  });
});
