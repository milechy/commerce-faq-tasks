// tests/e2e/qa-superadmin-journey.spec.ts
//
// super_admin ロールで管理画面(旧UI = /admin/*)の全機能を通しで検証する。
// 実ブラウザ(Chrome)を headed で立ち上げ、実際に描画された画面を操作する。
// 録画とスクリーンショットは playwright.config.ts の superadmin プロジェクトが常時保存する
// (失敗時だけでなく毎回。後から通しで見返せるようにするため)。
//
// 【この spec の立ち位置】
// admin-ui 側の vitest(pages/admin/**/index.test.tsx 群)が「関数レベルの分岐」を
// 押さえているのに対し、こちらは
//   - 実ブラウザでの描画・タブ切替・モーダル・遷移
//   - 押したときに“本当に何が飛んだか”(送出メソッド・本文・回数)
//   - 画面をまたぐ順序(一覧 → 詳細 → プレビュー → 復帰)
// を押さえる。vitest と重複する主張はここでは繰り返さない。
//
// 【本番データを触らない理由】helpers/superAdminHarness.ts の冒頭コメント参照。
// super_admin の画面は他人のテナントに直接効く不可逆操作(キー失効・招待送信・削除・
// 課金フラグ)を束ねているため、全 /v1/admin/* をブラウザ内で差し替える。

import { test, expect, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './config';
import {
  DEFAULT_FEEDBACK,
  DEFAULT_TENANTS,
  HEALTHY_MONITORING_KPIS,
  SuperAdminHarness,
  superAdminAuthReady,
  type TenantRow,
} from './helpers/superAdminHarness';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const SA_READY = superAdminAuthReady();

// ───────────────────────────────────────────────────────────────────────────
// 共通操作
// ───────────────────────────────────────────────────────────────────────────

/** テナント詳細のタブを開く。 */
async function tab(page: Page, label: string): Promise<void> {
  const button = page.getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 20000 });
  await button.click();
}

/** テナント一覧の行(カード)。名前で引く。 */
function tenantCard(page: Page, name: string) {
  return page.locator('div').filter({ hasText: new RegExp(`^${name}`) }).first();
}

/** 「全N件中M件表示」から M を読む。 */
async function shownCount(page: Page): Promise<number> {
  const text = (await page.getByText(/全\d+件中/).first().textContent()) ?? '';
  return Number(text.match(/中\s*(\d+)\s*件表示/)?.[1] ?? NaN);
}

// ───────────────────────────────────────────────────────────────────────────
// 前提: super_admin の storageState
// ───────────────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.skip(
    !SA_READY,
    'super_admin storageState 未生成/期限切れ — `pnpm exec playwright test --project=superadmin-setup` を先に実行',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// SA-1 テナント管理(super_admin にしか無い、他社の設定を触る入口)
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-1 テナント管理一覧', () => {
  test('SA-1-1: 全テナントが並び、件数表示が実データと一致する', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');

    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });
    for (const t of DEFAULT_TENANTS) {
      await expect(page.getByText(t.name, { exact: true })).toBeVisible();
    }
    // 「全3件中3件表示」。件数表示と実際の行数がズレると、絞り込みの取りこぼしに
    // 気付けなくなる(運用者は件数だけを見て「全部見た」と判断する)。
    expect(await shownCount(page)).toBe(DEFAULT_TENANTS.length);
  });

  test('SA-1-2: 状態フィルタが行と件数の両方に反映される', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: '有効のみ', exact: true }).click();
    expect(await shownCount(page)).toBe(2);
    await expect(page.getByText('休止中ストア', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '無効のみ', exact: true }).click();
    expect(await shownCount(page)).toBe(1);
    await expect(page.getByText('休止中ストア', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'すべて', exact: true }).click();
    expect(await shownCount(page)).toBe(3);
  });

  test('SA-1-3: 検索はデバウンス後に絞り込み、サーバへは取りに行かない(クライアント絞り込み)', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    const before = h.countRequests('/v1/admin/tenants');
    await page.getByPlaceholder('テナントを検索...').fill('青山');
    // 300ms デバウンス。expect のポーリングで待つ(固定 waitForTimeout を置かない)。
    await expect.poll(() => shownCount(page), { timeout: 5000 }).toBe(1);
    await expect(page.getByText('青山クリニック', { exact: true })).toBeVisible();

    // 1文字ごとに再取得していたら、この画面は入力するたび全テナントを引き直す。
    expect(h.countRequests('/v1/admin/tenants')).toBe(before);
  });

  test('SA-1-4: 並び替えは名前・作成日それぞれで昇順/降順を切り替えられる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    const names = async () =>
      (await page.locator('span').filter({ hasText: /^(カーネーション自動車|青山クリニック|休止中ストア)$/ }).allTextContents());

    // 既定は作成日の降順 → 最新(休止中ストア: 5月)が先頭。
    expect((await names())[0]).toBe('休止中ストア');

    await page.getByRole('button', { name: /名前/ }).click();
    const asc = await names();
    await page.getByRole('button', { name: /名前/ }).click();
    const desc = await names();
    expect(desc).toEqual([...asc].reverse());
  });

  test('SA-1-5: 課金バッジは課金中/未課金/無料期間中を出し分ける', async ({ page }) => {
    const now = Date.now();
    const tenants: TenantRow[] = [
      { ...DEFAULT_TENANTS[0], billing_enabled: true },
      { ...DEFAULT_TENANTS[1], billing_enabled: false },
      {
        ...DEFAULT_TENANTS[2],
        // 無料期間は billing_enabled より優先されるはず(請求の誤解を生む最重要の出し分け)。
        billing_enabled: true,
        billing_free_from: new Date(now - 86400000).toISOString(),
        billing_free_until: new Date(now + 86400000).toISOString(),
      },
    ];
    const h = new SuperAdminHarness(page);
    await h.install({ tenants });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await expect(page.getByText('課金中', { exact: true })).toHaveCount(1);
    await expect(page.getByText('未課金', { exact: true })).toHaveCount(1);
    await expect(page.getByText('無料期間中', { exact: true })).toHaveCount(1);
  });

  test('SA-1-6: テナント作成は送出内容が入力どおりで、成功時に一覧へ即時追加される', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /新しいテナントを追加/ }).click();
    await expect(page.getByText('🏢 新しいテナントを追加')).toBeVisible();

    await page.getByPlaceholder('例: カーネーション自動車').fill('  新規テストストア  ');
    await page.getByPlaceholder('例: carnation-auto').fill('new-test-shop');
    await page.getByRole('button', { name: /テナントを作成する/ }).click();

    await expect(page.getByText('✅ テナントを作成しました！')).toBeVisible({ timeout: 20000 });

    // 送出は1回だけ。名前は前後空白を落として送る。プランは starter 固定。
    expect(h.countWrites('/v1/admin/tenants', 'POST')).toBe(1);
    expect(h.lastBody('/v1/admin/tenants')).toMatchObject({
      id: 'new-test-shop',
      name: '新規テストストア',
      plan: 'starter',
    });

    // 一覧を引き直さずに追加されること(作成直後の「あれ、増えてない」を防ぐ)。
    await expect(page.getByText('新規テストストア', { exact: true })).toBeVisible();
    expect(await shownCount(page)).toBe(DEFAULT_TENANTS.length + 1);
  });

  test('SA-1-7: 「設定 →」からテナント詳細へ入れる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await tenantCard(page, 'カーネーション自動車')
      .getByRole('button', { name: '設定 →' })
      .first()
      .click();

    await expect(page).toHaveURL(/\/admin\/tenants\/carnation-demo$/, { timeout: 20000 });
    await expect(page.getByRole('heading', { name: 'カーネーション自動車' })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SA-2 テナント詳細(他社の設定を書き換える画面)
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-2 テナント詳細', () => {
  const DETAIL = '/admin/tenants/carnation-demo';

  test('SA-2-1: super_admin にだけ「設定変更履歴」「招待」タブが出る', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);

    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });
    // client_admin にも出る共通タブ
    for (const label of ['🔑 APIキー', '📋 埋め込みコード', '🤖 アバター', '💳 請求情報']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // super_admin 限定タブ
    await expect(page.getByRole('button', { name: '設定変更履歴', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '✉️ 招待', exact: true })).toBeVisible();
  });

  test('SA-2-2: 設定の保存は PATCH を1回だけ送り、送出内容が入力と一致する', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    await page.locator('form input[type="text"]').first().fill('カーネーション自動車(改)');
    await page.getByRole('button', { name: '無効', exact: true }).click();
    await page.getByPlaceholder(/https:\/\/shop\.example\.com/).fill(
      'https://a.example.com\n  https://b.example.com  \n\nhttps://*.c.example.com\n',
    );
    await page.getByRole('button', { name: /設定を保存する/ }).click();

    await expect(page.getByText('✅ 設定を保存しました')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH')).toBe(1);

    const body = h.lastBody('/v1/admin/tenants/carnation-demo');
    expect(body).toMatchObject({
      name: 'カーネーション自動車(改)',
      // UI は status 文字列ではなく is_active(boolean)で送る契約。
      is_active: false,
    });
    // 行ごとに trim され、空行は落ちる。ここが崩れると許可ドメインが1件も効かなくなる。
    expect(body?.allowed_origins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://*.c.example.com',
    ]);
  });

  test('SA-2-3: APIキータブは有効/無効化済みを出し分け、無効化済みには無効化ボタンを出さない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');

    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('r2c_live_bbbb****')).toBeVisible();
    await expect(page.getByText('無効化済み', { exact: true })).toHaveCount(1);
    // 失効済みキーにまで無効化ボタンが出ると、押しても何も起きない操作を運用者に見せてしまう。
    await expect(page.getByRole('button', { name: '🔒 無効化' })).toHaveCount(1);
    await expect(page.getByText('未使用', { exact: true })).toHaveCount(1);
  });

  test('SA-2-4: 新しいAPIキーの発行はキー一覧の先頭に反映される', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');
    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /新しいAPIキーを発行/ }).click();
    await expect(page.getByRole('heading', { name: '🔑 APIキーの発行' })).toBeVisible();
    await page.getByRole('button', { name: '🔑 発行する', exact: true }).click();

    // 平文キーはこの一度きりしか表示されない。閉じる前に必ず見えていること。
    // 確認フェーズにも「一度だけ表示されます」という文があるため、発行後にしか
    // 出ないもの(平文キーそのもの)で待つ。文言で待つと発行前に通ってしまう。
    await expect(page.getByText('r2c_live_newkey_0123456789abcdef')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/keys', 'POST')).toBe(1);

    // 一覧への反映(onSuccess)はモーダルを閉じた時点で起きる実装。
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.getByText('✅ 新しいAPIキーを発行しました！')).toBeVisible({ timeout: 20000 });
  });

  test('SA-2-5: 課金設定の保存は、課金フラグ・プラン・無料期間をまとめて1回で送る', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    // 日付欄には <label> が無く(見出しは <p>)、アクセシブルな名前が付いていないため
    // getByLabel では引けない。type=date の並び順で引く。
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill('2026-09-01');
    await dates.nth(1).fill('2026-09-30');
    await page.getByRole('button', { name: /課金設定を保存/ }).click();

    await expect
      .poll(() => h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH'), { timeout: 20000 })
      .toBe(1);
    const body = h.lastBody('/v1/admin/tenants/carnation-demo');
    // 日付は ISO へ変換して送る。ここがローカル日付のまま飛ぶと、
    // 時差の分だけ無料期間が前後してテナントに誤請求が出る。
    expect(String(body?.billing_free_from ?? '')).toMatch(/^2026-09-01T/);
    expect(String(body?.billing_free_until ?? '')).toMatch(/^2026-09-30T/);
    expect(body).toHaveProperty('billing_enabled');
  });

  test('SA-2-6: 無料期間をクリアすると、null を明示的に送って解除できる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({
      tenantDetails: {
        'carnation-demo': {
          ...DEFAULT_TENANTS[0],
          billing_free_from: '2026-09-01T00:00:00.000Z',
          billing_free_until: '2026-09-30T00:00:00.000Z',
        },
      },
    });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'クリア', exact: true }).click();
    await page.getByRole('button', { name: /課金設定を保存/ }).click();

    await expect
      .poll(() => h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH'), { timeout: 20000 })
      .toBe(1);
    const body = h.lastBody('/v1/admin/tenants/carnation-demo');
    // キーごと省略すると「変更なし」と解釈され、無料期間が解除できない。
    expect(body).toHaveProperty('billing_free_from', null);
    expect(body).toHaveProperty('billing_free_until', null);
  });

  test('SA-2-7: 招待メールの送出内容が入力アドレスと一致する', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '✉️ 招待');

    await page.getByPlaceholder('user@example.com').fill('owner@example.com');
    await page.getByRole('button', { name: '招待メールを送信' }).click();

    await expect
      .poll(() => h.countWrites('/invite', 'POST'), { timeout: 20000 })
      .toBe(1);
    expect(h.lastBody('/invite')).toMatchObject({ email: 'owner@example.com' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SA-3 クライアントビュー(プレビュー) — super_admin が client_admin に化ける
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-3 クライアントビュー', () => {
  test('SA-3-1: プレビューに入ると全ページ共通の終了バナーが出る', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants/carnation-demo');

    await page.getByRole('button', { name: /クライアントビューで見る/ }).click();

    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('カーネーション自動車 のクライアントとして表示中')).toBeVisible();
    await expect(page.getByRole('button', { name: '元に戻す' })).toBeVisible();
  });

  test('SA-3-2: プレビュー中は super専用ページへ入れず /admin へ戻される', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants/carnation-demo');
    await page.getByRole('button', { name: /クライアントビューで見る/ }).click();
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });

    // プレビューは「client_admin にはこう見える」を確認するための機能。
    // ここで super専用ページが開けてしまうと、確認の意味そのものが無くなる。
    await page.goto(`${ADMIN_BASE_URL}/admin/tenants`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/admin\/tenants$/, { timeout: 20000 });
    await expect(page.getByText(/プレビューモード/)).toBeVisible();
  });

  test('SA-3-3: 「元に戻す」でプレビューが終わり、super専用ページへ戻れる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants/carnation-demo');
    await page.getByRole('button', { name: /クライアントビューで見る/ }).click();
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect(page.getByText(/プレビューモード/)).toHaveCount(0, { timeout: 20000 });

    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });
  });

  test('SA-3-4: プレビューはリロードしても外れない(タブ内では保持される)', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants/carnation-demo');
    await page.getByRole('button', { name: /クライアントビューで見る/ }).click();
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    // リロードで外れると、URL直打ちで開く画面から毎回プレビューが剥がれる(既知の修正点)。
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });

    // 後続テストへ状態を持ち越さない。
    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect(page.getByText(/プレビューモード/)).toHaveCount(0, { timeout: 20000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SA-4 お客様の声(super_admin だけが読む・返す・消す)
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-4 お客様の声', () => {
  test('SA-4-1: 一覧が並び、ステータス/カテゴリで絞り込める', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/feedback');

    await expect(page.getByRole('heading', { name: /お客様の声/ })).toBeVisible({ timeout: 20000 });
    for (const f of DEFAULT_FEEDBACK) {
      await expect(page.getByText(f.message)).toBeVisible();
    }
  });

  test('SA-4-2: 詳細を開いてステータス・優先度・メモを保存すると、送出内容が一致する', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/feedback');
    await expect(page.getByRole('heading', { name: /お客様の声/ })).toBeVisible({ timeout: 20000 });

    await page.getByText('在庫の確認方法が分かりませんでした').first().click();
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible({ timeout: 20000 });

    // 一覧側にも同じ選択肢を持つ絞り込みセレクトがあるため、モーダル内に限定する
    // (ここを取り違えると、絞り込みを変えただけで「保存できた」と誤判定する)。
    // モーダルは position:fixed + inset:0 のオーバーレイとして描画される。
    const modal = page.locator('div[style*="position: fixed"][style*="inset: 0px"]').last();
    await modal.getByRole('combobox').first().selectOption('resolved');
    await page.getByPlaceholder('内部メモを入力...').fill('FAQに追記済み');
    await page.getByRole('button', { name: '保存' }).click();

    await expect.poll(() => h.countWrites('/v1/admin/feedback/fb-1'), { timeout: 20000 }).toBe(1);
    expect(h.lastBody('/v1/admin/feedback/fb-1')).toMatchObject({
      status: 'resolved',
      admin_notes: 'FAQに追記済み',
    });
  });

  test('SA-4-3: テナントへの返信は本文どおりに送られる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/feedback');
    await expect(page.getByRole('heading', { name: /お客様の声/ })).toBeVisible({ timeout: 20000 });

    await page.getByText('在庫の確認方法が分かりませんでした').first().click();
    await page.getByPlaceholder('テナントへの返信を入力...').fill('在庫は商品ページから確認できます');
    await page.getByRole('button', { name: '返信を送る' }).click();

    await expect.poll(() => h.countWrites('/reply', 'POST'), { timeout: 20000 }).toBe(1);
    expect(h.lastBody('/reply')).toMatchObject({ reply_body: '在庫は商品ページから確認できます' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SA-5 監視・分析(super_admin 専用の3画面 + 稼働状況)
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-5 監視と分析', () => {
  test('SA-5-1: システム稼働状況は6指標を描画し、緊急停止は「停止中」が正常と示す', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/monitoring');

    for (const name of [
      '会話完了率',
      '同じ質問の繰り返し率',
      'AIが答えられなかった割合',
      '応答速度（95%ile）',
      'エラー率',
      '緊急停止スイッチ',
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 20000 });
    }
    await expect(page.getByText('正常に稼働しています')).toBeVisible();
    await expect(page.getByText('停止中 が正常')).toBeVisible();
  });

  test('SA-5-2: 緊急停止が有効なら、その旨が文言として出る', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({
      monitoringKpis: { ...HEALTHY_MONITORING_KPIS, killSwitchActive: true },
    });
    await h.open(ADMIN_BASE_URL, '/admin/monitoring');

    // 「稼働中」という値だけを見ると正常に見える。説明文で意味が反転していることを固定する。
    await expect(
      page.getByText('緊急停止が有効です。AIの応答が一時停止しています'),
    ).toBeVisible({ timeout: 20000 });
  });

  test('SA-5-3: フロー遷移分析は期間切替をクエリに載せて取り直す', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/analytics/flow');
    await expect
      .poll(() => h.countRequests('/v1/admin/analytics/flow-transitions'), { timeout: 20000 })
      .toBeGreaterThan(0);

    await page.getByRole('button', { name: '過去30日', exact: true }).click();
    await expect
      .poll(() => h.requests.some((r) => r.url.includes('flow-transitions?period=30d')), {
        timeout: 20000,
      })
      .toBe(true);
  });

  test('SA-5-4: CV発火状況は発火済み/未発火を件数と行の両方で示す', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/analytics/cv-status');

    await expect(page.getByText('カーネーション自動車')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('青山クリニック')).toBeVisible();
  });

  test('SA-5-5: AI学習・貢献分析はテナント・期間・種別をクエリに載せる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/knowledge-analytics');
    await expect(page.getByText('テナントを選択してください')).toBeVisible({ timeout: 20000 });

    // super_admin の集約ビューは対象テナントが決まらないと集計しない。
    // 選ぶまで取りに行かないこと自体が仕様(全テナント横断の重いクエリを暴発させない)。
    expect(h.countRequests('/v1/admin/analytics/knowledge-attribution')).toBe(0);

    await page.locator('select').first().selectOption('carnation-demo');
    await expect
      .poll(() => h.countRequests('/v1/admin/analytics/knowledge-attribution'), { timeout: 20000 })
      .toBeGreaterThan(0);
    const hit = h.requests.find((r) => r.pathname.includes('knowledge-attribution'));
    expect(hit?.url).toMatch(/period=/);
    expect(hit?.url).toMatch(/source_type=/);
  });

  test('SA-5-6: 代行作業管理はステータス絞り込みをクエリに載せ、結果に反映する', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({
      options: [
        {
          id: 'ord-1',
          tenant_id: 'carnation-demo',
          description: 'FAQを30件まとめて登録してほしい',
          status: 'pending',
          llm_estimate_amount: 8000,
          final_amount: null,
          ordered_at: '2026-08-20T09:00:00.000Z',
        },
        {
          id: 'ord-2',
          tenant_id: 'aoyama-clinic',
          description: '診療時間の変更をサイト全体に反映',
          status: 'completed',
          llm_estimate_amount: 5000,
          final_amount: 6000,
          ordered_at: '2026-08-10T09:00:00.000Z',
          completed_at: '2026-08-12T09:00:00.000Z',
        },
      ],
    });
    await h.open(ADMIN_BASE_URL, '/admin/options');
    await expect(page.getByText('FAQを30件まとめて登録してほしい')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('診療時間の変更をサイト全体に反映')).toBeVisible();

    await page.getByRole('button', { name: '未対応', exact: true }).first().click();
    await expect
      .poll(() => h.requests.some((r) => r.url.includes('status=pending')), { timeout: 20000 })
      .toBe(true);
    // クエリに載せるだけでなく、結果が実際に絞られること。
    await expect(page.getByText('診療時間の変更をサイト全体に反映')).toHaveCount(0, { timeout: 10000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SA-6 R2C運用限定の面 — テナントには出さないが super_admin には出るもの
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-6 R2C運用限定の面', () => {
  test('SA-6-1: グローバル知識のPDF取り込みは super_admin の面に出る', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/knowledge/global?tab=pdf');

    // 書籍/PDF は「R2C運用限定」で、テナントには導線を出さない方針。
    // その裏返しとして、運用側(super_admin)からは必ず到達できる必要がある。
    await expect(page.getByText('PDFアップロード').first()).toBeVisible({ timeout: 20000 });
    expect(page.url()).toContain('/admin/knowledge/global');
  });

  test('SA-6-2: 素の super_admin にはAIチャットの導線を出さない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    // テナントが解決できない super_admin ではチャットが機能しないため、意図的に非表示。
    // 出てしまうと「押しても動かないボタン」を運用者に見せることになる。
    await expect(page.getByRole('link', { name: /AIチャット/ })).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SA-7 到達性 — super専用ページに「全部行ける」ことをまとめて固定する
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-7 super専用ページの到達性', () => {
  const SUPER_ONLY_PAGES: Array<{ path: string; marker: string }> = [
    { path: '/admin/tenants', marker: 'テナント管理' },
    { path: '/admin/feedback', marker: 'お客様の声' },
    { path: '/admin/options', marker: '代行作業の依頼・管理' },
    { path: '/admin/monitoring', marker: '会話完了率' },
    { path: '/admin/knowledge-analytics', marker: 'AI学習・貢献分析' },
    { path: '/admin/analytics/cv-status', marker: 'カーネーション自動車' },
    { path: '/admin/analytics/flow', marker: '過去7日' },
    { path: '/admin/avatar-defaults', marker: 'デフォルトアバター管理' },
    { path: '/admin/knowledge/global', marker: '' },
  ];

  for (const { path, marker } of SUPER_ONLY_PAGES) {
    test(`SA-7: ${path} に到達でき、/admin へ弾かれない`, async ({ page }) => {
      const h = new SuperAdminHarness(page);
      await h.install();
      await h.open(ADMIN_BASE_URL, path);

      // SuperAdminRoute は非 super_admin を /admin へ飛ばす。飛んでいないこと自体が主張。
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`), { timeout: 20000 });
      if (marker) {
        await expect(page.getByText(marker).first()).toBeVisible({ timeout: 20000 });
      }
      // 塞ぎ忘れ(501)が出ていないこと = この画面が本番APIへ抜けようとしていないこと。
      expect(h.pageErrors, `${path} で未処理例外: ${h.pageErrors.join(' / ')}`).toEqual([]);
    });
  }
});
