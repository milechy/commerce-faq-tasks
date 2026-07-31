import { test, expect } from '@playwright/test';
import { ADMIN_BASE_URL } from './config';

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
const ADMIN = ADMIN_BASE_URL;
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

  // C-LEAK-4: /copilot-preview のアバター関連ツール(get_avatar_list等)は previewMode 中、
  // targetTenantId をリクエストボディに明示的に付与して送る(docs/CHAT_SURFACE_DECISION.md §1.9
  // が指摘する「super_adminのtargetTenantId導出が2箇所別実装」の懸念に対する回帰ガード)。
  // C-LEAK-1〜3と異なりこのツールはテキスト応答のみでJSON構造化データを持たないため、
  // レスポンス本文からのテナント混入検査ではなく、リクエスト側のスコープ付与を検証する。
  test('C-LEAK-4: carnation プレビュー中の /copilot-preview で targetTenantId が正しく付与される(アバター一覧)', async ({
    page,
  }) => {
    // 1. テナント詳細を開き、プレビュー投入
    await page.goto(`${ADMIN}/admin/tenants/${PREVIEW_TENANT}`, { waitUntil: 'domcontentloaded' });
    const previewBtn = page.getByRole('button', { name: /クライアントビューで見る/ });
    await previewBtn.waitFor({ timeout: 15000 });
    await previewBtn.click();
    await expect(page.getByText(/プレビューモード|元に戻す/).first()).toBeVisible({ timeout: 10000 });

    // 2. SPA内リンククリックでチャットへ(page.gotoはpreview状態をリセットしてしまうため使わない)。
    // previewMode中は isClientAdmin が true になるため「AIチャットに戻る」導線が出る
    // (App.tsx の showAIChat 判定コメント参照)。
    await page.getByText('AIチャットに戻る').first().click();
    await page.waitForURL((url) => url.pathname === '/copilot-preview', { timeout: 15000 });
    await page
      .waitForResponse((r) => r.url().includes('/v1/admin/agent/chat') && r.request().method() === 'POST', { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // 3. アバター一覧を尋ね、リクエストボディの targetTenantId を検証
    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('アバターの一覧を見せて');
    const chatResP = page.waitForResponse(
      (r) => r.url().includes('/v1/admin/agent/chat') && r.request().method() === 'POST',
      { timeout: 20000 },
    );
    await send.click();
    const chatRes = await chatResP;
    const reqBody = JSON.parse(chatRes.request().postData() || '{}') as { targetTenantId?: string };

    test.info().annotations.push({ type: 'targetTenantId', description: String(reqBody.targetTenantId) });
    expect(reqBody.targetTenantId).toBe(PREVIEW_TENANT);
    expect(reqBody.targetTenantId).not.toBe(PREVIEW_TENANT_2);

    // 4. テナント未特定エラーに落ちていない(=正しくスコープ解決できている)こと
    await page.waitForTimeout(1500);
    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain('テナントが特定できません');
  });

  // C-LEAK-5: /copilot-preview の画像生成(fal/generate)・声検索(match-voice)は
  // エージェントツール経由でなくチャットUIから直接fetchするため、C-LEAK-4の
  // targetTenantId自動付与の対象外(#P0-2で発見・是正)。previewMode中に
  // ?tenant=<プレビュー対象テナント> が付かないと、fal.ai/Fish Audioの実費用が
  // 操作対象テナントではなくsuper_admin自身に誤課金される。
  // agent/chatは実LLMのツール選択に依存させると、carnationの実際のアバター
  // 保有状況次第で見本提案が出ない(既に採用済み等)フローに揺れうるため、
  // qa-copilot-preview.spec.ts の CP-B-3 と同じ理由でモックし決定論的にする。
  // fal/generate・match-voiceも同じ理由(実課金)でモックし、送信URLだけを検証する。
  test('C-LEAK-5: carnation プレビュー中、fal/generate・match-voiceのURLに?tenant=が付与される', async ({
    page,
  }) => {
    let chatCalls = 0;
    await page.route('**/v1/admin/agent/chat', async (route) => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '今週も順調です。', actions: [] }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply: '採用しました。',
          actions: [{
            tool: 'adopt_avatar_preset',
            result: 'アバター「Haruka」を採用しました。まだ公開はされていません。',
            card: { kind: 'avatar_adopted', configId: 'cfg-leak5-1', name: 'Haruka', imageUrl: null, description: 'とても丁寧な性格です。' },
          }],
        }),
      });
    });

    let generateUrl: string | null = null;
    let matchVoiceUrl: string | null = null;
    await page.route('**/v1/admin/avatar/fal/generate*', (route) => {
      generateUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ images: ['https://img.example/1.png'] }),
      });
    });
    await page.route('**/v1/admin/avatar/match-voice*', (route) => {
      matchVoiceUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recommendations: [{ id: 'voice-e2e-1', title: 'Haruka Voice', description: '明るい声', score: 0.9 }] }),
      });
    });

    // 1. テナント詳細を開き、プレビュー投入
    await page.goto(`${ADMIN}/admin/tenants/${PREVIEW_TENANT}`, { waitUntil: 'domcontentloaded' });
    const previewBtn = page.getByRole('button', { name: /クライアントビューで見る/ });
    await previewBtn.waitFor({ timeout: 15000 });
    await previewBtn.click();
    await expect(page.getByText(/プレビューモード|元に戻す/).first()).toBeVisible({ timeout: 10000 });

    // 2. SPA内リンククリックでチャットへ(C-LEAK-4と同じ理由でpage.gotoは使わない)
    await page.getByText('AIチャットに戻る').first().click();
    await page.waitForURL((url) => url.pathname === '/copilot-preview', { timeout: 15000 });
    await page.waitForResponse((r) => r.url().includes('/v1/admin/agent/chat') && r.request().method() === 'POST', { timeout: 20000 });

    // 3. アバターを採用済みの状態にする(agent/chatはモック済みなので実LLMの揺れなし)
    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('採用してください');
    await send.click();
    const generateBtn = page.getByRole('button', { name: '画像を新しく生成する' }).first();
    await generateBtn.waitFor({ timeout: 15000 });

    // 4. 画像生成・声探しボタンをクリックしてモックへのリクエストURLを捕捉
    await generateBtn.click();
    await page.waitForTimeout(1000);
    const voiceBtn = page.getByRole('button', { name: '声を探す' }).first();
    await voiceBtn.waitFor({ timeout: 10000 });
    await voiceBtn.click();
    await page.waitForTimeout(1000);

    test.info().annotations.push({ type: 'fal-generate-url', description: String(generateUrl) });
    test.info().annotations.push({ type: 'match-voice-url', description: String(matchVoiceUrl) });
    expect(generateUrl).toContain(`tenant=${PREVIEW_TENANT}`);
    expect(matchVoiceUrl).toContain(`tenant=${PREVIEW_TENANT}`);
  });
});
