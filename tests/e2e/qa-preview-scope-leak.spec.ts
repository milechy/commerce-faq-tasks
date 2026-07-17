import { test, expect } from '@playwright/test';

// 回帰検知用: super_admin の「クライアントビューで見る」プレビュー中に previewTenantId が
// 正しく使われず、テナントスコープが壊れる/画面が空白になる不具合の恒久テスト群。
//
// C-LEAK-1: escalations が previewTenantId でスコープされず全テナントの対応中会話を返す不具合
//   (chat-history で修正済みの GID 1216277595663810 / PR #463 と同パターンが escalations/index.tsx
//   に未適用だった)。GID 1216643716725652 / PR #480 で修正・デプロイ確認済み(2026-07-17)。
// C-LEAK-2: 「AIの知識データ」ナビ(AppSidebar.tsx)がリンク生成時に previewTenantId を見ず
//   `/admin/knowledge/`(空のtenantId)になり画面が白紙になる不具合。
//   GID 1216646499090814 / PR #481 で修正・デプロイ確認済み(2026-07-17)。
// C-LEAK-3: テストチャット(chat-test/index.tsx)の avatar/configs 取得が previewTenantId を
//   見ず tenant未指定で叩かれ、全テナント混在の一覧から他テナントのアバターが誤選択され
//   アバターに接続できない不具合。GID 1216646748578275 / PR #483 で修正・デプロイ確認済み(2026-07-17)。
//
// 注: preview 状態は useAuth の in-memory state（永続化なし）。投入後にページを reload すると状態が
// 消えるため、各ページへは SPA 内リンククリックで遷移する（page.goto は使わない）。

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const ADMIN = 'https://admin.r2c.biz';
const SA_AUTH = 'tests/e2e/.auth/superadmin.json';
const PREVIEW_TENANT = 'carnation';
const PREVIEW_TENANT_2 = 'lp-demo';

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

  test('C-LEAK-1: carnation プレビュー中の escalations に他テナント行が混入しない', async ({
    page,
  }) => {
    // GID 1216643716725652 で修正済み（chat-history と同じ previewTenantId スコープを
    // escalations/index.tsx に適用）。本番(admin.r2c.biz)で2026-07-17 に修正のデプロイと
    // green化を確認済み。回帰検知用の固定テストとして残す。

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

  test('C-LEAK-2: lp-demo プレビュー中に「AIの知識データ」を開くと白紙にならず正しいテナントで表示される', async ({
    page,
  }) => {
    // 1. テナント詳細を開き、プレビュー投入
    await page.goto(`${ADMIN}/admin/tenants/${PREVIEW_TENANT_2}`, { waitUntil: 'domcontentloaded' });
    const previewBtn = page.getByRole('button', { name: /クライアントビューで見る/ });
    await previewBtn.waitFor({ timeout: 15000 });
    await previewBtn.click();
    await expect(page.getByText(/プレビューモード|元に戻す/).first()).toBeVisible({ timeout: 10000 });

    // 2. SPA内リンククリックでナレッジへ（page.gotoはpreview状態をリセットしてしまうため使わない）
    await page.getByText('AIの知識データ').first().click();
    await page.waitForTimeout(1500);

    // 3. URLがプレビュー先テナントに正しく解決されていること（空文字にフォールバックしない）
    expect(page.url()).toBe(`${ADMIN}/admin/knowledge/${PREVIEW_TENANT_2}`);

    // 4. 画面が白紙(不具合時 body長 ~200字)ではなく、ナレッジUI(タブ等)が描画されていること
    await expect(page.getByText('ナレッジ一覧')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /テキスト入力/ })).toBeVisible();
  });

  test('C-LEAK-3: lp-demo プレビュー中のテストチャットで avatar/configs が他テナント混在にならない', async ({
    page,
  }) => {
    // 1. テナント詳細を開き、プレビュー投入
    await page.goto(`${ADMIN}/admin/tenants/${PREVIEW_TENANT_2}`, { waitUntil: 'domcontentloaded' });
    const previewBtn = page.getByRole('button', { name: /クライアントビューで見る/ });
    await previewBtn.waitFor({ timeout: 15000 });
    await previewBtn.click();
    await expect(page.getByText(/プレビューモード|元に戻す/).first()).toBeVisible({ timeout: 10000 });

    // 2. SPA内リンククリックでテストチャットへ（page.gotoはpreview状態をリセットしてしまうため使わない）
    const configsResP = page.waitForResponse(
      (r) => r.url().includes('/v1/admin/avatar/configs') && r.request().method() === 'GET',
      { timeout: 15000 },
    );
    await page.getByText('テストチャット').first().click();
    const configsRes = await configsResP;

    // 3. リクエストにプレビュー先テナントが明示的に付与されていること
    expect(configsRes.url()).toContain(`tenant=${PREVIEW_TENANT_2}`);

    // 4. 返る一覧がプレビュー先テナント + 共用の r2c_default のみで、他テナントが混入しないこと
    const body = await configsRes.json();
    const tenantIds: string[] = [...new Set((body.configs ?? []).map((c: { tenant_id: string }) => c.tenant_id))];
    const foreign = tenantIds.filter((t) => t !== PREVIEW_TENANT_2 && t !== 'r2c_default');
    test.info().annotations.push({ type: 'avatar-config-tenants', description: JSON.stringify(tenantIds) });
    expect(
      foreign,
      `プレビュー中(lp-demo)に他テナントのアバター設定が漏洩: ${JSON.stringify(foreign)}`,
    ).toHaveLength(0);
  });
});
