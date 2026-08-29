// tests/e2e/qa-copilot-tenant-irregular.spec.ts
//
// テナントロールの /copilot-preview に対する「壊れやすいところを突く」E2E。
// 通るだけの正常系は qa-copilot-tenant-journey.spec.ts が持つ。こちらは
//   (a) 境界値・異常系(通信失敗・空・null・巨大・不正値・信頼できない入力)
//   (b) 店主が実際にやりがちなイレギュラー操作(連打・割り込み・リロード・戻る)
// に絞る。いずれも実ブラウザ(Chrome)で実際のUIを操作して確認する。
//
// 本番データを触らない理由は helpers/copilotTenantHarness.ts の冒頭コメント参照。

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_BASE_URL } from './config';
import {
  BOOTSTRAP_RULE,
  CopilotTenantHarness,
  PLACEHOLDER_IMAGE,
} from './helpers/copilotTenantHarness';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const USER_AUTH = 'tests/e2e/.auth/user.json';
const COMPOSER = '指示ルールを話しかけてみてください';

async function resetBrowserFlags(page: Page): Promise<void> {
  // addInitScript は「毎回のナビゲーション」で走る。無条件に消すと、リロード後の
  // 会話復元・「紹介は一度だけ」といった 2回目の起動を見るテストが成立しなくなる
  // (毎回まっさらな初回起動になってしまう)。タブ内で一度だけ実行する。
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('__e2e_flags_reset') === '1') return;
      sessionStorage.setItem('__e2e_flags_reset', '1');
      Object.keys(localStorage)
        .filter((k) => k.startsWith('r2c_tuning_rule_intro_shown_') || k === 'r2c_chat_first_default')
        .forEach((k) => localStorage.removeItem(k));
      sessionStorage.removeItem('r2c_chat_session_copilot-preview');
    } catch {
      /* プライベートブラウズ等 */
    }
  });
}

async function boot(
  page: Page,
  rules: Parameters<CopilotTenantHarness['chat']>[0],
  options: Parameters<CopilotTenantHarness['install']>[0] = {},
): Promise<CopilotTenantHarness> {
  await resetBrowserFlags(page);
  const h = new CopilotTenantHarness(page);
  // 既定は「段階を返さない」= 通常運用のテナント。FULLY_ONBOARDED にすると
  // 指示ルールの初回紹介がチップ付きで出て、選ぶまで左レールがロックされる。
  await h.install({ stage: null, ...options });
  // BOOTSTRAP_RULE は「最後の受け皿」として置く。先頭に置くと、起動時ブリーフィングを
  // わざと失敗させたいテスト(CT-I-C-2)が自分のルールに到達できない。
  h.chat([...rules, BOOTSTRAP_RULE]);
  await h.open(ADMIN_BASE_URL);
  // 送信ボタンは「起動時ブリーフィングが始まる直前」の一瞬も enabled のため、それだけを
  // 待つとテスト側の1手目とブリーフィングがレースする(件数比較が0起点になる)。
  // ブリーフィングの送信が記録されたことを確認してから先へ進む。
  await expect
    .poll(() => h.countMessages('ログインしたところです'), { timeout: 30000 })
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 30000 });
  return h;
}

/**
 * 左レールのカテゴリーボタン。
 * ボタンの中身は `<span>🎭</span><span>アバター</span>` の2つで、読み上げ名は絵文字込みの
 * 「🎭 アバター」になる。そのため name の完全一致(exact)では引けない。レール内に
 * スコープしたうえで部分一致で引く(7カテゴリーの名前は互いに部分文字列にならない)。
 */
function railButton(page: Page, label: string) {
  return page.locator('.cp-rail').getByRole('button', { name: label });
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder(COMPOSER).fill(text);
  await page.getByRole('button', { name: '送信' }).click();
}

// ───────────────────────────────────────────────────────────────────────────
// A. 連打・割り込み — 二重実行と取り違え
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-A 連打と割り込み', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-A-1: 送信ボタンを連打しても、同じ内容が二重に送られない', async ({ page }) => {
    const h = await boot(page, [{ when: '連打テスト', reply: { reply: '1回だけ受け取りました。' }, delayMs: 1500 }]);

    await page.getByPlaceholder(COMPOSER).fill('連打テスト');
    const button = page.getByRole('button', { name: '送信' });
    // 実際の店主の操作に近い速度で連打する
    await button.click();
    await button.click({ force: true }).catch(() => {});
    await button.click({ force: true }).catch(() => {});

    await expect(page.getByText('1回だけ受け取りました。')).toBeVisible({ timeout: 20000 });
    expect(h.countMessages('連打テスト')).toBe(1);
  });

  test('CT-I-A-2: Enter連打でも二重送信されず、送信中は入力欄が塞がる', async ({ page }) => {
    const h = await boot(page, [{ when: 'Enter連打', reply: { reply: '受け取りました。' }, delayMs: 1200 }]);

    const composer = page.getByPlaceholder(COMPOSER);
    await composer.fill('Enter連打');
    await composer.press('Enter');
    await composer.press('Enter').catch(() => {});
    await composer.press('Enter').catch(() => {});

    await expect(page.getByText('受け取りました。')).toBeVisible({ timeout: 20000 });
    expect(h.countMessages('Enter連打')).toBe(1);
  });

  test('CT-I-A-3: 応答待ちの間は他カテゴリーへ切り替えられない(応答が混ざらない)', async ({ page }) => {
    await boot(page, [
      { when: '今週の状況', reply: { reply: '今週のまとめです。' }, delayMs: 2500 },
    ]);

    await railButton(page, '今週のまとめ').click();
    // 応答待ちの間、他カテゴリーは押せない
    await expect(railButton(page, '知識データ')).toBeDisabled();
    await expect(railButton(page, 'アバター')).toBeDisabled();

    await expect(page.getByText('今週のまとめです。')).toBeVisible({ timeout: 20000 });
    // 応答が終われば自動的に解放される
    await expect(railButton(page, '知識データ')).toBeEnabled({
      timeout: 20000,
    });
  });

  test('CT-I-A-4: 選択待ちのチップが残っている間も、他カテゴリーへは移れない', async ({ page }) => {
    await boot(page, [
      {
        when: '指示ルールの状況',
        reply: {
          reply: '下書きを作りました。',
          actions: [
            { tool: 'suggest_tuning_rule', result: 'トリガー: 保証\n対応方針: 2年とお伝えする' },
          ],
        },
      },
    ]);

    await railButton(page, '指示ルール').click();
    await expect(page.getByRole('button', { name: '保存して' })).toBeVisible({ timeout: 20000 });
    // まだ「保存して/やめておく」を選んでいない = 会話が終わっていない
    await expect(railButton(page, 'アバター')).toBeDisabled();

    await page.getByRole('button', { name: 'やめておく' }).click();
    await expect(railButton(page, 'アバター')).toBeEnabled({
      timeout: 20000,
    });
  });

  test('CT-I-A-5: 「会話の履歴」を連打しても同じ質問が積み上がらない', async ({ page }) => {
    await boot(page, []);

    const history = railButton(page, '会話の履歴');
    await history.click();
    await history.click({ force: true }).catch(() => {});
    await history.click({ force: true }).catch(() => {});

    await expect(page.getByText('会話の履歴について、何をしますか？')).toHaveCount(1);
  });

  test('CT-I-A-6: 画像生成ボタンを連打しても、生成は1回しか走らない(課金の二重化を防ぐ)', async ({ page }) => {
    const h = await boot(page, [
      {
        when: 'アバター',
        reply: {
          reply: '採用しました。',
          actions: [
            {
              tool: 'adopt_avatar_preset',
              result: 'アバター「はるか」を採用しました',
              card: {
                kind: 'avatar_adopted',
                configId: 'cfg-1',
                name: 'はるか',
                imageUrl: null,
                description: '丁寧な話し方',
              },
            },
          ],
        },
      },
    ]);
    await h.stubAvatarBackend({ generateDelayMs: 2000 });

    await railButton(page, 'アバター').click();
    // 生成中はラベルが「生成しています…」に変わるので、両方を拾える名前で引く
    const generate = page.getByRole('button', { name: /画像を新しく生成する|生成しています/ });
    await expect(generate).toBeEnabled({ timeout: 20000 });
    await generate.click();

    // 押した直後にボタンが無効化され、そこから何度押しても2回目は飛ばない。
    // 【既知のすき間】無効化は React の state 更新なので、押下から再描画までの
    // ごく短い間に2発目が入ると2回走りうる(= fal.ai の課金も2回)。実測でも
    // 同一tickの連打では候補カードが2枚生成された。タイミング依存でテストにすると
    // 不安定になるため、ここでは「無効化後は効かない」ことだけを決定的に固定する。
    await expect(generate).toBeDisabled();
    await generate.click({ force: true }).catch(() => {});
    await generate.click({ force: true }).catch(() => {});

    await expect(page.getByText('新しい候補です')).toBeVisible({ timeout: 25000 });
    expect(h.countWrites('/fal/generate')).toBe(1);
  });

  test('CT-I-A-7: 候補画像を2枚まとめて押しても、採用は1件しか送られない', async ({ page }) => {
    const h = await boot(page, [
      {
        when: 'アバター',
        reply: {
          reply: '採用しました。',
          actions: [
            {
              tool: 'adopt_avatar_preset',
              result: 'アバター「はるか」を採用しました',
              card: {
                kind: 'avatar_adopted',
                configId: 'cfg-1',
                name: 'はるか',
                imageUrl: null,
                description: '丁寧な話し方',
              },
            },
          ],
        },
      },
    ]);
    await h.stubAvatarBackend();

    await railButton(page, 'アバター').click();
    await page.getByRole('button', { name: '画像を新しく生成する' }).click();
    await expect(page.getByText('新しい候補です')).toBeVisible({ timeout: 20000 });

    const adopt = page.getByRole('button', { name: 'これにする' });
    await adopt.nth(0).click();
    await adopt.nth(1).click({ force: true }).catch(() => {});

    await expect(page.getByRole('button', { name: 'これに決定' })).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/v1/admin/avatar/configs/')).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. 入力の境界値
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-B 入力の境界値', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-B-1: 空・空白のみの送信は何も起こさない', async ({ page }) => {
    const h = await boot(page, []);
    // boot() が起動時ブリーフィングの到着まで待つので、ここから増えないことを見れば足りる
    const before = h.chatCalls.length;

    await page.getByRole('button', { name: '送信' }).click();
    await page.getByPlaceholder(COMPOSER).fill('   \n\t  ');
    await page.getByRole('button', { name: '送信' }).click();

    await page.waitForTimeout(800);
    expect(h.chatCalls.length).toBe(before);
  });

  test('CT-I-B-2: Shift+Enterは改行、変換確定後のEnterは送信', async ({ page }) => {
    const h = await boot(page, [{ when: '1行目', reply: { reply: '受け取りました。' } }]);
    const composer = page.getByPlaceholder(COMPOSER);

    await composer.fill('1行目');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('2行目');
    expect(await composer.inputValue()).toContain('\n');
    expect(h.chatCalls.filter((c) => c.message.includes('1行目')).length).toBe(0);

    await composer.press('Enter');
    await expect(page.getByText('受け取りました。')).toBeVisible({ timeout: 20000 });
    expect(h.lastMessage()).toBe('1行目\n2行目');
  });

  test('CT-I-B-3: 1万字を貼り付けても入力欄が画面を食い潰さず、そのまま送れる', { tag: '@cross-browser' }, async ({ page }) => {
    const huge = 'あ'.repeat(10000);
    const h = await boot(page, [{ when: 'あああ', reply: { reply: '長文を受け取りました。' } }]);

    const composer = page.getByPlaceholder(COMPOSER);
    await composer.fill(huge);
    // 入力欄の高さは 140px で頭打ち(それ以上はスレッドを潰すため中でスクロールさせる)
    const height = await composer.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(141);

    await page.getByRole('button', { name: '送信' }).click();
    await expect(page.getByText('長文を受け取りました。')).toBeVisible({ timeout: 25000 });
    expect(h.lastMessage()?.length).toBe(10000);
  });

  test('CT-I-B-4: 入力欄を空に戻すと高さも1行分に戻る', async ({ page }) => {
    await boot(page, []);
    const composer = page.getByPlaceholder(COMPOSER);

    const initial = await composer.evaluate((el) => el.getBoundingClientRect().height);
    await composer.fill('あ\nい\nう\nえ\nお');
    const grown = await composer.evaluate((el) => el.getBoundingClientRect().height);
    expect(grown).toBeGreaterThan(initial);

    await composer.fill('');
    await expect
      .poll(() => composer.evaluate((el) => el.getBoundingClientRect().height))
      .toBeLessThanOrEqual(initial + 1);
  });

  test('CT-I-B-5: チップを無視して別の話題を打つと、古い選択肢は残らない', async ({ page }) => {
    const h = await boot(page, [
      {
        when: '指示ルールの状況',
        reply: {
          reply: '下書きです。',
          actions: [{ tool: 'suggest_tuning_rule', result: 'トリガー: 保証\n対応方針: 2年' }],
        },
      },
      { when: 'やっぱり別の話', reply: { reply: '別の話を承りました。' } },
    ]);

    await railButton(page, '指示ルール').click();
    await expect(page.getByRole('button', { name: '保存して' })).toBeVisible({ timeout: 20000 });

    await send(page, 'やっぱり別の話');
    await expect(page.getByText('別の話を承りました。')).toBeVisible({ timeout: 20000 });
    // 宙ぶらりんの「保存して」が新しい応答の横に残らない
    await expect(page.getByRole('button', { name: '保存して' })).toHaveCount(0);
    expect(h.lastMessage()).toBe('やっぱり別の話');
  });

  // shouldSubmitOnEnter(admin-ui/src/lib/utils.ts:16)の4条件のうち、keyCode 229
  // (isComposing を立てない古い/モバイルIMEが変換確定時に送るコード)は
  // utils.test.ts では合成イベントでしか検証できていない。本物のネイティブ
  // キーイベントとしてブラウザに実際に届くかをここで固定する。
  test('CT-I-B-6: keyCode 229を伴うEnterでは送信しない(古い/モバイルIME向けの保険)', async ({ page }) => {
    const h = await boot(page, [{ when: '意図しない送信', reply: { reply: 'これが届いたら壊れています。' } }]);

    const composer = page.getByPlaceholder(COMPOSER);
    await composer.fill('意図しない送信');
    await composer.focus();

    // React の合成イベントでは e.nativeEvent.keyCode を確実に229へ固定できないため、
    // CDP で「key は Enter・keyCode は 229」という実際のIMEが送る形のネイティブ
    // キーイベントを送る(compositionStart/Endを経由しない = isComposing は立たない
    // 経路そのものを再現する)。
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    });

    await page.waitForTimeout(500);
    expect(await composer.inputValue()).toBe('意図しない送信');
    expect(h.countMessages('意図しない送信')).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C. 通信の異常系
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-C 通信の異常系', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-C-1: 通信が切れても画面は壊れず、続けて送信できる', async ({ page }) => {
    const h = await boot(page, [
      { when: '切断テスト', abort: true, once: true },
      { when: '切断テスト', reply: { reply: '2回目は届きました。' } },
    ]);

    await send(page, '切断テスト');
    // 何らかのエラー文言が出て、送信ボタンが戻る(押せないまま固まらない)
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 20000 });

    await send(page, '切断テスト');
    await expect(page.getByText('2回目は届きました。')).toBeVisible({ timeout: 20000 });
    expect(h.countMessages('切断テスト')).toBe(2);
  });

  test('CT-I-C-2: 起動時ブリーフィングが失敗したら、リロードせずに再試行できる', async ({ page }) => {
    const h = await boot(page, [
      { when: 'ログインしたところです', status: 500, once: true },
      { when: 'ログインしたところです', reply: { reply: '今週は順調です。' } },
    ]);

    // silent送信(ユーザーが打った体でない自動送信)の失敗は、そのままだと復帰手段が
    // 画面リロードしかない。同じ文面を再送できるチップが出ること。
    const retry = page.getByRole('button', { name: 'もう一度試す' });
    await expect(retry).toBeVisible({ timeout: 25000 });
    await retry.click();
    await expect(page.getByText('今週は順調です。')).toBeVisible({ timeout: 20000 });
    expect(h.countMessages('ログインしたところです')).toBeGreaterThanOrEqual(2);
  });

  test('CT-I-C-3: サーバが5xxを返しても、そのまま次の操作へ進める', async ({ page }) => {
    await boot(page, [
      { when: '失敗する質問', status: 500 },
      { when: '成功する質問', reply: { reply: '今度は答えられました。' } },
    ]);

    await send(page, '失敗する質問');
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 20000 });
    await send(page, '成功する質問');
    await expect(page.getByText('今度は答えられました。')).toBeVisible({ timeout: 20000 });
  });

  test('CT-I-C-4: 応答が空でも空のバブルを残さない', async ({ page }) => {
    await boot(page, [{ when: '空応答', reply: { reply: '', actions: [] } }]);

    await send(page, '空応答');
    await expect(page.getByText('（応答なし）')).toBeVisible({ timeout: 20000 });
  });

  // authFetch(admin-ui/src/lib/api.ts)はトークンが取れないと Error("__AUTH_REQUIRED__")
  // を投げ、useAgentChatTransport がそれをログイン案内文へ振り分ける
  // (単体は useAgentChatTransport.test.ts:234 で検証済み)。ここでは「画面上に実際に
  // どう見えるか・それまでの会話が消えないか」だけを見る。
  test('CT-I-C-5: セッションが切れた状態で送るとログイン案内が出て、会話は消えない', async ({ page }) => {
    await boot(page, [{ when: '覚えていて', reply: { reply: '覚えました。' } }]);

    await send(page, '覚えていて');
    await expect(page.getByText('覚えました。')).toBeVisible({ timeout: 20000 });

    // supabase-js の自動リフレッシュ(getSessionToken)が実Supabaseへ到達しないよう
    // 先に確実な失敗で塞いでから、トークンをローカルから消す。
    await page.route('**/auth/v1/token**', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"invalid_grant"}' }),
    );
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter((k) => /^sb-.*-auth-token$/.test(k))
        .forEach((k) => localStorage.removeItem(k));
    });

    await send(page, 'これはもう届かないはず');
    await expect(
      page.getByText('ログインが必要です。別タブで管理画面にログインしてから、もう一度お試しください。'),
    ).toBeVisible({ timeout: 20000 });

    // 直前までの会話は消えていない
    await expect(page.getByText('覚えました。')).toBeVisible();
    await expect(page.getByText('覚えていて')).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D. サーバが返す値の境界(空・null・巨大・不正)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-D 返却値の境界', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-D-1: 指示ルール0件は空表示にせず、最初の一手を出す', async ({ page }) => {
    await boot(page, [
      {
        when: '指示ルールの状況',
        reply: {
          reply: 'まだありません。',
          actions: [
            { tool: 'get_tuning_rules', result: '0件', card: { kind: 'tuning_rules_list', rules: [], totalCount: 0 } },
          ],
        },
      },
    ]);

    await railButton(page, '指示ルール').click();
    await expect(page.getByText('指示ルールはまだありません')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: /最初のルールを作ってみる/ })).toBeVisible();
  });

  test('CT-I-D-2: 週次まとめの全指標がnullでも、空のカードにせず文で伝える', async ({ page }) => {
    await boot(page, [
      {
        when: '今週の状況',
        reply: {
          reply: '取得できませんでした。',
          actions: [
            {
              tool: 'get_weekly_briefing',
              result: '取得しました',
              card: {
                kind: 'weekly_summary',
                asOf: new Date().toISOString().slice(0, 10),
                sessions: null,
                avgScore: null,
                conversions: null,
                faq: null,
                pendingTuningRules: null,
                gaps: null,
                learned: null,
              },
            },
          ],
        },
      },
    ]);

    await railButton(page, '今週のまとめ').click();
    // 数字が1つも無いのに枠だけが出る状態にしない
    await expect(page.getByRole('button', { name: 'FAQにする' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '確認する' })).toHaveCount(0);
  });

  test('CT-I-D-3: 集計時点が不正な値でもクラッシュせず描画される', async ({ page }) => {
    await boot(page, [
      {
        when: '今週の状況',
        reply: {
          reply: 'まとめです。',
          actions: [
            {
              tool: 'get_weekly_briefing',
              result: '取得しました',
              card: {
                kind: 'weekly_summary',
                asOf: 'これは日付ではない',
                sessions: { total: 3, delta: 0 },
                avgScore: null,
                conversions: null,
                faq: null,
                pendingTuningRules: 0,
                // gaps は total と top の両方を持つのがサーバ側の契約。ここで見たいのは
                // asOf の不正値なので、それ以外は正常な形で渡す。
                gaps: { total: 0, top: [] },
                learned: null,
              },
            },
          ],
        },
      },
    ]);

    await railButton(page, '今週のまとめ').click();
    await expect(page.getByText('まとめです。')).toBeVisible({ timeout: 20000 });
    // 例外でスレッドごと落ちていないこと
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled();
  });

  test('CT-I-D-4: 300件の指示ルールを返しても描画され、操作を続けられる', async ({ page }) => {
    const rules = Array.from({ length: 300 }, (_, i) => ({
      id: i + 1,
      triggerPattern: `大量トリガー${i + 1}`,
      expectedBehavior: `振る舞い${i + 1}`,
      priority: 50,
      isActive: true,
      source: 'manual',
      status: 'active',
    }));
    await boot(page, [
      {
        when: '指示ルールの状況',
        reply: {
          reply: '300件あります。',
          actions: [
            { tool: 'get_tuning_rules', result: '取得', card: { kind: 'tuning_rules_list', rules, totalCount: 300 } },
          ],
        },
      },
    ]);

    await railButton(page, '指示ルール').click();
    await expect(page.getByText('大量トリガー300')).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled();
  });

  test('CT-I-D-5: 壊れたbase64の音声候補でも、ページ全体が落ちない', async ({ page }) => {
    const h = await boot(page, [
      {
        when: 'アバター',
        reply: {
          reply: '採用しました。',
          actions: [
            {
              tool: 'adopt_avatar_preset',
              result: 'アバター「はるか」を採用しました',
              card: {
                kind: 'avatar_adopted',
                configId: 'cfg-1',
                name: 'はるか',
                imageUrl: null,
                description: '丁寧な話し方',
              },
            },
          ],
        },
      },
    ]);
    await h.stubAvatarBackend({
      designCandidates: [{ id: 'broken-1', audioBase64: '!!!not-base64!!!', text: null }],
    });

    await railButton(page, 'アバター').click();
    await page.getByRole('button', { name: '声を作る' }).click();
    await expect(page.getByText('声の候補ができました')).toBeVisible({ timeout: 20000 });

    // atob が投げる経路。押しても画面が死なず、操作を続けられること
    await page.getByRole('button', { name: 'この声にする' }).first().click();
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 20000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E. 信頼できない入力(LLM出力・外部URL)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-E 信頼できない入力', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-E-1: AI応答に生HTMLが混ざってもDOMとして実行されず、文字としても出さない', async ({ page }) => {
    await boot(page, [
      {
        when: 'HTML混入',
        reply: { reply: 'これは<img src=x onerror="window.__xss=1">と<script>window.__xss2=1</script>です。' },
      },
    ]);

    await send(page, 'HTML混入');
    // タイプライター演出の最中は素のテキスト(=タグが文字として見える)。
    // skipHtml が効くのは演出完了後なので、必ず完了を待ってから判定する。
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 20000 });
    await expect(page.getByText('これは').first()).toBeVisible();

    // 1. DOM要素として生えていない
    expect(await page.locator('.cp-thread img').count()).toBe(0);
    // 2. スクリプトが走っていない
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__xss)).toBeUndefined();
    // 3. 生タグが文字としても出ていない(skipHtml)
    await expect(page.getByText('onerror')).toHaveCount(0);
  });

  test('CT-I-E-2: 別オリジンへの案内リンクは opener を渡さない(reverse tabnabbing)', async ({ page }) => {
    await boot(page, [
      {
        when: '外部リンク',
        reply: {
          reply: 'ご案内します。',
          actions: [
            {
              tool: 'get_legacy_ui_link',
              result: '外部',
              card: {
                kind: 'legacy_link',
                label: '外部サイト',
                url: 'https://example.com/evil',
                description: '別サイトです',
              },
            },
          ],
        },
      },
    ]);

    await send(page, '外部リンク');
    const link = page.getByRole('link', { name: /外部サイトを開く/ });
    await expect(link).toBeVisible({ timeout: 20000 });
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('CT-I-E-3: バックスラッシュで内部パスに見せかけた外部URLも外部として扱う', async ({ page }) => {
    await boot(page, [
      {
        when: '偽装リンク',
        reply: {
          reply: 'ご案内します。',
          actions: [
            {
              tool: 'get_legacy_ui_link',
              result: '偽装',
              card: {
                kind: 'legacy_link',
                label: '偽装',
                // WHATWG URL パーサは \\ を // に正規化するため、前方一致判定だと内部扱いになる
                url: '/\\evil.example.com/steal',
                description: '内部パスに見えるが別オリジン',
              },
            },
          ],
        },
      },
    ]);

    await send(page, '偽装リンク');
    const link = page.getByRole('link', { name: /偽装を開く/ });
    await expect(link).toBeVisible({ timeout: 20000 });
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F. 会話の持続(リロード・戻る・別タブ)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-F 会話の持続', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-F-1: リロードしても会話が消えず、起動時ブリーフィングを焚き直さない', { tag: '@cross-browser' }, async ({ page }) => {
    const h = await boot(page, [{ when: '覚えていて', reply: { reply: '覚えました。' } }]);

    await send(page, '覚えていて');
    await expect(page.getByText('覚えました。')).toBeVisible({ timeout: 20000 });
    // 保存はデバウンス(300ms)後に走る
    await page.waitForTimeout(800);

    const before = h.countMessages('ログインしたところです');
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByText('覚えました。')).toBeVisible({ timeout: 25000 });
    await expect(page.getByText('覚えていて')).toBeVisible();
    // 復元できたなら週次ブリーフィングを取り直さない(無駄な課金をしない)
    await page.waitForTimeout(1500);
    expect(h.countMessages('ログインしたところです')).toBe(before);
  });

  test('CT-I-F-2: 旧画面へ行って戻ってきても、会話が続きから読める', async ({ page }) => {
    await boot(page, [{ when: '旧画面に行く前の話', reply: { reply: '承知しました。' } }]);

    await send(page, '旧画面に行く前の話');
    await expect(page.getByText('承知しました。')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(800);

    // 別画面へ遷移 → ブラウザバックで戻る(店主が最もやる操作)
    await page.goto(`${ADMIN_BASE_URL}/admin/knowledge`, { waitUntil: 'domcontentloaded' });
    await page.goBack({ waitUntil: 'domcontentloaded' });

    await expect(page.getByText('承知しました。')).toBeVisible({ timeout: 25000 });
  });

  test('CT-I-F-3: from=legacy で戻ったが会話が無い場合、週次ブリーフィングを焚かない', async ({ page }) => {
    await resetBrowserFlags(page);
    const h = new CopilotTenantHarness(page);
    // 段階を返さない = オンボーディングの分岐も紹介も挟まらないので、
    // from=legacy の分岐だけを切り出して見られる。
    await h.install({ stage: null });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL, '?from=legacy');

    await expect(page.getByText('旧画面から戻られましたね')).toBeVisible({ timeout: 25000 });
    expect(h.countMessages('ログインしたところです')).toBe(0);
  });

  // chatSessionStore.ts の会話はタブ単位の sessionStorage。同一origin・同一
  // BrowserContext内でも sessionStorage はタブごとに独立している(localStorageと違い
  // 新規タブへ引き継がれない)ことを、実際に2枚のタブを開いて固定する。
  test('CT-I-F-4: 2枚目のタブで送信しても、1枚目の会話が壊れない', async ({ page, context }) => {
    await boot(page, [{ when: '1枚目からの質問', reply: { reply: '1枚目への返事です。' } }]);
    await send(page, '1枚目からの質問');
    await expect(page.getByText('1枚目への返事です。')).toBeVisible({ timeout: 20000 });

    const page2 = await context.newPage();
    await boot(page2, [{ when: '2枚目からの質問', reply: { reply: '2枚目への返事です。' } }]);
    await send(page2, '2枚目からの質問');
    await expect(page2.getByText('2枚目への返事です。')).toBeVisible({ timeout: 20000 });

    // 1枚目は2枚目の操作の影響を受けない(セッションはタブ単位)
    await expect(page.getByText('1枚目への返事です。')).toBeVisible();
    await expect(page.getByText('2枚目からの質問')).toHaveCount(0);
    await expect(page.getByText('2枚目への返事です。')).toHaveCount(0);

    await page2.close();
  });

  // restoreChatSession(chatSessionStore.ts)は sessionId が文字列・messages が配列で
  // あることしか検証しない。1件ごとの形(role/text vs role/content)までは見ないため、
  // 壊れた/別面の形のメッセージが紛れ込んでも「例外は出ないまま描画が壊れる」
  // (ファイル冒頭コメント参照)。少なくとも「ページ全体がクラッシュしない」ことを固定する。
  test('CT-I-F-5: 保存済み会話に不正な形のメッセージが混ざっていても、クラッシュせず開ける', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await boot(page, [{ when: '保存させる', reply: { reply: '保存しました。' } }]);
    await send(page, '保存させる');
    await expect(page.getByText('保存しました。')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(800); // saveChatSessionのデバウンス(300ms)を待つ

    // 実際に保存された sessionId・tenantId はそのまま使い(currentTenantId検証を
    // 通すため)、messages だけをパネル面(admin-agent-panel)の形(role:"user"/content、
    // 数値idもtextも無い)へ差し替える。
    await page.evaluate(() => {
      const key = 'r2c_chat_session_copilot-preview';
      const raw = JSON.parse(sessionStorage.getItem(key) as string);
      raw.messages = [
        { role: 'user', content: 'パネル形式の質問' },
        { role: 'assistant', content: 'パネル形式の回答' },
      ];
      sessionStorage.setItem(key, JSON.stringify(raw));
    });

    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('button', { name: '送信' })).toBeVisible({ timeout: 25000 });
    expect(pageErrors).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G. モバイル(狭い画面)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-G モバイル', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH, viewport: { width: 390, height: 844 } });

  test('CT-I-G-1: 左レールはドロワーになり、外側タップで閉じる', { tag: '@cross-browser' }, async ({ page }) => {
    await boot(page, []);

    // 初期状態でオーバーレイは無い
    await expect(page.locator('.cp-rail-backdrop')).toHaveCount(0);

    await page.getByRole('button', { name: 'メニューを開く' }).click();
    await expect(page.locator('.cp-rail-backdrop')).toHaveCount(1);
    await expect(page.locator('.cp-rail-open')).toHaveCount(1);

    // オーバーレイの中心はドロワー(幅248px)の真上に来てしまうので、
    // 実際に指が届く「ドロワーの外側」を明示して押す
    await page.locator('.cp-rail-backdrop').click({ position: { x: 340, y: 400 } });
    await expect(page.locator('.cp-rail-backdrop')).toHaveCount(0);
  });

  test('CT-I-G-2: カテゴリーを選ぶとドロワーが閉じ、会話が見える', async ({ page }) => {
    await boot(page, [{ when: '知識データの状況', reply: { reply: 'FAQは42件です。' } }]);

    await page.getByRole('button', { name: 'メニューを開く' }).click();
    await railButton(page, '知識データ').click();

    await expect(page.locator('.cp-rail-backdrop')).toHaveCount(0);
    await expect(page.getByText('FAQは42件です。')).toBeVisible({ timeout: 20000 });
  });

  test('CT-I-G-3: 狭い画面でも横スクロールが発生しない', { tag: '@cross-browser' }, async ({ page }) => {
    await boot(page, [
      {
        when: '長い応答',
        reply: {
          reply: `URLが折り返せない例: https://example.com/${'a'.repeat(200)}`,
        },
      },
    ]);

    await send(page, '長い応答');
    await expect(page.getByText('URLが折り返せない例', { exact: false })).toBeVisible({ timeout: 20000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// H. テナントの権限境界とシェル機能
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-H 権限境界とシェル', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-H-1: テナントには PROTOTYPE バッジを出さない(製品が試作品に見えないように)', async ({ page }) => {
    await boot(page, []);
    await expect(page.getByText('PROTOTYPE')).toHaveCount(0);
  });

  test('CT-I-H-2: 書籍PDFの取り込み口はテナントには出さない(R2C運用限定)', async ({ page }) => {
    await boot(page, []);

    await expect(page.getByRole('button', { name: 'PDFを添付' })).toHaveCount(0);
    await expect(page.locator('input[accept*="application/pdf"]')).toHaveCount(0);
    // 宣伝文言も出さない
    await expect(page.getByText('PDFはここへドラッグ＆ドロップできます')).toHaveCount(0);
  });

  test('CT-I-H-3: PDFを落としても通信せず、やわらかい日本語で断る', async ({ page }) => {
    const h = await boot(page, []);

    // ブラウザ既定の「ファイルを開く」に持っていかれないよう、受け皿自体は残っている
    // React はイベントをルートで受けて bubbling で配るため、コンポーザ内の要素へ
    // 発火させれば受け皿の onDrop まで届く(DOM構造の深さに依存しない)。
    await page.evaluate(() => {
      const composer = document.querySelector('.cp-composer-wrap textarea') as HTMLElement | null;
      if (!composer) throw new Error('コンポーザが見つかりません');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([37, 80, 68, 70])], 'manual.pdf', { type: 'application/pdf' }));
      composer.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    });

    await expect(page.getByText('PDFを受け取れませんでした')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/knowledge/book-pdf')).toBe(0);
    // 断られても会話は壊れない
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled();
  });

  test('CT-I-H-4: テーマ・言語・通知・アプリ切替がこの画面にも揃っている', async ({ page }) => {
    await boot(page, []);

    await expect(page.getByText('テーマ')).toBeVisible();
    // 旧UI(AppSidebar)と同じ3択。アイコンのみのボタンなので title が読み上げ名になる
    for (const name of ['ライト', 'ダーク', '自動']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // 押しても落ちない(Providerが無くても既定値で動く)。最後は自動に戻して後続へ影響させない
    await page.getByRole('button', { name: 'ダーク', exact: true }).click();
    await page.getByRole('button', { name: '自動', exact: true }).click();
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled();
  });

  test('CT-I-H-5: 「これを既定の画面にする」は通信が失敗しても巻き戻さない', async ({ page }) => {
    await resetBrowserFlags(page);
    const h = new CopilotTenantHarness(page);
    await h.install({ stage: null });
    h.chat([BOOTSTRAP_RULE]);
    // 計測だけの副回線。失敗してもトグルの見た目・保存値に影響してはならない
    await page.route('**/v1/admin/agent/ui-event', (route) => route.abort('failed'));
    await h.open(ADMIN_BASE_URL);

    await page.getByRole('button', { name: /これを既定の画面にする/ }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('r2c_chat_first_default')))
      .toBe('true');
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled();
  });

  // この画面には旧UIのサイドバーが無く、既定画面にすると「ログアウトできず詰む」不具合が
  // 実際に出た。ここでは到達性(存在・押せる状態・説明)までを確認し、押下はしない。
  // useAuth.logout は supabase.auth.signOut() を既定スコープ(global)で呼ぶため、
  // 押すと共有のE2Eアカウントのリフレッシュトークンが全端末で失効し、
  // tests/e2e/.auth/user.json を使う他の全specが道連れで落ちる。
  // 押下後に /login へ遷移する部分は index.test.tsx(vitest)が閉じて検証済み。
  test('CT-I-H-6: ログアウト手段がこの画面から届く(既定画面にしても詰まない)', async ({ page }) => {
    await boot(page, []);

    const logout = page.getByRole('button', { name: 'ログアウト' });
    await expect(logout).toBeVisible();
    await expect(logout).toBeEnabled();
    await expect(logout).toHaveAttribute('title', 'ログアウト');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I. 相談窓口(担当者とのやりとり)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-I 相談窓口', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-I-1: 解決しなかった質問を、その場で担当者へ相談できる', async ({ page }) => {
    const h = await boot(page, [{ when: '返品の締切は', reply: { reply: '30日です。' } }]);

    await send(page, '返品の締切は');
    await expect(page.getByText('30日です。')).toBeVisible({ timeout: 20000 });

    await expect(page.getByText('このお返事で解決しましたか？')).toBeVisible();
    await page.getByRole('button', { name: 'うまく解決しなかった' }).click();
    await expect(page.getByText('担当者に伝えました')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/v1/admin/feedback')).toBeGreaterThanOrEqual(1);
  });

  test('CT-I-I-2: 一度も質問していない状態では「解決しましたか？」を出さない', async ({ page }) => {
    await boot(page, []);
    await expect(page.getByText('このお返事で解決しましたか？')).toHaveCount(0);
  });

  test('CT-I-I-3: 担当者からのお返事はコンポーザの上に出て、解決すると次の1件へ繰り上がる', async ({ page }) => {
    await resetBrowserFlags(page);
    const h = new CopilotTenantHarness(page);
    await h.install({
      stage: null,
      feedbackReplies: [
        {
          id: 'fb-1',
          message: '設置方法が分かりません',
          reply_body: 'ヘッダーに1行貼るだけで動きます。',
          replied_at: '2026-08-25T09:00:00.000Z',
        },
        { id: 'fb-2', message: '料金について', reply_body: '請求は月末締めです。', replied_at: null },
      ],
    });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('担当者からお返事が届きました')).toBeVisible({ timeout: 25000 });
    await expect(page.getByText('ヘッダーに1行貼るだけで動きます。')).toBeVisible();
    // 1件だけ見せ、残りは件数で案内する
    await expect(page.getByText('＋あと1件')).toBeVisible();

    await page.getByRole('button', { name: '解決しました' }).click();
    // 既読化(PATCH)は非同期。押下直後に数えるとまだ飛んでいないことがある
    await expect
      .poll(() => h.countWrites('/v1/admin/feedback'), { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);
    // 1件目は消え、2件目が繰り上がる(残件があるうちは枠自体は残る)
    await expect(page.getByText('ヘッダーに1行貼るだけで動きます。')).toHaveCount(0);
    await expect(page.getByText('請求は月末締めです。')).toBeVisible();
    await expect(page.getByText('＋あと1件')).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// J. 不可逆操作の確認
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-I-J 不可逆操作', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-I-J-1: 会話の削除は確認を挟み、「やめておく」で本当に実行されない', async ({ page }) => {
    const h = await boot(page, [
      {
        when: '会話を削除して',
        reply: {
          reply: '確認させてください。',
          actions: [
            { tool: 'delete_chat_session', result: 'この操作は取り消せません。確認が必要です。' },
          ],
        },
      },
      { when: 'やめておきます', reply: { reply: 'かしこまりました。削除していません。' } },
    ]);

    await send(page, '会話を削除して');
    await expect(page.getByRole('button', { name: '削除して' })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'やめておく' }).click();
    await expect(page.getByText('削除していません')).toBeVisible({ timeout: 20000 });
    expect(h.lastMessage()).toBe('やめておきます');
    // 確認で止まった操作は「実際の操作」に数えない
    await expect(page.getByLabel('実際の操作 0件')).toBeVisible();
  });

  test('CT-I-J-2: 確認で止まった書き込みは進捗に数えない(連鎖ブロックも同様)', async ({ page }) => {
    await boot(page, [
      {
        when: 'まとめて消して',
        reply: {
          reply: '確認が必要です。',
          actions: [
            { tool: 'bulk_delete_faqs', result: '確認が必要です。よろしいですか。' },
            { tool: 'delete_faq', result: '同一ターンでは確認をスキップできません。' },
          ],
        },
      },
    ]);

    await send(page, 'まとめて消して');
    // 同じ文言がAIの発話とツール結果カードの両方に出る
    await expect(page.getByText('確認が必要です。').first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel('実際の操作 0件')).toBeVisible();
  });

  test('CT-I-J-3: 写真の差し替えは、受け付けない形式・大きさを通信前に断る', async ({ page }) => {
    const h = await boot(page, [
      {
        when: 'アバター',
        reply: {
          reply: '採用しました。',
          actions: [
            {
              tool: 'adopt_avatar_preset',
              result: 'アバター「はるか」を採用しました',
              card: {
                kind: 'avatar_adopted',
                configId: 'cfg-1',
                name: 'はるか',
                imageUrl: null,
                description: '丁寧な話し方',
              },
            },
          ],
        },
      },
    ]);
    await h.stubAvatarBackend();
    await railButton(page, 'アバター').click();
    await expect(page.getByRole('button', { name: '自分の写真を使う' })).toBeVisible({ timeout: 20000 });

    const input = 'input[accept="image/jpeg,image/png,image/webp"]';

    // 0バイト
    await page.setInputFiles(input, { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
    await expect(page.getByText('空のファイルは送信できませんでした')).toBeVisible({ timeout: 20000 });

    // 拡張子だけ画像に見せかけた別形式
    await page.setInputFiles(input, {
      name: 'fake.png',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await expect(page.getByText('JPG・PNG・WEBPの画像ファイルを送ってください')).toBeVisible({ timeout: 20000 });

    // 5MB超
    await page.setInputFiles(input, {
      name: 'big.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(page.getByText('5MB以下の画像にしてください')).toBeVisible({ timeout: 20000 });

    // ここまで一度も通信していない
    expect(h.countWrites('/v1/admin/avatar/configs/')).toBe(0);

    // 正常な画像は通る(境界の下側)
    await page.setInputFiles(input, {
      name: 'ok.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PLACEHOLDER_IMAGE.split(',')[1], 'base64'),
    });
    await expect(page.getByText('アバター画像を差し替えました')).toBeVisible({ timeout: 20000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// K. アクセシビリティ
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-A11Y アクセシビリティ', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  // 【不具合】共有コンポーネント3点の文字色がコントラスト比不足(WCAG 1.4.3、
  // axe-core: color-contrast, impact=serious)。Copilot UI固有ではなく、これらを
  // 使う旧UI(AppSidebar)側でも同じ色で描画されている可能性が高い。
  //   - components/AppSwitcher: ロックタブ「R2C2とは？...」ボタン
  //     実測コントラスト比 1.9(基準4.5)、fg #9cacb8 / bg #d7ebfa
  //   - copilot-preview/index.tsx:2311 Phase4DefaultToggle の補足文
  //     「このブラウザだけの設定です」実測コントラスト比 3.49(基準4.5)
  //   - components/LangSwitcher: 選択中の言語ボタン(🇯🇵 日本語 / 🇺🇸 English)
  //     実測コントラスト比 1.44(基準4.5)、選択色が緑文字 on 薄緑背景で近すぎる
  // 修正されたらこのテストが「予期せず成功」して落ちるので、そこで fail 指定を外すこと。
  test('CT-A11Y-1: デスクトップ通常表示にcritical/serious違反が無い', async ({ page }) => {
    test.fail();
    await boot(page, []);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);
  });

  // 【不具合】CT-A11Y-1と同一の3件(AppSwitcher / Phase4DefaultToggle / LangSwitcher)。
  // モバイルドロワー展開時も同じ色のまま描画されるため再現する。
  test('CT-A11Y-2: モバイルドロワー展開時にcritical/serious違反が無い', async ({ page }) => {
    test.fail();
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, []);
    await page.getByRole('button', { name: 'メニューを開く' }).click();
    await expect(page.locator('.cp-rail-backdrop')).toHaveCount(1);
    // .cp-rail はスライドイン中(transition: transform 0.2s ease, index.css:273)。
    // 遷移中に scan するとオフスクリーン扱いの一部要素が axe の可視性判定から漏れ、
    // color-contrast の検知が実行のたびに揺れる(実測)。完了まで待ってから scan する。
    await page.waitForTimeout(300);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const severe = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);
  });

  // Tab順で メニュー(モバイルのみ)→カテゴリ→コンポーザ→送信 に到達し、
  // チップがEnterで押せることを固定する。マウス操作前提のクリックしか無いUIだと、
  // キーボードだけの利用者(スクリーンリーダー含む)が操作できなくなる。
  test('CT-A11Y-3: キーボードだけでカテゴリ選択→送信まで到達できる', async ({ page }) => {
    await boot(page, [{ when: 'キーボードから送信', reply: { reply: 'キーボード操作を受け取りました。' } }]);

    await page.getByRole('button', { name: '指示ルール', exact: false }).first().focus();
    await page.keyboard.press('Enter');
    // カテゴリー切替(sendReal)の応答を待ってからコンポーザへ移る
    await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 20000 });

    await page.getByPlaceholder(COMPOSER).focus();
    await page.keyboard.type('キーボードから送信');
    await page.keyboard.press('Enter');

    await expect(page.getByText('キーボード操作を受け取りました。')).toBeVisible({ timeout: 20000 });
  });
});
