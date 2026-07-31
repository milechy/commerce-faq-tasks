import type { Page, Response } from '@playwright/test';

// 本番 (api.r2c.biz) 直撃の page.goto は CI ランナーからの一時的なネットワーク断
// (net::ERR_ABORTED / timeout) で flake する (2026-06-11 PR #346/#347/#349 で実証)。
// テストリトライは障害ウィンドウを跨げないため、goto 単位でバックオフ付き再試行する。
export async function gotoWithRetry(
  page: Page,
  url: string,
  attempts = 3,
  timeoutMs = 8_000,
): Promise<Response | null> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await page.waitForTimeout(1_000 * (i + 1));
      }
    }
  }
  throw lastError;
}

// Asana 1217048228772841: admin.r2c.biz は Cloudflare Pages が main への push で
// 自動デプロイする。admin-ui を含むPRがマージされた直後は、SPAのバンドルが
// 差し替わる最中で HTML シェルは200を返すもののクライアント側のレンダリングが
// 完了せず readySelector が現れない時間帯がある(実測で確認済み)。gotoWithRetry
// とは別の障害モード(gotoの例外ではなく、goto成功後のレンダリング未完了)なので
// 単純なリトライ回数増では解決しない。ページを再読み込みしながら段階的に待つ。
// デプロイ完了までの窓は実測で「数十秒〜」のため、既定は合計90秒・8秒間隔。
export async function waitForAppReady(
  page: Page,
  url: string,
  readySelector: string,
  totalBudgetMs = 90_000,
  perAttemptTimeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + totalBudgetMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const isLastAttempt = Date.now() + perAttemptTimeoutMs >= deadline;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator(readySelector).waitFor({ timeout: perAttemptTimeoutMs });
      return;
    } catch (err) {
      // 最終試行は元のエラーをそのまま投げ直し、失敗理由を分かりやすくする
      if (isLastAttempt) throw err;
      console.warn(`⚠️  waitForAppReady: ${readySelector} 未検出(${attempt}回目)。Cloudflare Pages デプロイ直後の可能性 — 再読み込みして待機を継続します`);
    }
  }
}
