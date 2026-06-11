import type { Page, Response } from '@playwright/test';

// 本番 (api.r2c.biz) 直撃の page.goto は CI ランナーからの一時的なネットワーク断
// (net::ERR_ABORTED / timeout) で flake する (2026-06-11 PR #346/#347/#349 で実証)。
// テストリトライは障害ウィンドウを跨げないため、goto 単位でバックオフ付き再試行する。
export async function gotoWithRetry(
  page: Page,
  url: string,
  attempts = 3,
): Promise<Response | null> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await page.waitForTimeout(3_000 * (i + 1));
      }
    }
  }
  throw lastError;
}
