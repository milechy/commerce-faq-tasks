// tests/e2e/qa-copilot-tenant-journey.spec.ts
//
// テナントロール(client_admin)で /copilot-preview を、新規アカウント作成直後から
// 通常運用まで通しで検証する。実ブラウザ(Chrome)で実際のUIを描画して操作する。
//
// 【この spec の立ち位置】
// admin-ui/src/pages/copilot-preview/index.test.tsx (vitest, 232件) が
// 「関数レベルの分岐」を押さえているのに対し、こちらは
//   - 実ブラウザでの描画・レイアウト・ドロワー・リロード復元
//   - 送出内容(何をサーバへ送ったか)
//   - 画面をまたぐ順序(オンボーディング4段階 → 通常運用)
// を押さえる。vitest と重複する主張はここでは繰り返さない。
//
// 【本番データを触らない理由】helpers/copilotTenantHarness.ts の冒頭コメント参照。
// 【実テナント作成の可否】helpers/newTenantAccount.ts の冒頭コメント参照。

import { test, expect, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './config';
import {
  BRAND_NEW_ACCOUNT_STAGE,
  BOOTSTRAP_RULE,
  CopilotTenantHarness,
  FULLY_ONBOARDED_STAGE,
  PLACEHOLDER_IMAGE,
  TINY_WAV_BASE64,
} from './helpers/copilotTenantHarness';
import { realProvisioningBlockedReason, simulatedNewTenant } from './helpers/newTenantAccount';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const USER_AUTH = 'tests/e2e/.auth/user.json';

const COMPOSER = '指示ルールを話しかけてみてください';

// ───────────────────────────────────────────────────────────────────────────
// 共通操作
// ───────────────────────────────────────────────────────────────────────────

/** 自由入力欄から送る。送信可能になるまで待ってから打つ(起動時ブリーフィングとの競合回避)。 */
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
  const button = page.getByRole('button', { name: '送信' });
  await expect(button).toBeEnabled({ timeout: 20000 });
  await page.getByPlaceholder(COMPOSER).fill(text);
  await button.click();
}

/** 応答待ち・タイプライター演出の完了まで待つ。 */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '送信' })).toBeEnabled({ timeout: 20000 });
}

/** チップ(提案の確定ボタン等)を押す。 */
async function chip(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
}

/** 左レールのカテゴリーを開く。 */
async function category(page: Page, label: string): Promise<void> {
  const button = railButton(page, label);
  await expect(button).toBeEnabled({ timeout: 20000 });
  await button.click();
}

/**
 * ブラウザ単位フラグ(指示ルールの初回紹介・既定画面トグル)と保存済み会話を
 * 毎テストまっさらにする。storageState は実ログインのものを使い回すため、
 * これをしないと前のテストの痕跡で分岐が変わる。
 */
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
      /* プライベートブラウズ等。既定値のまま進む */
    }
  });
}

async function newHarness(page: Page): Promise<CopilotTenantHarness> {
  await resetBrowserFlags(page);
  return new CopilotTenantHarness(page);
}

// ───────────────────────────────────────────────────────────────────────────
// 0. 新規アカウント作成
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-0 新規アカウント作成', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test('CT-0-1: 実バックエンドへのテナント新規作成(本番以外を向いている場合のみ)', async () => {
    const blocked = realProvisioningBlockedReason();
    // 本番向き・トークン未設定では意図的に実行しない。理由を必ず出力してから skip する
    // (黙って skip すると「実作成が通っている」と誤解される)。
    test.skip(!!blocked, blocked ?? '');

    const { createRealTenant } = await import('./helpers/newTenantAccount');
    const account = await createRealTenant({
      name: `E2E新規テナント-${process.env.GITHUB_RUN_ID ?? 'local'}`,
    });
    expect(account.mode).toBe('real');
    expect(account.tenantId).toBeTruthy();
  });

  test('CT-0-2: 疑似の新規アカウントは4段階すべて未達の状態を持つ', async () => {
    const account = simulatedNewTenant();
    expect(account.mode).toBe('simulated');
    expect(Object.values(BRAND_NEW_ACCOUNT_STAGE).every((v) => v === false)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 1. オンボーディング4段階(新規アカウントの初回ログインから)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-1 新規アカウント初回ログイン → オンボーディング4段階', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-1-1: 何も済んでいない新規アカウントは、週次まとめではなく業種の質問から始まる', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: BRAND_NEW_ACCOUNT_STAGE });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('どんな業種ですか？')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: /小売・EC/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /自動車販売・整備/ })).toBeVisible();

    // 起動時ブリーフィング(LLM1ターン + get_weekly_briefing)を焚かない。
    // 新規テナントに週次の数字は存在せず、無駄な課金になるため。
    expect(h.countMessages('ログインしたところです')).toBe(0);
  });

  test('CT-1-2: 業種を選ぶと、その業種のFAQテンプレ提案が確認待ちで返り「登録して」で確定する', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: BRAND_NEW_ACCOUNT_STAGE });
    h.chat([
      {
        when: '業種は「小売・EC」です',
        reply: {
          reply: '小売・EC向けのFAQを10件ご用意しました。',
          actions: [
            {
              tool: 'import_industry_faq_templates',
              result: '小売・EC のFAQテンプレート10件をご用意しました。よろしければ登録しますか？',
            },
          ],
        },
      },
      {
        when: '登録してください',
        reply: {
          reply: '10件を下書きとして登録しました。',
          answered_from: 'tool_action',
          actions: [{ tool: 'import_industry_faq_templates', result: 'FAQテンプレート10件を登録しました' }],
        },
      },
    ]);
    await h.open(ADMIN_BASE_URL);

    await page.getByRole('button', { name: /小売・EC/ }).click();
    await expect(page.getByText('よろしければ登録しますか')).toBeVisible({ timeout: 20000 });

    // 確認待ちのときだけ「登録して / あとで」が出る(勝手に登録しない)
    await expect(page.getByRole('button', { name: '登録して', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'あとで', exact: true })).toBeVisible();

    await chip(page, '登録して');
    await expect.poll(() => h.lastMessage(), { timeout: 20000 }).toBe('登録してください');
    await settle(page);
    await expect(page.getByText('下書きとして登録しました')).toBeVisible({ timeout: 20000 });
  });

  // 【不具合】確認待ちで止まっただけの import_industry_faq_templates が
  // 「実際の操作」件数に加算される。
  //   - index.tsx の REAL_WRITE_TOOLS に import_industry_faq_templates が入っている
  //   - 加算の除外条件は result に「確認が必要」/「確認をスキップできません」が
  //     含まれるかどうかだけ(index.tsx の writesThisTurn)
  //   - ところが actionExecutor.ts:1375 の未確認時の戻り値は
  //     「よろしければ登録しますか？」であり、どちらのマーカーも含まない
  // 結果、FAQを1件も登録していない時点で件数が1になる。新規テナントが
  // オンボーディングの最初に必ず通る経路で、進捗表示が水増しされる。
  // publish_faq_drafts(actionExecutor.ts:1485「よろしければ公開しますか？」)も同じ。
  // 修正されたらこのテストが「予期せず成功」して落ちるので、そこで fail 指定を外すこと。
  test('CT-1-2b: 確認待ちで止まったFAQ取り込みは「実際の操作」に数えない', async ({ page }) => {
    test.fail();
    const h = await newHarness(page);
    await h.install({ stage: BRAND_NEW_ACCOUNT_STAGE });
    h.chat([
      {
        when: '業種は「小売・EC」です',
        reply: {
          reply: 'ご用意しました。',
          actions: [
            {
              tool: 'import_industry_faq_templates',
              // actionExecutor.ts:1375 の未確認時の実際の戻り値と同じ形
              result:
                '「小売・EC」向けのFAQたたき台を10件ご用意しました:\n1. Q: 送料は / A: 全国一律\nよろしければ登録しますか？（下書きとして登録し、内容を確認してから公開できます）',
            },
          ],
        },
      },
    ]);
    await h.open(ADMIN_BASE_URL);

    await page.getByRole('button', { name: /小売・EC/ }).click();
    await expect(page.getByText('よろしければ登録しますか')).toBeVisible({ timeout: 20000 });
    await settle(page);

    // まだ1件も登録していないので0件であるべき
    await expect(page.getByLabel('実際の操作 0件')).toBeVisible();
  });

  test('CT-1-3: 「あとで」を選ぶと登録せず辞退の意思だけが送られる', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: BRAND_NEW_ACCOUNT_STAGE });
    h.chat([
      {
        when: '業種は「飲食」です',
        reply: {
          reply: 'ご用意しました。',
          actions: [
            { tool: 'import_industry_faq_templates', result: '飲食 のFAQ10件。よろしければ登録しますか？' },
          ],
        },
      },
      { when: 'あとでにします', reply: { reply: 'かしこまりました。' } },
    ]);
    await h.open(ADMIN_BASE_URL);

    await page.getByRole('button', { name: /飲食/ }).click();
    await expect(page.getByText('よろしければ登録しますか')).toBeVisible({ timeout: 20000 });
    await chip(page, 'あとで');
    await expect.poll(() => h.lastMessage(), { timeout: 20000 }).toBe('あとでにします');
    await settle(page);

    // 辞退したので新たな書き込みは発生しない(件数が増えない)。
    // 直前の確認待ちターンが既に1件と数えられている点は CT-1-2b 参照。
    await expect(page.getByLabel('実際の操作 1件')).toBeVisible();
  });

  test('CT-1-4: 業種は答えたが下書きが1件も無い場合、公開を促さず業種の質問に戻す(空振り防止)', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({
      stage: { ...BRAND_NEW_ACCOUNT_STAGE, industryAnswered: true, hasDraftFaq: false },
    });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('FAQのたたき台をまだお作りしていません')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: /小売・EC/ })).toBeVisible();
    // 「下書きを見る」を出すと空の一覧に着地してしまうので出さない
    await expect(page.getByRole('button', { name: '下書きを見る' })).toHaveCount(0);
  });

  test('CT-1-5: 下書きがあるなら公開を促し、「公開する」で確定できる', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({
      stage: { ...BRAND_NEW_ACCOUNT_STAGE, industryAnswered: true, hasDraftFaq: true },
    });
    h.chat([
      {
        when: '下書きのFAQを見せてください',
        reply: {
          reply: '下書きは10件です。',
          actions: [{ tool: 'publish_faq_drafts', result: '下書き10件。よろしければ公開しますか？' }],
        },
      },
      {
        when: 'はい、公開してください',
        reply: {
          reply: '公開しました。',
          actions: [{ tool: 'publish_faq_drafts', result: 'FAQ10件を公開しました' }],
        },
      },
    ]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('下書きとして登録済みです')).toBeVisible({ timeout: 20000 });
    await chip(page, '下書きを見る');
    await expect(page.getByText('よろしければ公開しますか')).toBeVisible({ timeout: 20000 });

    await chip(page, '公開する');
    await expect.poll(() => h.lastMessage(), { timeout: 20000 }).toBe('はい、公開してください');
    await settle(page);
    await expect(page.getByText('公開しました。')).toBeVisible({ timeout: 20000 });
  });

  test('CT-1-6: 公開済み・未設置なら埋め込みコードの案内へ進む', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({
      stage: {
        industryAnswered: true,
        knowledgePublished: true,
        widgetInstalled: false,
        firstConversation: false,
        hasDraftFaq: true,
      },
    });
    h.chat([
      {
        when: '埋め込みコードを教えてください',
        reply: {
          reply: 'こちらの画面からコピーできます。',
          actions: [
            {
              tool: 'get_legacy_ui_link',
              result: '画面: 埋め込みコード\nURL: /admin/knowledge\n説明: サイトへの設置はこの画面から行えます',
              card: {
                kind: 'legacy_link',
                label: '埋め込みコード',
                url: '/admin/knowledge',
                description: 'サイトへの設置はこの画面から行えます',
              },
            },
          ],
        },
      },
    ]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('次はウィジェットをサイトに設置しましょう')).toBeVisible({ timeout: 20000 });
    await chip(page, '埋め込みコードを見る');

    const link = page.getByRole('link', { name: /埋め込みコードを開く/ });
    await expect(link).toBeVisible({ timeout: 20000 });
    // 同一オリジンの内部リンクは opener を残す(旧画面から window.close() で会話へ戻れる)
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'opener');
  });

  test('CT-1-7: 設置済み・初回会話待ちは、待機の案内だけでチップを出さない(押せる次の一手が無いため)', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({
      stage: {
        industryAnswered: true,
        knowledgePublished: true,
        widgetInstalled: true,
        firstConversation: false,
        hasDraftFaq: true,
      },
    });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('最初のご質問をお待ちしています')).toBeVisible({ timeout: 20000 });
    expect(h.countMessages('ログインしたところです')).toBe(0);
  });

  test('CT-1-8: 4段階すべて完了した直後は、指示ルールの紹介が一度だけ出る(2回目の起動では出ない)', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: FULLY_ONBOARDED_STAGE });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('指示ルールも使えます')).toBeVisible({ timeout: 20000 });
    // 紹介を出したターンでは週次ブリーフィングを焚かない(1画面に2つの話題を出さない)
    expect(h.countMessages('ログインしたところです')).toBe(0);

    // 2回目の起動: ブラウザ単位フラグが立っているので紹介は出ず、通常の週次まとめへ。
    // 保存済みの会話が残っていると「復元できた」経路に入りブリーフィング自体を
    // 焚かないため、ここでは会話だけ捨てて「別の日にログインし直した」状態にする。
    await page.evaluate(() => sessionStorage.removeItem('r2c_chat_session_copilot-preview'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('指示ルールも使えます')).toHaveCount(0);
    await expect
      .poll(() => h.countMessages('ログインしたところです'), { timeout: 20000 })
      .toBeGreaterThan(0);
  });

  test('CT-1-9: オンボーディング段階の取得に失敗しても詰まらず、通常の週次まとめへ落ちる', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ myTenantFails: true });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByText('今週の実データを確認しています')).toBeVisible({ timeout: 20000 });
    await expect
      .poll(() => h.countMessages('ログインしたところです'), { timeout: 20000 })
      .toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. 通常運用 — 左レール7カテゴリー
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-2 左レールの全カテゴリー', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  test('CT-2-1: 7カテゴリーが並び、それぞれ想定の依頼文を送る', async ({ page }) => {
    const h = await newHarness(page);
    // stage を返さない = 通常運用のテナント。オンボーディングの「次の一手」も
    // 指示ルールの初回紹介も挟まらず、起動時ブリーフィングだけが走る状態にする
    // (紹介メッセージはチップ付きで、選ぶまで他カテゴリーがロックされるため)。
    await h.install({ stage: null });
    h.chat([BOOTSTRAP_RULE, { when: () => true, reply: { reply: 'お調べしました。' } }]);
    await h.open(ADMIN_BASE_URL);
    await settle(page);

    for (const label of [
      'アシスタント',
      '今週のまとめ',
      '対応中の会話',
      '会話の履歴',
      '知識データ',
      '指示ルール',
      'アバター',
    ]) {
      await expect(railButton(page, label)).toBeVisible();
    }

    // カテゴリを押してから sendReal が走り出すまでに一瞬の間があるため、
    // 「押した直後に読む」のではなく「送られるまで待つ」形にする。
    for (const [label, expected] of [
      ['今週のまとめ', '今週の状況を教えてください'],
      ['対応中の会話', 'エスカレーション'],
      ['知識データ', '知識データの状況'],
      ['指示ルール', '指示ルールの状況'],
      ['アバター', 'アバターの稼働状況'],
    ] as const) {
      await category(page, label);
      await expect.poll(() => h.lastMessage(), { timeout: 20000 }).toContain(expected);
      await settle(page);
    }
  });

  test('CT-2-2: 「会話の履歴」は即送信せず、点検/照会を選ばせる', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: null });
    h.chat([BOOTSTRAP_RULE, { when: () => true, reply: { reply: '確認しました。' } }]);
    await h.open(ADMIN_BASE_URL);
    await settle(page);

    await category(page, '会話の履歴');
    await expect(page.getByText('会話の履歴について、何をしますか？')).toBeVisible();
    // 押しただけでは何も送らない(点検と照会で送るべき内容が別物のため)。
    // 起動時ブリーフィングの到着とレースになるので総数では比較せず、
    // 履歴用の定型文が送られていないことを直接見る。
    expect(h.countMessages('対応品質に問題がありそうな会話')).toBe(0);
    expect(h.countMessages('特定の会話を探したい')).toBe(0);

    await chip(page, '最近の会話を点検する');
    await expect
      .poll(() => h.lastMessage(), { timeout: 20000 })
      .toContain('対応品質に問題がありそうな会話');
  });

  test('CT-2-3: 未対応の件数はバッジで出し、0件のカテゴリーには出さない', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: null, gapsCount: 7, escalationsCount: 0 });
    h.chat([BOOTSTRAP_RULE]);
    await h.open(ADMIN_BASE_URL);

    await expect(page.getByLabel('未回答質問 7件')).toBeVisible({ timeout: 20000 });
    // 0件は情報ではなくノイズなので出さない
    await expect(page.getByLabel(/対応中の会話 \d+件/)).toHaveCount(0);
  });

  test('CT-2-4: 件数の取得に失敗してもチャットはそのまま使える(バッジが出ないだけ)', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: null, railCountsFail: true });
    h.chat([BOOTSTRAP_RULE, { when: 'テスト送信', reply: { reply: '受け取りました。' } }]);
    await h.open(ADMIN_BASE_URL);
    await settle(page);

    await send(page, 'テスト送信');
    await expect(page.getByText('受け取りました。')).toBeVisible({ timeout: 20000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. 各カードの描画(実データの見え方)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-3 カードの描画', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  async function bootTo(page: Page, rule: { when: string; reply: unknown }): Promise<CopilotTenantHarness> {
    const h = await newHarness(page);
    await h.install({ stage: null });
    h.chat([BOOTSTRAP_RULE, rule as never]);
    await h.open(ADMIN_BASE_URL);
    await settle(page);
    return h;
  }

  test('CT-3-1: 週次まとめは数値をそのまま描画し、着手できる行動チップを添える', async ({ page }) => {
    await bootTo(page, {
      when: '今週の状況',
      reply: {
        reply: '未回答質問が溜まっています。',
        actions: [
          {
            tool: 'get_weekly_briefing',
            result: '取得しました',
            // フィールド形は useAgentChatTransport.ts の WeeklySummaryAgentActionCard が正。
            // 形を間違えるとカードが黙って空になるため、ここは実際の形に合わせる。
            card: {
              kind: 'weekly_summary',
              asOf: new Date().toISOString(),
              sessions: { total: 128, prevTotal: 114, changePct: 12 },
              avgScore: 74,
              conversions: { count: 9, total: 128000 },
              faq: { total: 42, published: 40, lastUpdated: '2026-08-20T00:00:00.000Z' },
              pendingTuningRules: 3,
              gaps: { total: 5, top: [{ id: 1, question: '駐車場はありますか' }] },
              learned: { faqAdded: 2, memorized: 1 },
            },
          },
        ],
      },
    });

    await category(page, '今週のまとめ');
    await expect(page.getByText('128件', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('74/100')).toBeVisible();
    await expect(page.getByText('答えられなかった質問（上位）')).toBeVisible();
    // 未回答質問・承認待ちルールが実在するときだけ、その場で着手できるチップを出す
    await expect(page.getByRole('button', { name: 'FAQにする' })).toBeVisible();
    await expect(page.getByRole('button', { name: '確認する' })).toBeVisible();
  });

  test('CT-3-2: 指示ルール一覧は15件を超えても全件描画され、AI提案には承認/却下が出る', async ({ page }) => {
    const rules = Array.from({ length: 18 }, (_, i) => ({
      id: i + 1,
      triggerPattern: `トリガー${i + 1}`,
      expectedBehavior: `振る舞い${i + 1}`,
      priority: 50,
      isActive: true,
      source: 'manual',
      status: 'active',
    }));
    rules.push({
      id: 99,
      triggerPattern: '保証について',
      expectedBehavior: '2年とお伝えする',
      priority: 80,
      isActive: false,
      source: 'judge',
      status: 'pending',
    });

    await bootTo(page, {
      when: '指示ルールの状況',
      reply: {
        reply: '19件あります。',
        actions: [
          {
            tool: 'get_tuning_rules',
            result: '取得しました',
            card: { kind: 'tuning_rules_list', rules, totalCount: rules.length },
          },
        ],
      },
    });

    await category(page, '指示ルール');
    await expect(page.getByText('トリガー1', { exact: false }).first()).toBeVisible({ timeout: 20000 });
    // 500字打ち切りの回帰: 末尾の18件目まで残っていること
    await expect(page.getByText('トリガー18').first()).toBeVisible();
    // AI提案の行にだけ出所バッジと承認/却下が付く
    await expect(page.getByText('🤖 AIの提案（未承認）')).toBeVisible();
    await expect(page.getByRole('button', { name: '有効にする' })).toBeVisible();
    await expect(page.getByRole('button', { name: '却下する' })).toBeVisible();
  });

  test('CT-3-3: 知識ギャップ一覧の各行から、そのギャップ本文を含む依頼が送れる', async ({ page }) => {
    const h = await bootTo(page, {
      when: '知識データの状況',
      reply: {
        reply: '未回答が2件あります。',
        actions: [
          {
            tool: 'get_knowledge_gaps',
            result: '取得しました',
            card: {
              kind: 'knowledge_gaps_list',
              gaps: [
                { id: 11, userQuestion: '駐車場はありますか', ragHitCount: 0 },
                { id: 12, userQuestion: '領収書は出ますか', ragHitCount: 1 },
              ],
              totalCount: 2,
            },
          },
        ],
      },
    });

    await category(page, '知識データ');
    await expect(page.getByText('駐車場はありますか')).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /このギャップからルールを作る/ }).first().click();
    await expect.poll(() => h.lastMessage(), { timeout: 20000 }).toContain('ID: 11');
    expect(h.lastMessage()).toContain('駐車場はありますか');
    await settle(page);
  });

  test('CT-3-4: 会話一覧 → 本文 → その回答を直す、まで会話の中だけで辿れる', async ({ page }) => {
    const h = await newHarness(page);
    await h.install({ stage: null });
    h.chat([
      BOOTSTRAP_RULE,
      {
        when: '特定の会話を探したい',
        reply: {
          reply: '直近の会話です。',
          actions: [
            {
              tool: 'get_chat_sessions',
              result: '取得しました',
              card: {
                kind: 'chat_session_list',
                total: 1,
                sessions: [
                  {
                    shortId: 'AB12CD',
                    startedAt: '2026-08-20T10:00:00.000Z',
                    messageCount: 4,
                    preview: '駐車場について',
                    outcome: null,
                  },
                ],
              },
            },
          ],
        },
      },
      {
        when: '[AB12CD]の会話を見せて',
        reply: {
          reply: '本文です。',
          actions: [
            {
              tool: 'get_chat_session_messages',
              result: '取得しました',
              card: {
                kind: 'chat_session_messages',
                shortId: 'AB12CD',
                totalMessages: 2,
                messages: [
                  { role: 'user', roleLabel: 'お客様', content: '駐車場はありますか' },
                  { role: 'assistant', roleLabel: 'AI', content: 'ございません' },
                ],
              },
            },
          ],
        },
      },
      { when: 'は間違っています', reply: { reply: 'どこが違うか教えてください。' } },
    ]);
    await h.open(ADMIN_BASE_URL);
    await settle(page);

    await category(page, '会話の履歴');
    await chip(page, '特定の会話を探す');
    // 同じ文言が一覧カードと選択チップの両方に出るため first() で絞る
    await expect(page.getByText('駐車場について').first()).toBeVisible({ timeout: 20000 });

    // 短縮IDを手打ちさせない: 一覧の直後に選択チップが出る
    await page.getByRole('button', { name: /08-20 駐車場について/ }).click();
    await expect(page.getByText('ございません')).toBeVisible({ timeout: 20000 });

    // 誤答に気づいたその場から直せる
    await page.getByRole('button', { name: /この回答を直す/ }).first().click();
    await expect.poll(() => h.lastMessage(), { timeout: 20000 }).toContain('ございません');
    expect(h.lastMessage()).toContain('駐車場はありますか');
    await settle(page);
  });

  test('CT-3-5: ご利用状況(請求)は閲覧専用で、操作ボタンを出さない', async ({ page }) => {
    await bootTo(page, {
      when: '料金',
      reply: {
        reply: 'ご利用状況です。',
        actions: [
          {
            tool: 'get_billing_summary',
            result: '取得しました',
            // フィールド形は BillingSummaryAgentActionCard が正(breakdown は feature/label/
            // percentage/costUsd、invoices は id/statusLabel/amountDue/created)。
            card: {
              kind: 'billing_summary',
              period: '30d',
              plan: 'standard',
              billingEstimateJpy: 9800,
              breakdown: [{ feature: 'chat', label: 'テキスト会話', percentage: 100, costUsd: 12 }],
              invoicesAvailable: true,
              invoices: [
                {
                  id: 'in_e2e_1',
                  statusLabel: '支払済み',
                  amountDue: 9800,
                  created: 1755000000,
                  hostedInvoiceUrl: null,
                },
              ],
              portalUrl: 'https://billing.stripe.com/session/e2e',
              quota: null,
            },
          },
        ],
      },
    });

    await send(page, '料金はいくらですか');
    await expect(page.getByText('今期の請求見積り 9,800円')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('link', { name: /お支払い方法の確認・変更/ })).toBeVisible();
    // 取得できなかった枠を 0 と誤読させない(quota=null はブロックごと出さない)
    await expect(page.getByText('今月の利用枠')).toHaveCount(0);
    // 解約・プラン変更などの操作はこの面から出さない(閲覧専用)
    await expect(page.getByRole('button', { name: /解約|プランを変更/ })).toHaveCount(0);
  });

  test('CT-3-6: AI応答のMarkdownは整形して描画し、自分の発話は素のまま出す', async ({ page }) => {
    await bootTo(page, {
      when: '**強調**で聞きます',
      reply: { reply: '**太字**と\n- 箇条書き\n- 2つ目', answered_from: 'general' },
    });

    await send(page, '**強調**で聞きます');
    // タイプライター演出の最中は素のテキストで出る(不完全なMarkdown断片のチラつき防止)。
    // 演出が終わってから Markdown として解釈されるので、完了を待ってから判定する。
    await settle(page);
    await expect(page.locator('strong', { hasText: '太字' })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('listitem').first()).toBeVisible();
    // 自分の発話はそのまま(意図しない強調にしない)
    await expect(page.getByText('**強調**で聞きます')).toBeVisible();
    // 出どころラベル
    await expect(page.getByText('R2Cの使い方ガイドから回答しました')).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. アバター(生成・採用・写真・声)
// ───────────────────────────────────────────────────────────────────────────

test.describe('CT-4 アバターを会話だけで整える', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  const ADOPTED_CARD = {
    kind: 'avatar_adopted',
    configId: 'cfg-e2e-1',
    name: 'はるか',
    imageUrl: null,
    description: 'とても丁寧で落ち着いた話し方をします。',
  };

  async function bootAvatar(page: Page, avatarOpts = {}): Promise<CopilotTenantHarness> {
    const h = await newHarness(page);
    await h.install({ stage: null });
    await h.stubAvatarBackend(avatarOpts);
    h.chat([
      BOOTSTRAP_RULE,
      {
        when: 'アバター',
        reply: {
          reply: 'アバターを採用しました。',
          actions: [{ tool: 'adopt_avatar_preset', result: 'アバター「はるか」を採用しました', card: ADOPTED_CARD }],
        },
      },
    ]);
    await h.open(ADMIN_BASE_URL);
    await settle(page);
    await category(page, 'アバター');
    await expect(page.getByText('アバター「はるか」を採用しました')).toBeVisible({ timeout: 20000 });
    return h;
  }

  test('CT-4-1: 画像を生成 → 候補から採用まで、画面を出ずに完了する', async ({ page }) => {
    const h = await bootAvatar(page);

    await page.getByRole('button', { name: '画像を新しく生成する' }).click();
    await expect(page.getByText('新しい候補です')).toBeVisible({ timeout: 20000 });

    const adoptButtons = page.getByRole('button', { name: 'これにする' });
    await expect(adoptButtons).toHaveCount(4);
    await adoptButtons.first().click();

    await expect(page.getByRole('button', { name: 'これに決定' })).toBeVisible({ timeout: 20000 });
    // 採用は1枚だけ。残り3枚はボタンが消えるのではなく「押せなくなる」
    // (選び直しは「別の候補を見る」からの再生成になる)
    const rest = page.getByRole('button', { name: 'これにする' });
    await expect(rest).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) await expect(rest.nth(i)).toBeDisabled();
    expect(h.countWrites('/v1/admin/avatar/configs/')).toBe(1);
    // 2件 = アバター見本の採用(adopt_avatar_preset) + 画像の反映(PATCH)。
    // どちらも実際にDBを書き換えた操作なので、どちらも進捗に乗るのが正しい。
    await expect(page.getByLabel('実際の操作 2件')).toBeVisible();
  });

  test('CT-4-2: 生成が失敗しても必ず確定し、無限スピナーを残さない', async ({ page }) => {
    await bootAvatar(page, { generateStatus: 500 });

    await page.getByRole('button', { name: '画像を新しく生成する' }).click();
    // 見出しと本文の両方に同じ文言が出る(見出し=状態、本文=案内)
    await expect(page.getByText('画像を生成できませんでした').first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('新しい画像を生成しています')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
  });

  test('CT-4-3: 高品質生成は押しただけでは走らず、費用の確認を毎回挟む', async ({ page }) => {
    const h = await bootAvatar(page);

    await page.getByRole('button', { name: /高品質な画像を生成する/ }).click();
    await expect(page.getByText('通常の生成より高い費用がかかります')).toBeVisible();
    expect(h.countWrites('/generate-premium')).toBe(0);

    await page.getByRole('button', { name: 'やめる' }).click();
    expect(h.countWrites('/generate-premium')).toBe(0);

    // 2回目も必ず確認する(前回の同意を記憶しない)
    await page.getByRole('button', { name: /高品質な画像を生成する/ }).click();
    await expect(page.getByText('通常の生成より高い費用がかかります')).toBeVisible();
    await page.getByRole('button', { name: '生成する', exact: true }).click();
    await expect(page.getByText('高品質な候補です')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/generate-premium')).toBe(1);
  });

  test('CT-4-4: 声を探して採用できる。試聴が無いことも明示される', async ({ page }) => {
    const h = await bootAvatar(page);

    await page.getByRole('button', { name: '声を探す' }).click();
    await expect(page.getByText('やわらかい女性の声')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('音声のプレビューは提供されていません')).toBeVisible();

    await page.getByRole('button', { name: 'この声にする' }).first().click();
    await expect(page.getByRole('button', { name: 'これに決定' })).toBeVisible({ timeout: 20000 });
    // 残りの候補はボタンが消えるのではなく「押せなくなる」(選び直しは再検索から)
    const remaining = page.getByRole('button', { name: 'この声にする' });
    await expect(remaining).toHaveCount(1);
    await expect(remaining).toBeDisabled();
    expect(h.countWrites('/v1/admin/avatar/configs/')).toBe(1);
  });

  test('CT-4-5: 声を作る(Voice Design)は試聴してから採用できる', { tag: '@cross-browser' }, async ({ page }) => {
    await bootAvatar(page);

    await page.getByRole('button', { name: '声を作る' }).click();
    await expect(page.getByText('声の候補ができました')).toBeVisible({ timeout: 20000 });
    // 実際に <audio> が並ぶ(base64 の data URI)
    await expect(page.locator('audio')).toHaveCount(2);
    await expect(page.locator('audio').first()).toHaveAttribute(
      'src',
      `data:audio/wav;base64,${TINY_WAV_BASE64}`,
    );

    await page.getByRole('button', { name: 'この声にする' }).first().click();
    await expect(page.getByRole('button', { name: '決定済み' }).first()).toBeVisible({ timeout: 20000 });
  });

  test('CT-4-6: プラン未達は英語のエラーコードではなくサーバの日本語文言を見せる', async ({ page }) => {
    await bootAvatar(page, {
      premiumStatus: 403,
      premiumErrorBody: {
        error: 'plan_upgrade_required',
        message: 'この機能はGrowthプラン以上でお使いいただけます。',
      },
    });

    await page.getByRole('button', { name: /高品質な画像を生成する/ }).click();
    await page.getByRole('button', { name: '生成する', exact: true }).click();
    await expect(page.getByText('Growthプラン以上でお使いいただけます')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('plan_upgrade_required')).toHaveCount(0);
  });

  test('CT-4-7: 写真をアップロードするとその場で反映され、AI生成は呼ばれない', { tag: '@cross-browser' }, async ({ page }) => {
    const h = await bootAvatar(page);

    await page.setInputFiles('input[accept="image/jpeg,image/png,image/webp"]', {
      name: 'me.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PLACEHOLDER_IMAGE.split(',')[1], 'base64'),
    });

    await expect(page.getByText('アバター画像を差し替えました')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/fal/generate')).toBe(0);
    expect(h.countWrites('/v1/admin/avatar/configs/')).toBe(1);
  });

  test('CT-4-8: 自分の声のクローンは選んだ瞬間に確定する', async ({ page }) => {
    const h = await bootAvatar(page);

    await page.setInputFiles('input[accept*="audio/mpeg"]', {
      name: 'voice.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(TINY_WAV_BASE64, 'base64'),
    });

    await expect(page.getByText('音声クローンを作成しました')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/voice-clone')).toBe(1);
  });
});
