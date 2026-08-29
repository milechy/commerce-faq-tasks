// tests/smoke/adminUiBootSmoke.spec.ts
//
// admin-ui が「配信はされているが起動しない」状態になっていないかを見る。
// widgetChatSmoke.spec.ts と同じ層(デプロイ直後の実挙動)を admin-ui に対して置く。
//
// なぜ admin-ui だけ別扱いか:
//   - admin-ui は Cloudflare Pages 配信で、main へのマージ = 即本番。VPS の
//     deploy-vps.sh を経由しないため、SCRIPTS/post-deploy-widget-smoke.sh が走らない
//   - よって「デプロイ直後」に相当するのは post-merge。gate-8-post-merge.yml から呼ぶ
//
// 何を見て、何を見ないか:
//   - 見る: SPA が起動し、ログイン画面が描画され、JS例外が0件であること
//   - 見ない: ログイン後の各画面。認証が要るうえ、そこは e2e.yml の schedule 実行
//     (--project=admin-ui)が3時間ごとに担う。post-merge は秘匿情報なしで速く回す
//
// widget.js のような「型検査もlintも通らない配布物」とは違い、admin-ui/src は
// tsc -b と eslint と vite build を通る。未定義参照(2026-08-29 の #1039)の類は
// 構造的に起きない。ここで捕まえたいのは、型では落ちない起動時の実行時エラー
// (環境変数の欠落、初期化順序、CDNキャッシュ由来の不整合)。

import { test, expect } from '@playwright/test';

const ADMIN_BASE = process.env.SMOKE_ADMIN_URL || 'https://admin.r2c.biz';

test.describe('本番スモーク — admin-ui が起動する', () => {
  test('トップを開くとログイン画面が描画され、JS例外が発生しない', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`));

    const failedAssets: string[] = [];
    page.on('response', (res) => {
      const url = res.url();
      // 自分のオリジンのJS/CSSが落ちている = ビルド成果物の配信が壊れている
      if (url.startsWith(ADMIN_BASE) && /\.(js|css)$/.test(url) && res.status() >= 400) {
        failedAssets.push(`${res.status()} ${url}`);
      }
    });

    const res = await page.goto(ADMIN_BASE, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), 'トップが 200 を返さない').toBe(200);

    // SPA がマウントされ、実際に何かを描画していること。
    // #root が空のまま = JSが落ちて起動していない(白画面)。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const root = document.getElementById('root');
            return (root?.textContent ?? '').trim().length;
          }),
        { timeout: 20000, message: '#root が空のまま — SPA が起動していない(白画面)' },
      )
      .toBeGreaterThan(0);

    // 未認証なのでログイン画面へ落ちる。パスワード入力欄が出ることを起動の証跡にする
    // (文言はi18nで変わりうるが、type=password は変わらない)。
    await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 20000 });

    expect(failedAssets, `ビルド成果物の配信が失敗している:\n${failedAssets.join('\n')}`).toEqual([]);
    expect(pageErrors, `ページ内でJS例外が発生した:\n${pageErrors.join('\n---\n')}`).toEqual([]);
  });
});
