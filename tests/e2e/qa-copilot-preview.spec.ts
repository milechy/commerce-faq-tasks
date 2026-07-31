import { test, expect } from '@playwright/test';
import fs from 'fs';
import { ADMIN_BASE_URL } from './config';

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
const ADMIN = ADMIN_BASE_URL;
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

  // CP-B-3: アバター設定フローの完走（未作成 → 推奨提示 → 採用 → 画像 → 声 → 有効化 → ライブテスト）。
  // /v1/admin/agent/chat・fal/generate・match-voice・configs PATCH をすべてモックする。理由は3つ:
  //   (1) 実LLM(Groq)のツール選択の揺れに依存させず決定論的にする
  //   (2) fal.ai/Fish Audioへの実課金(#594で計上対応済みだが、CI実行毎に発生させる理由が無い)を発生させない
  //   (3) carnationの実 avatar_configs を本番でCI実行のたびに書き換えない(このファイルの
  //       他テストと同じ「実データで読む」前提を、書き込みを伴うこのテストにまで広げない)
  // widget-fab-avatar.spec.ts が anam-session/room-token を同じ理由でモックしている先例に倣う。
  // 検証したいのはUIの実配線(クリック→カード遷移→PATCH送出→復元)であって、LLM/外部APIの
  // 中身そのものではないため、モックはこの目的に対して妥当な選択である。
  test('CP-B-3: 未作成テナントが会話だけで公開まで到達し、離脱はライブテストの1回だけ', async ({ page, context }) => {
    let chatCalls = 0;
    const chatMessages: string[] = [];

    await page.route('**/v1/admin/agent/chat', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}') as { message?: string };
      chatCalls += 1;
      chatMessages.push(body.message ?? '');

      if (chatCalls === 1) {
        // 起動時ブリーフィング
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '今週も順調です。', actions: [] }) });
      }
      if (body.message?.includes('アバターを作りたい')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: '見本をご提案しました。',
            actions: [{
              tool: 'suggest_avatar_preset',
              result: '「Haruka」というアバターの見本があります。\nプリセットID: preset-e2e-1\nこのまま採用しますか？',
              card: { kind: 'avatar_preset', presetId: 'preset-e2e-1', name: 'Haruka', imageUrl: null, description: 'とても丁寧な性格です。' },
            }],
          }),
        });
      }
      if (body.message === '採用してください') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: '採用しました。',
            actions: [{
              tool: 'adopt_avatar_preset',
              result: 'アバター「Haruka」を採用しました。まだ公開はされていません。',
              card: { kind: 'avatar_adopted', configId: 'cfg-e2e-1', name: 'Haruka', imageUrl: null, description: 'とても丁寧な性格です。' },
            }],
          }),
        });
      }
      if (body.message?.includes('有効化して')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ reply: '有効化しました。', actions: [{ tool: 'activate_avatar', result: 'アバター（ID: cfg-e2e-1）を有効化しました' }] }),
        });
      }
      if (body.message?.includes('テストチャットで確認したい')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: 'テストチャットをご案内しました。',
            actions: [{
              tool: 'get_legacy_ui_link',
              result: 'この操作はテストチャット画面から行えます。',
              card: { kind: 'legacy_link', label: 'テストチャット', url: '/admin/chat-test', description: '設定した内容を実際のチャットで試すのはこちらの画面で行えます' },
            }],
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '了解しました。', actions: [] }) });
    });

    await page.route('**/v1/admin/avatar/fal/generate', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ images: ['https://img.example/1.png', 'https://img.example/2.png', 'https://img.example/3.png', 'https://img.example/4.png'] }),
      }),
    );
    await page.route('**/v1/admin/avatar/match-voice', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recommendations: [{ id: 'voice-e2e-1', title: 'Haruka Voice', description: '明るく親しみやすい声', score: 0.9 }] }),
      }),
    );
    let patchCount = 0;
    await page.route('**/v1/admin/avatar/configs/cfg-e2e-1', (route) => {
      if (route.request().method() === 'PATCH') {
        patchCount += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'cfg-e2e-1' }) });
      }
      return route.continue();
    });

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForBootstrapReply(page);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');

    // ① 未作成 → 推奨提示
    await composer.fill('アバターを作りたい');
    await send.click();
    await expect(page.getByRole('button', { name: '採用して' })).toBeVisible({ timeout: 10000 });

    // ② 採用（チップ経由）
    await page.getByRole('button', { name: '採用して' }).click();
    await expect(page.getByRole('button', { name: '画像を新しく生成する' })).toBeVisible({ timeout: 10000 });

    // ③ 画像候補の生成・採用
    await page.getByRole('button', { name: '画像を新しく生成する' }).click();
    await expect(page.getByRole('button', { name: 'これにする' }).first()).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'これにする' }).first().click();
    await expect(page.getByRole('button', { name: 'これに決定' })).toBeVisible({ timeout: 10000 });

    // ④ 声の候補の検索・採用
    await page.getByRole('button', { name: '声を探す' }).click();
    await expect(page.getByRole('button', { name: 'この声にする' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'この声にする' }).click();
    // 「Haruka Voice」は候補提示の時点で既に表示されているため、それだけでは採用完了の
    // 証拠にならない。「これに決定」が画像・声で2つに増えたことをもって採用完了を待つ。
    await expect(page.getByRole('button', { name: 'これに決定' })).toHaveCount(2, { timeout: 10000 });

    expect(patchCount).toBe(2); // 画像1回 + 声1回。二重PATCHが起きていないこと

    // ⑤ 有効化（公開）
    await composer.fill('アバターを有効化してください');
    await send.click();
    // モック応答の reply(「有効化しました。」)と、agentActionカードの result
    // (「アバター（ID: cfg-e2e-1）を有効化しました」句点なし)の両方が"有効化しました"を
    // 含むため、緩い正規表現だと strict mode violation(複数要素にマッチ)になる。
    // アシスタントの返信バブル(句点まで含めた完全一致)だけを狙う。
    await expect(page.getByText('有効化しました。', { exact: true })).toBeVisible({ timeout: 10000 });

    // ⑥ ライブテストへの受け渡し（唯一の離脱点）。別タブで開き、この会話は残ったままであること。
    await composer.fill('テストチャットで確認したい');
    await send.click();
    const linkPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: /テストチャットを開く/ }).click();
    const newTab = await linkPromise;
    await newTab.waitForLoadState('domcontentloaded');
    expect(newTab.url()).toContain('/admin/chat-test');
    await newTab.close();

    // 別タブに離脱しただけで、元の会話(アシスタントの発言・カード群)はそのまま残っている
    expect(page.url()).toContain('/copilot-preview');
    await expect(page.getByText('Haruka Voice')).toBeVisible();
  });

  // GID 1217040318322843: 週次まとめカード(指標が5〜6個並ぶ)が最も崩れやすいカードのため、
  // 390pxモバイルビューポート(CLAUDE.md Mobile First)で個別に確認する。
  test.describe('390pxモバイルビューポート', () => {
    test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 Pro

    test('CP-B-2: 起動時ブリーフィングの週次まとめカードが横スクロールを出さずに描画される', async ({ page }) => {
      await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForBootstrapReply(page);

      const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyScrollWidth).toBeLessThanOrEqual(400); // 10px tolerance

      const body = (await page.textContent('body')) ?? '';
      expect(body).not.toContain(NO_TENANT_MSG);
    });

    // P6-1: 新規テナントが旧UI /admin/tuning に一度も行かずに、指示ルールの初回紹介 →
    // 提案 → 保存 → 一覧確認まで /copilot-preview だけで完結できることの受け入れ確認。
    // my-tenant(オンボーディング判定)とagent/chatをモックし、実LLM/実carnationデータの
    // 書き換えに依存させない(CP-B-3のコメントと同じ理由)。
    test('CP-B-4 (P6-1): 4段階完了直後の紹介から、旧UIに行かずに指示ルールを作成・確認できる', async ({ page }) => {
      await page.route('**/v1/admin/my-tenant', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            onboarding_stage: { industryAnswered: true, knowledgePublished: true, widgetInstalled: true, firstConversation: true },
          }),
        }),
      );
      await page.route('**/v1/admin/agent/chat', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}') as { message?: string };
        if (body.message?.includes('指示ルールを初めて作ります')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              reply: '提案:\nトリガー: 保証\n対応方針: 保証期間は2年とお伝えする\n優先度: 5\nこの内容でよいか確認し、同意が得られたら保存します。',
              actions: [{
                tool: 'suggest_tuning_rule',
                result: '提案:\nトリガー: 保証\n対応方針: 保証期間は2年とお伝えする\n優先度: 5',
                card: { kind: 'tuning_rule_draft', triggerPattern: '保証', expectedBehavior: '保証期間は2年とお伝えする', priority: 5 },
              }],
            }),
          });
        }
        if (body.message === '保存してください') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              reply: '保存しました。',
              actions: [{ tool: 'save_tuning_rule', result: '指示ルールを保存しました（ID: 999）: 「保証」→ 保証期間は2年とお伝えする' }],
            }),
          });
        }
        if (body.message === '指示ルールの状況を教えて') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              reply: '1件あります。',
              actions: [{
                tool: 'get_tuning_rules',
                result: '指示ルール一覧（1件、うち有効1件・無効0件）です。',
                card: {
                  kind: 'tuning_rules_list',
                  totalCount: 1,
                  rules: [{ id: 999, triggerPattern: '保証', expectedBehavior: '保証期間は2年とお伝えする', priority: 5, isActive: true, source: 'manual', status: null, evidence: null }],
                },
              }],
            }),
          });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '了解しました。', actions: [] }) });
      });

      // DIAGNOSTIC (temporary, to be reverted): capture my-tenant/agent-chat responses and
      // localStorage state to debug why the P6-1 intro nudge doesn't appear in CI.
      const diagResponses: string[] = [];
      page.on('response', (res) => {
        const u = res.url();
        if (u.includes('my-tenant') || u.includes('agent/chat')) {
          res.text().then((body) => {
            diagResponses.push(`${res.status()} ${u} :: ${body.slice(0, 300)}`);
          }).catch(() => {});
        }
      });

      await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(5000);
      console.log('[DIAG] responses:', JSON.stringify(diagResponses, null, 2));
      console.log('[DIAG] localStorage keys:', await page.evaluate(() => Object.keys(window.localStorage)));
      console.log('[DIAG] body text:', (await page.textContent('body'))?.slice(0, 1500));
      console.log('[DIAG] jwt payload:', await page.evaluate(() => {
        try {
          const key = Object.keys(window.localStorage).find((k) => k.includes('auth-token'));
          if (!key) return 'NO_AUTH_TOKEN_KEY';
          const raw = window.localStorage.getItem(key);
          const parsed = JSON.parse(raw || '{}');
          const accessToken = parsed?.access_token as string | undefined;
          if (!accessToken) return 'NO_ACCESS_TOKEN';
          const payloadB64 = accessToken.split('.')[1];
          return JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
        } catch (e) {
          return 'ERROR: ' + String(e);
        }
      }));

      // 週次ブリーフィングの代わりに、指示ルールの初回紹介が出る
      await expect(page.getByText(/最初のルールを作ってみますか/)).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: '🎛️ 作ってみる' }).click();

      // 提案 → 保存(チップ経由)
      await expect(page.getByText('保証期間は2年とお伝えする')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: '保存して' }).click();
      await expect(page.getByText('保存しました。', { exact: true })).toBeVisible({ timeout: 10000 });

      // 一覧で作成したルールを確認できる(旧UI /admin/tuning への誘導は出ない)
      const composer = page.getByPlaceholder(/指示ルール/);
      const send = page.getByLabel('送信');
      await composer.fill('指示ルールの状況を教えて');
      await send.click();
      await expect(page.getByText('指示ルール一覧（1件）', { exact: false })).toBeVisible({ timeout: 10000 });
      expect((await page.textContent('body')) ?? '').not.toContain('/admin/tuning');

      const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyScrollWidth).toBeLessThanOrEqual(400); // 10px tolerance
    });
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
