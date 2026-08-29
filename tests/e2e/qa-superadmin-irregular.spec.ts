// tests/e2e/qa-superadmin-irregular.spec.ts
//
// super_admin ロールの管理画面を「壊れやすいところ」から突く。
// qa-superadmin-journey.spec.ts が「意図どおりに使えば通る道」を押さえるのに対し、
// こちらは以下だけを扱う:
//   A. 不可逆操作(キー失効・削除・作成)の確認と連打
//   B. 入力の境界値(空白・不正形式・極端な長さ・記号)
//   C. サーバ返却値の境界(欠損・0件・大量・不正な日付・生HTML)
//   D. 通信の異常系(5xx・404・切断・認証切れ)
//   E. 権限境界(プレビュー中の降格・存在しないテナント)
//   F. 画面をまたぐ状態(リロード・戻る・絞り込みとの相互作用)
//   G. 狭い画面
//
// super_admin の操作は他人のテナントに直接効くため、
// 「押していないのに飛んだ」「1回のつもりが2回飛んだ」を回数で数える。
// 本番へ到達しない理由は helpers/superAdminHarness.ts の冒頭コメント参照。

import { test, expect, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './config';
import {
  DEFAULT_TENANTS,
  HEALTHY_MONITORING_KPIS,
  SuperAdminHarness,
  superAdminAuthReady,
  type TenantRow,
} from './helpers/superAdminHarness';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const SA_READY = superAdminAuthReady();

const DETAIL = '/admin/tenants/carnation-demo';

test.beforeEach(() => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.skip(
    !SA_READY,
    'super_admin storageState 未生成/期限切れ — `pnpm exec playwright test --project=superadmin-setup` を先に実行',
  );
});

/** テナント詳細のタブを開く。 */
async function tab(page: Page, label: string): Promise<void> {
  const button = page.getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible({ timeout: 20000 });
  await button.click();
}

/** 次に出る window.confirm を承諾する(既定では Playwright が自動で却下する)。 */
function acceptNextConfirm(page: Page): void {
  page.once('dialog', (dialog) => void dialog.accept());
}

// ───────────────────────────────────────────────────────────────────────────
// A. 不可逆操作 — 確認・連打・楽観更新
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-A 不可逆操作', () => {
  test('SA-I-A-1: APIキー失効の確認を断ると、失効リクエストは1件も飛ばない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');
    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });

    // ダイアログにハンドラを付けない = Playwright が自動で「キャンセル」する。
    await page.getByRole('button', { name: '🔒 無効化' }).click();

    // 「元に戻せません」と警告した操作が、断ったのに実行される事故を塞ぐ。
    // 「起きなかったこと」には待つべきイベントが無いため、成功時に必ず出るトーストが
    // 出ないことを待ってから回数を数える(固定待ちを最短で1つだけ使う)。
    await expect(page.getByText('🔒 APIキーを無効化しました')).toHaveCount(0, { timeout: 2000 });
    expect(h.countWrites('/keys/', 'DELETE')).toBe(0);
    // 画面上も有効なまま。
    await expect(page.getByText('無効化済み', { exact: true })).toHaveCount(1);
  });

  test('SA-I-A-2: 確認を承諾すると失効は1回だけ飛び、その行だけが無効化済みになる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');
    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });

    acceptNextConfirm(page);
    await page.getByRole('button', { name: '🔒 無効化' }).click();

    await expect(page.getByText('🔒 APIキーを無効化しました')).toBeVisible({ timeout: 20000 });
    expect(h.countWrites('/keys/', 'DELETE')).toBe(1);
    expect(h.requests.find((r) => r.method === 'DELETE')?.pathname).toContain('key-active-1');
    await expect(page.getByText('無効化済み', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: '🔒 無効化' })).toHaveCount(0);
  });

  test('SA-I-A-3: 失効ボタンを連打しても失効は1回しか実行されない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    // 応答を遅らせて「送信中」の窓を広げる。押しっぱなしの運用者を再現する。
    h.fail('/keys/', { status: 200, body: { ok: true }, delayMs: 1200, method: 'DELETE' });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');
    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });

    const button = page.getByRole('button', { name: '🔒 無効化' });
    // 連打のたびに confirm が出る。すべて承諾する = 運用者が勢いで通す最悪ケース。
    page.on('dialog', (d) => void d.accept());
    await button.click({ force: true });
    await button.click({ force: true, timeout: 1500 }).catch(() => { /* disabled/消滅で押せない = 正常 */ });
    await button.click({ force: true, timeout: 1500 }).catch(() => { /* 同上 */ });

    await expect.poll(() => h.countWrites('/keys/', 'DELETE'), { timeout: 20000 }).toBeGreaterThan(0);
    expect(h.countWrites('/keys/', 'DELETE')).toBe(1);
  });

  test('SA-I-A-4: フィードバック削除は2段階で、1回目の「削除」では消えない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/feedback');
    await expect(page.getByRole('heading', { name: /お客様の声/ })).toBeVisible({ timeout: 20000 });
    await page.getByText('在庫の確認方法が分かりませんでした').first().click();

    await page.getByRole('button', { name: '削除', exact: true }).click();
    await expect(page.getByRole('button', { name: '本当に削除', exact: true })).toBeVisible();
    // 1回目で消えたら、ラベルの「本当に削除」は嘘になる。
    expect(h.countWrites('/v1/admin/feedback/fb-1', 'DELETE')).toBe(0);

    await page.getByRole('button', { name: '本当に削除', exact: true }).click();
    await expect.poll(() => h.countWrites('/v1/admin/feedback/fb-1', 'DELETE'), { timeout: 20000 }).toBe(1);
  });

  test('SA-I-A-5: 削除待ちのまま閉じて別の1件を開いても、確認状態は持ち越さない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/feedback');
    await expect(page.getByRole('heading', { name: /お客様の声/ })).toBeVisible({ timeout: 20000 });

    await page.getByText('在庫の確認方法が分かりませんでした').first().click();
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await expect(page.getByRole('button', { name: '本当に削除', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'キャンセル', exact: true }).click();

    // 別の1件を開いたとき、前の確認状態が残っていると1クリックで他人の声が消える。
    await page.getByText('予約の時間帯を選べるようにしてほしい').first().click();
    await expect(page.getByRole('button', { name: '削除', exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: '本当に削除', exact: true })).toHaveCount(0);
    expect(h.countWrites('/v1/admin/feedback/fb-2', 'DELETE')).toBe(0);
  });

  test('SA-I-A-6: テナント作成の連打で二重作成されない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    h.fail('/v1/admin/tenants', {
      status: 201,
      body: { tenant: { id: 'dup-shop', name: 'dup', plan: 'starter', is_active: true, created_at: '2026-08-27T00:00:00.000Z' } },
      delayMs: 1200,
      method: 'POST',
    });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: /新しいテナントを追加/ }).click();
    await page.getByPlaceholder('例: カーネーション自動車').fill('二重作成テスト');
    await page.getByPlaceholder('例: carnation-auto').fill('dup-shop');

    const submit = page.getByRole('button', { name: /テナントを作成する/ });
    await submit.click();
    await submit.click({ force: true, timeout: 1500 }).catch(() => { /* disabled なら押せない = 正常 */ });
    await submit.click({ force: true, timeout: 1500 }).catch(() => { /* 同上 */ });

    await expect.poll(() => h.countWrites('/v1/admin/tenants', 'POST'), { timeout: 20000 }).toBeGreaterThan(0);
    expect(h.countWrites('/v1/admin/tenants', 'POST')).toBe(1);
  });

  test('SA-I-A-7: 失効が失敗したら、その行を無効化済みに見せない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    h.fail('/keys/', { status: 500, method: 'DELETE' });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');
    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });

    acceptNextConfirm(page);
    await page.getByRole('button', { name: '🔒 無効化' }).click();

    await expect(page.getByText(/無効化に失敗しました/)).toBeVisible({ timeout: 20000 });
    // 失効できていないのに「無効化済み」と表示すると、運用者は生きている鍵を
    // 死んだものとして扱う(=漏洩したキーを放置する)。
    await expect(page.getByText('無効化済み', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '🔒 無効化' })).toHaveCount(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. 入力の境界値
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-B 入力の境界値', () => {
  test('SA-I-B-1: スラッグは大文字を自動で小文字化し、記号は弾いて送信させない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await page.getByRole('button', { name: /新しいテナントを追加/ }).click();

    const name = page.getByPlaceholder('例: カーネーション自動車');
    const slug = page.getByPlaceholder('例: carnation-auto');
    const submit = page.getByRole('button', { name: /テナントを作成する/ });

    await name.fill('境界値テスト');
    await slug.fill('Carnation_Auto');
    // 大文字は小文字化されるが、アンダースコアは許可されない。
    await expect(slug).toHaveValue('carnation_auto');
    await expect(page.getByText('英小文字・数字・ハイフンのみ使用できます')).toBeVisible();
    await expect(submit).toBeDisabled();

    await slug.fill('carnation-auto');
    await expect(submit).toBeEnabled();
    expect(h.countWrites('/v1/admin/tenants', 'POST')).toBe(0);
  });

  test('SA-I-B-2: 空白だけのテナント名では作成できない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await page.getByRole('button', { name: /新しいテナントを追加/ }).click();

    await page.getByPlaceholder('例: カーネーション自動車').fill('   ');
    await page.getByPlaceholder('例: carnation-auto').fill('blank-name');
    await expect(page.getByRole('button', { name: /テナントを作成する/ })).toBeDisabled();
    expect(h.countWrites('/v1/admin/tenants', 'POST')).toBe(0);
  });

  // 【未修正の欠陥】SettingsTab.tsx の handleSave は name.trim() をそのまま送るだけで、
  // 空になったことを検証しない。空白だけを入力すると name:"" で PATCH が飛ぶ。
  // 作成モーダル側は name.trim().length > 0 を canSubmit の条件にしており(SA-I-B-2)、
  // 「作れないものが更新では作れてしまう」非対称になっている。
  // テナント名は一覧・プレビューバナー・請求の宛名にまで出るため、空になると
  // どの会社か画面から判別できなくなる。
  // 修正されたらこのテストが「予期せず成功」して落ちるので、そこで fail 指定を外すこと。
  test('SA-I-B-3: 既存テナントの名前を空白だけにして保存しても、空の名前は送らない', async ({ page }) => {
    test.fail();
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    await page.locator('form input[type="text"]').first().fill('    ');
    await page.getByRole('button', { name: /設定を保存する/ }).click();

    // 名前は一覧・プレビューバナー・請求書の宛名にまで出る。空にできてしまうと
    // 「名前の無いテナント」が全画面に現れ、どの会社か判別できなくなる。
    // 作成時は空白だけを弾く(SA-I-B-2)のに、更新時だけ素通りするのは非対称。
    //
    // 押しても何も起きないまま緑になるのを防ぐため、まず「保存の結果」が
    // 画面に出るまで待つ。成功トーストでも拒否表示でも良い。
    await expect(
      page
        .getByText('✅ 設定を保存しました')
        .or(page.getByText('保存に失敗しました。もう一度お試しください 🙏')),
    ).toBeVisible({ timeout: 20000 });

    const writes = h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH');
    const sentName = h.lastBody('/v1/admin/tenants/carnation-demo')?.name;
    expect(
      writes === 0 || (typeof sentName === 'string' && sentName.trim().length > 0),
      `空白だけの名前が保存された(PATCH ${writes}回, name=${JSON.stringify(sentName)})`,
    ).toBe(true);
  });

  test('SA-I-B-4: httpsで始まらない許可ドメインは保存前に弾き、PATCHを飛ばさない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    await page
      .getByPlaceholder(/https:\/\/shop\.example\.com/)
      .fill('http://shop.example.com');
    await page.getByRole('button', { name: /設定を保存する/ }).click();

    await expect(page.getByText(/URLはhttps:\/\/で始まる必要があります/)).toBeVisible();
    expect(h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH')).toBe(0);
  });

  test('SA-I-B-5: ワイルドカードは *.example.com の形だけを通す', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    const origins = page.getByPlaceholder(/https:\/\/shop\.example\.com/);
    const save = page.getByRole('button', { name: /設定を保存する/ });

    // https://* は全オリジン許可と同義。これを通すとCORSの意味が消える。
    for (const bad of ['https://*', 'https://*evil.com', 'https://*.a.*.com']) {
      await origins.fill(bad);
      await save.click();
      await expect(
        page.getByText(/ワイルドカードは https:\/\/\*\.example\.com の形のみ/),
        `${bad} が通ってしまった`,
      ).toBeVisible();
    }
    expect(h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH')).toBe(0);

    await origins.fill('https://*.example.com');
    await save.click();
    await expect.poll(() => h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH'), { timeout: 20000 }).toBe(1);
  });

  test('SA-I-B-6: 許可ドメインを空にすると警告は出るが、保存自体はブロックしない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    await page.getByPlaceholder(/https:\/\/shop\.example\.com/).fill('');
    await page.getByRole('button', { name: /設定を保存する/ }).click();

    // 意図的に空にする運用があるため、警告は出しても止めない、が仕様。
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 20000 });
    await expect.poll(() => h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH'), { timeout: 20000 }).toBe(1);
    expect(h.lastBody('/v1/admin/tenants/carnation-demo')?.allowed_origins).toEqual([]);
  });

  test('SA-I-B-7: 1万字を貼っても上限5000字で頭打ちになり、画面が横に伸びない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    const long = 'あ'.repeat(10000);
    await page.getByPlaceholder(/あなたは丁寧な自動車販売アシスタント/).fill(long);
    // maxLength=5000。上限を超えた分は黙って捨てられるため、残量表示で気付けること。
    await expect(page.getByText('5000 / 5000')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /設定を保存する/ }).click();

    await expect.poll(() => h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH'), { timeout: 20000 }).toBe(1);
    expect(String(h.lastBody('/v1/admin/tenants/carnation-demo')?.system_prompt ?? '')).toHaveLength(5000);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'ページ全体が横スクロールしている').toBeLessThanOrEqual(1);
  });

  // 【未修正の欠陥】BillingSection.tsx の handleSave は開始日と終了日の前後関係を
  // 一切検証しない。終了日の min={開始日} は「開始日 → 終了日」の順に入れた時にしか
  // 効かず、終了日を先に入れてから開始日を後ろへずらす直し方には無力。
  // 反転した期間は isFreePeriodActive も isFreePeriodScheduled も false になるため、
  // 画面には「無料期間中」も「予約済み」も出ない。運用者は無料にしたつもりのまま
  // Stripe へ使用量が送られ続け、請求が届くまで誰も気付けない。
  // 修正されたらこのテストが「予期せず成功」して落ちるので、そこで fail 指定を外すこと。
  test('SA-I-B-8: 無料期間の開始日が終了日より後でも、そのまま保存されない', async ({ page }) => {
    test.fail();
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    // 開始 > 終了。終了日には min={開始日} が付くが、先に終了日を入れてから
    // 開始日を後ろへずらす操作(=よくある直し方)には効かない。
    const dates = page.locator('input[type="date"]');
    await dates.nth(1).fill('2026-09-30');
    await dates.nth(0).fill('2026-12-01');
    await page.getByRole('button', { name: /課金設定を保存/ }).click();

    // この組み合わせは「無料期間中」にも「予約済み」にもならない。
    // 無言で保存されると、運用者は無料にしたつもりのテナントに課金し続ける
    // (画面上は何の警告も出ないため、請求が届くまで気付けない)。
    await expect(
      page.getByText(/開始日|終了日|期間/).filter({ hasText: /誤|逆|後|正しく|確認/ }).first(),
      '開始>終了を警告していない',
    ).toBeVisible({ timeout: 3000 });
    expect(h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH')).toBe(0);
  });

  test('SA-I-B-9: 既定アバター画像は5MB超をアップロード前に断る(通信させない)', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/avatar-defaults');
    await expect(page.getByText('デフォルトアバター管理')).toBeVisible({ timeout: 20000 });

    // 6MB。ブラウザ側で断らないと、上り回線と保存先を無駄に消費したうえで
    // サーバの上限エラーを見せることになる。
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'too-big.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(6 * 1024 * 1024, 1),
    });

    await expect(page.getByText('ファイルサイズは5MB以下にしてください')).toBeVisible({ timeout: 10000 });
    expect(h.countWrites('/v1/admin/avatar/defaults/upload', 'POST')).toBe(0);
  });

  test('SA-I-B-10: 検索に正規表現メタ文字を入れても落ちず、0件表示になる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await page.getByPlaceholder('テナントを検索...').fill('.*(');
    await expect(page.getByText('条件に一致するテナントがありません')).toBeVisible({ timeout: 5000 });
    expect(h.pageErrors).toEqual([]);
  });

  test('SA-I-B-11: 検索はテナント名にしか効かない(slug で引けないことを明示する)', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    // 運用者は slug(carnation-demo)を手掛かりに探すことが多い。現状は名前一致のみ。
    // 仕様として固定しておき、変えるなら意図的に変える(黙って挙動が入れ替わらないように)。
    await page.getByPlaceholder('テナントを検索...').fill('carnation-demo');
    await expect(page.getByText('条件に一致するテナントがありません')).toBeVisible({ timeout: 5000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C. サーバ返却値の境界
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-C 返却値の境界', () => {
  test('SA-I-C-1: テナント0件と「絞り込みで0件」を別の文言で出し分ける', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({ tenants: [] });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');

    await expect(page.getByText('テナントがまだ登録されていません')).toBeVisible({ timeout: 20000 });
    // 「登録が無い」と「絞り込んだ結果0件」を同じ文言にすると、運用者はデータ消失を疑う。
    await expect(page.getByText('条件に一致するテナントがありません')).toHaveCount(0);
  });

  test('SA-I-C-2: created_at が不正な値でもクラッシュせず "-" になる', async ({ page }) => {
    const tenants: TenantRow[] = [
      { ...DEFAULT_TENANTS[0], created_at: 'not-a-date' },
      { ...DEFAULT_TENANTS[1], created_at: '' },
    ];
    const h = new SuperAdminHarness(page);
    await h.install({ tenants });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');

    await expect(page.getByText('カーネーション自動車', { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('作成日: -')).toHaveCount(2);
    expect(h.pageErrors).toEqual([]);
  });

  test('SA-I-C-3: 300件返しても描画され、絞り込みが続けられる', async ({ page }) => {
    const tenants: TenantRow[] = Array.from({ length: 300 }, (_, i) => ({
      id: `t-${i}`,
      name: `テナント${String(i).padStart(3, '0')}`,
      plan: 'starter',
      is_active: i % 3 !== 0,
      created_at: new Date(Date.UTC(2026, 0, 1 + (i % 28))).toISOString(),
    }));
    const h = new SuperAdminHarness(page);
    await h.install({ tenants });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');

    await expect(page.getByText('テナント000', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByPlaceholder('テナントを検索...').fill('テナント299');
    await expect(page.getByText('テナント299', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(h.pageErrors).toEqual([]);
  });

  test('SA-I-C-4: 監視KPIの数値が欠けていても、画面全体が起動エラーに落ちない', async ({ page }) => {
    // 過去に flow-transitions のフィールド名ドリフトで
    // 「undefined を読んで TypeError → #root ごと起動エラー画面」になった前例がある
    // (admin-ui/src/pages/admin/analytics/flowTransitions.schema.ts の冒頭)。
    // 監視画面は data.completionRate.toFixed(1) を無検査で呼ぶため、同じ形の事故が起きうる。
    // 【未修正の欠陥】monitoring/index.tsx の kpiCards は
    // data.completionRate.toFixed(1) のように応答を無検査で数値として扱う。
    // 1フィールドが null/欠損なだけで描画中に TypeError となり、index.html の
    // グローバル error ハンドラが #root ごと「起動エラー」画面へ差し替える。
    // 障害調査に使う画面が、障害時の欠損データで真っ先に落ちる。
    test.fail();
    const h = new SuperAdminHarness(page);
    await h.install({
      monitoringKpis: { ...HEALTHY_MONITORING_KPIS, completionRate: null, searchP95Ms: null },
    });
    await h.open(ADMIN_BASE_URL, '/admin/monitoring');

    await expect(page.getByText('起動エラー')).toHaveCount(0, { timeout: 20000 });
    // 数値が出せないなら出せないと言えばよく、画面を落とす理由にはならない。
    const body = (await page.textContent('body')) ?? '';
    expect(body.length, '画面が空になっている').toBeGreaterThan(200);
  });

  test('SA-I-C-5: フロー遷移の必須フィールドが欠けても、画面全体は生き残る', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({ flowTransitions: { period: '7d' } });
    await h.open(ADMIN_BASE_URL, '/admin/analytics/flow');

    await expect(page.getByText('起動エラー')).toHaveCount(0, { timeout: 20000 });
    const body = (await page.textContent('body')) ?? '';
    expect(body.length).toBeGreaterThan(200);
  });

  test('SA-I-C-6a: APIキーの prefix が欠けても "undefined" を見せない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({
      apiKeys: [
        // サーバ側の返却名が変わった/欠けた場合を再現する。
        { id: 'key-x', key_prefix: '', is_active: true, created_at: '2026-02-01T09:00:00.000Z', last_used_at: null },
      ],
    });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');

    await expect(page.getByRole('button', { name: '🔒 無効化' })).toBeVisible({ timeout: 20000 });
    const body = (await page.textContent('body')) ?? '';
    expect(body, '未定義値がそのまま画面に出ている').not.toContain('undefined');
  });

  // 【未修正の欠陥】ApiKeysTab.tsx の formatDate は new Date(iso) を検証せずに
  // toLocaleDateString へ渡すため、不正な日付が "Invalid Date" として画面に出る。
  // テナント一覧側(index.tsx)は同じ状況で "-" にフォールバックしており、
  // 同じ製品の中で扱いが割れている。
  // 修正されたらこのテストが「予期せず成功」して落ちるので、そこで fail 指定を外すこと。
  test('SA-I-C-6b: APIキーの作成日が不正な値でも "Invalid Date" を見せない', async ({ page }) => {
    test.fail();
    const h = new SuperAdminHarness(page);
    await h.install({
      apiKeys: [
        { id: 'key-x', key_prefix: 'r2c_live_cccc', is_active: true, created_at: 'bad-date', last_used_at: null },
      ],
    });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');

    await expect(page.getByRole('button', { name: '🔒 無効化' })).toBeVisible({ timeout: 20000 });
    const body = (await page.textContent('body')) ?? '';
    expect(body, '不正な日付がそのまま画面に出ている').not.toContain('Invalid Date');
  });

  test('SA-I-C-7: 計測ヘルスの応答が欠けても、監視画面ごと落ちない', async ({ page }) => {
    // KPI と計測ヘルスは別々に取得され、コード上も「片方の失敗がもう片方の表示を
    // 止めない」意図で state を分けている。しかし応答が 200 で返りつつ中身が
    // 欠けている場合は catch に入らないため、描画時に落ちる。
    // 【未修正の欠陥】200 で返りつつ中身が欠けている場合は catch に入らないため、
    // state を分けた意図(片方の失敗がもう片方を止めない)が効かない。
    test.fail();
    const h = new SuperAdminHarness(page);
    await h.install({ measurementHealth: { sourceBreakdown: [] } });
    await h.open(ADMIN_BASE_URL, '/admin/monitoring');

    // 少なくとも KPI 側(会話完了率など)は読めているべき。
    await expect(page.getByText('起動エラー')).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByText('会話完了率', { exact: true })).toBeVisible();
  });

  // 【未修正の欠陥】options/index.tsx の行描画が item.description.length を
  // 無検査で読む。1件でも説明が欠けた発注が混ざると「代行作業管理」の画面全体が
  // 起動エラーになり、他の正常な発注も処理できなくなる。
  // 修正されたらこのテストが「予期せず成功」して落ちるので、そこで fail 指定を外すこと。
  test('SA-I-C-8: 代行作業の説明が欠けた行があっても、一覧全体が落ちない', async ({ page }) => {
    test.fail();
    const h = new SuperAdminHarness(page);
    await h.install({
      options: [
        {
          id: 'ord-ok',
          tenant_id: 'carnation-demo',
          description: '正常な依頼',
          status: 'pending',
          ordered_at: '2026-08-20T09:00:00.000Z',
        },
        // 説明が欠けた1件。行描画が description.length を無検査で読むため、
        // 1件の欠損で「代行作業管理」の画面全体が使えなくなる。
        {
          id: 'ord-broken',
          tenant_id: 'aoyama-clinic',
          description: undefined as unknown as string,
          status: 'pending',
          ordered_at: '2026-08-21T09:00:00.000Z',
        },
      ],
    });
    await h.open(ADMIN_BASE_URL, '/admin/options');

    await expect(page.getByText('起動エラー')).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByText('正常な依頼')).toBeVisible();
  });

  test('SA-I-C-9: テナント名に生HTMLが混ざってもDOMとして実行されない', async ({ page }) => {
    const tenants: TenantRow[] = [
      {
        ...DEFAULT_TENANTS[0],
        name: '<img src=x onerror="window.__xss=1">悪意テナント',
      },
    ];
    const h = new SuperAdminHarness(page);
    await h.install({ tenants });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');

    // テナント名はテナント自身が名乗る値。super_admin の画面で実行されると
    // 全テナントを操作できるセッションが乗っ取られる。
    await expect(page.getByText('悪意テナント', { exact: false })).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D. 通信の異常系
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-D 通信の異常系', () => {
  test('SA-I-D-1: 一覧取得が5xxでもエラー文言が出て、画面は壊れない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({ failures: { '/v1/admin/tenants': { status: 500, method: 'GET' } } });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');

    await expect(page.getByText('テナント一覧の読み込みに失敗しました')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible();
    expect(h.pageErrors).toEqual([]);
  });

  test('SA-I-D-2a: 存在しないテナントは「見つかりませんでした」と言う', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    // 存在しないIDは 404 を返す(resolveTenantDetail が null)。
    await h.open(ADMIN_BASE_URL, '/admin/tenants/no-such-tenant');
    await expect(page.getByText('テナントが見つかりませんでした 🙏').first()).toBeVisible({ timeout: 20000 });
  });

  test('SA-I-D-2b: 詳細取得が5xxのときは「読み込みに失敗」と言う(404と混ぜない)', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({ failures: { '/v1/admin/tenants/carnation-demo': { status: 500, method: 'GET' } } });
    await h.open(ADMIN_BASE_URL, DETAIL);
    // 「見つからない」と「一時的に落ちている」は運用者の次の行動が違う(諦める/再試行)。
    // 同じ文言にすると、復旧すれば直る障害をデータ消失として扱ってしまう。
    await expect(page.getByText(/読み込みに失敗しました/).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('テナントが見つかりませんでした 🙏')).toHaveCount(0);
  });

  test('SA-I-D-3: 保存が失敗しても、打ち込んだ内容が消えない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    h.fail('/v1/admin/tenants/carnation-demo', { status: 500, method: 'PATCH' });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    const nameInput = page.locator('form input[type="text"]').first();
    await nameInput.fill('保存失敗テスト');
    await page.getByRole('button', { name: /設定を保存する/ }).click();

    await expect(page.getByText(/保存に失敗しました/)).toBeVisible({ timeout: 20000 });
    // 失敗のたびに入力が飛ぶと、長いシステムプロンプトを打ち直すことになる。
    await expect(nameInput).toHaveValue('保存失敗テスト');
    await expect(page.getByRole('button', { name: /設定を保存する/ })).toBeEnabled();
  });

  test('SA-I-D-4: 通信が切れても画面は壊れず、そのまま再試行できる', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    h.fail('/v1/admin/tenants/carnation-demo', { status: 0, abort: true, once: true, method: 'PATCH' });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    await page.locator('form input[type="text"]').first().fill('切断テスト');
    await page.getByRole('button', { name: /設定を保存する/ }).click();
    await expect(page.getByText(/保存に失敗しました/)).toBeVisible({ timeout: 20000 });

    // once 指定なので2回目は通る。
    await page.getByRole('button', { name: /設定を保存する/ }).click();
    await expect(page.getByText('✅ 設定を保存しました')).toBeVisible({ timeout: 20000 });
    expect(h.pageErrors).toEqual([]);
  });

  test('SA-I-D-5: 応答が遅い間は保存ボタンが押せず、二重保存にならない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    h.fail('/v1/admin/tenants/carnation-demo', {
      status: 200,
      body: { tenant: DEFAULT_TENANTS[0] },
      delayMs: 1500,
      method: 'PATCH',
    });
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    const save = page.getByRole('button', { name: /設定を保存する|保存中/ });
    await save.click();
    await expect(page.getByRole('button', { name: /保存中/ })).toBeDisabled({ timeout: 5000 });
    await expect
      .poll(() => h.countWrites('/v1/admin/tenants/carnation-demo', 'PATCH'), { timeout: 20000 })
      .toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E. 権限境界
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-E 権限境界', () => {
  test('SA-I-E-1: プレビュー中はテナント横断APIを叩かない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await page.getByRole('button', { name: /クライアントビューで見る/ }).click();
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });

    h.resetRecording();
    await page.goto(`${ADMIN_BASE_URL}/admin/feedback`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });

    // 「client_admin にはこう見える」を確認する画面から、
    // 全テナント分のフィードバック一覧を取りに行っていたら降格が効いていない。
    const crossTenant = h.requests.filter((r) => r.pathname === '/v1/admin/tenants');
    expect(crossTenant, `横断API呼び出し: ${crossTenant.map((r) => r.url).join(', ')}`).toEqual([]);

    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect(page.getByText(/プレビューモード/)).toHaveCount(0, { timeout: 20000 });
  });

  test('SA-I-E-2: 存在しないテナントの詳細URLを直打ちしても、書き込み導線を出さない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants/%E3%83%86%E3%82%B9%E3%83%88');

    await expect(page.getByText('テナントが見つかりませんでした 🙏').first()).toBeVisible({ timeout: 20000 });
    // 対象が解決できていないのに保存・失効・招待が押せると、宛先不明の書き込みが飛ぶ。
    await expect(page.getByRole('button', { name: /設定を保存する/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /新しいAPIキーを発行/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /クライアントビューで見る/ })).toHaveCount(0);
  });

  test('SA-I-E-3: プレビューを終えると、super専用APIが再び使える', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await page.getByRole('button', { name: /クライアントビューで見る/ }).click();
    await expect(page.getByText(/プレビューモード/)).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect(page.getByText(/プレビューモード/)).toHaveCount(0, { timeout: 20000 });

    // 降格が解除されない(=プレビューを抜けても管理機能が戻らない)と、
    // 一度プレビューに入っただけで運用が止まる。
    await h.open(ADMIN_BASE_URL, '/admin/feedback');
    await expect(page.getByRole('heading', { name: /お客様の声/ })).toBeVisible({ timeout: 20000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F. 画面をまたぐ状態
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-F 画面をまたぐ状態', () => {
  test('SA-I-F-1: 開いていたタブはリロードで失われる(URLに乗らない)ことを明示する', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await tab(page, '🔑 APIキー');
    await expect(page.getByText('r2c_live_aaaa****')).toBeVisible({ timeout: 20000 });

    await page.reload({ waitUntil: 'domcontentloaded' });

    // 現状 activeTab はURLに乗らないため、リロード・共有・ブックマークで必ず設定タブに戻る。
    // 「APIキータブのURLを同僚に送る」ができないという運用上の制約を仕様として固定する。
    await expect(page.getByPlaceholder(/https:\/\/shop\.example\.com/)).toBeVisible({ timeout: 20000 });
    expect(page.url()).not.toContain('tab=');
  });

  test('SA-I-F-2: 検索で絞り込んだまま作成すると、作ったテナントが一覧に見えない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await page.getByPlaceholder('テナントを検索...').fill('青山');
    await expect.poll(async () => (await page.getByText('青山クリニック', { exact: true }).count()), { timeout: 5000 }).toBe(1);

    await page.getByRole('button', { name: /新しいテナントを追加/ }).click();
    await page.getByPlaceholder('例: カーネーション自動車').fill('絞り込み中に作成');
    await page.getByPlaceholder('例: carnation-auto').fill('filtered-create');
    await page.getByRole('button', { name: /テナントを作成する/ }).click();

    await expect(page.getByText('✅ テナントを作成しました！')).toBeVisible({ timeout: 20000 });
    // 「作成しました」と言われたのに一覧に現れない。作成できていないと誤解して
    // 二重に作りにいくのが、この画面で最も起きやすい事故。
    // 検索を消せば現れることまで確認して、消失ではないことを示す。
    await expect(page.getByText('絞り込み中に作成', { exact: true })).toHaveCount(0);
    await page.getByPlaceholder('テナントを検索...').fill('');
    await expect(page.getByText('絞り込み中に作成', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('SA-I-F-3: 詳細から戻ると一覧は初期状態で、絞り込みは復元されない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: '無効のみ', exact: true }).click();
    await expect(page.getByText('休止中ストア', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '設定 →' }).first().click();
    await expect(page).toHaveURL(/\/admin\/tenants\/closed-shop$/, { timeout: 20000 });

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });
    // 戻ると一覧は再取得から始まる。読み込み完了(件数表示)を待ってから中身を見る。
    await expect(page.getByText(/全\d+件中/)).toBeVisible({ timeout: 20000 });
    const body = (await page.textContent('body')) ?? '';
    expect(body, `戻った直後の一覧が読み込めていない: ${body.slice(0, 200)}`).not.toContain(
      'テナント一覧の読み込みに失敗しました',
    );
    // 絞り込みがURLに無いため戻ると失われる。数十テナントを順に開く運用では
    // 毎回絞り直すことになる(仕様として固定し、直すなら意図的に直す)。
    await expect(page.getByText('カーネーション自動車', { exact: true })).toBeVisible({ timeout: 20000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G. 狭い画面
// ───────────────────────────────────────────────────────────────────────────

test.describe('SA-I-G 狭い画面', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('SA-I-G-1: テナント詳細の16タブは横スクロールで届き、本文は横に溢れない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install();
    await h.open(ADMIN_BASE_URL, DETAIL);
    await expect(page.getByRole('button', { name: '⚙️ 設定', exact: true })).toBeVisible({ timeout: 20000 });

    // タブ列そのものは横スクロールしてよい。ページ全体が横スクロールするのは駄目。
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'ページ全体が横スクロールしている').toBeLessThanOrEqual(1);

    // 一番端の super専用タブまで到達できること(届かないタブがあると機能ごと使えない)。
    const invite = page.getByRole('button', { name: '✉️ 招待', exact: true });
    await invite.scrollIntoViewIfNeeded();
    await invite.click();
    await expect(page.getByPlaceholder('user@example.com')).toBeVisible({ timeout: 20000 });
  });

  test('SA-I-G-2: 狭い画面でもテナント一覧が横に溢れない', async ({ page }) => {
    const h = new SuperAdminHarness(page);
    await h.install({
      tenants: [
        {
          ...DEFAULT_TENANTS[0],
          // 折り返しの効かない長い名前を入れる(実在しうる: 正式社名+部署名)。
          name: '株式会社カーネーションモータースジャパンホールディングス東日本カスタマーサポート本部',
        },
      ],
    });
    await h.open(ADMIN_BASE_URL, '/admin/tenants');
    await expect(page.getByRole('heading', { name: 'テナント管理' })).toBeVisible({ timeout: 20000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'ページ全体が横スクロールしている').toBeLessThanOrEqual(1);
  });
});
