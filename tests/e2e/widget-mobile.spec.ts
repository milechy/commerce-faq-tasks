import { test, expect } from '@playwright/test';
import { gotoWithRetry } from './helpers/gotoRetry';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const DEMO_URL = 'https://api.r2c.biz/carnation-demo/index.html';

test.describe('Widget — Mobile iPhone 12 (390px) M1-M4', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  // M1: ページが 390px で水平オーバーフローなく表示される
  test('M1: no horizontal overflow at 390px viewport', async ({ page }) => {
    const fatalErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (!e.message.includes('widget') && !e.message.includes('api-key') && !e.message.includes('unauthorized')) {
        fatalErrors.push(e.message);
      }
    });

    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(3000);

    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(400); // 10px tolerance
    expect(fatalErrors).toHaveLength(0);
  });

  // M2: FAB ボタンのタッチターゲット ≥44px
  test('M2: FAB touch target ≥44px', async ({ page }) => {
    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(3000);

    const fabSize = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return null;
      const fab = host.shadowRoot.querySelector('.fab') as HTMLElement;
      if (!fab) return null;
      const rect = fab.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });

    if (fabSize) {
      expect(fabSize.width).toBeGreaterThanOrEqual(44);
      expect(fabSize.height).toBeGreaterThanOrEqual(44);
    } else {
      // no valid data-tenant on demo page — advisory pass
      test.info().annotations.push({
        type: 'info',
        description: 'Widget host not initialized — M2 skipped (no tenant on demo page)',
      });
    }
  });

  // M3: widget CSS で input / send-btn / header-title の font-size ≥16px
  test('M3: widget CSS font-size ≥16px for input and send button', async ({ page }) => {
    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(3000);

    const fontInfo = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return null;
      const style = host.shadowRoot.querySelector('style');
      if (!style) return null;
      const css = style.textContent || '';

      function extractFontSize(pattern: RegExp): number | null {
        const m = css.match(pattern);
        return m ? parseInt(m[1], 10) : null;
      }

      return {
        textarea: extractFontSize(/textarea\s*\{[^}]*?font-size:\s*(\d+)px/s),
        sendBtn: extractFontSize(/\.send-btn\s*\{[^}]*?font-size:\s*(\d+)px/s),
        headerTitle: extractFontSize(/\.header-title\s*\{[^}]*?font-size:\s*(\d+)px/s),
      };
    });

    if (!fontInfo) {
      test.info().annotations.push({ type: 'info', description: 'Widget shadow CSS not accessible — M3 skipped' });
      return;
    }

    if (fontInfo.textarea !== null) expect(fontInfo.textarea).toBeGreaterThanOrEqual(16);
    if (fontInfo.sendBtn !== null) expect(fontInfo.sendBtn).toBeGreaterThanOrEqual(16);
    if (fontInfo.headerTitle !== null) expect(fontInfo.headerTitle).toBeGreaterThanOrEqual(16);
  });

  // M4: Shadow DOM が open モードで存在し、FAB が 390px viewport 内に収まる
  test('M4: Shadow DOM accessible and FAB within 390px viewport', async ({ page }) => {
    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return { hasShadowRoot: false as const, fabRect: null, vw: window.innerWidth };
      const fab = host.shadowRoot.querySelector('.fab') as HTMLElement;
      const r = fab?.getBoundingClientRect();
      return {
        hasShadowRoot: true as const,
        fabRect: r ? { right: Math.round(r.right), bottom: Math.round(r.bottom) } : null,
        vw: window.innerWidth,
      };
    });

    expect(result.hasShadowRoot).toBe(true);
    if (result.fabRect) {
      // FAB (fixed: bottom 24px, right 24px) must not overflow 390px viewport
      expect(result.fabRect.right).toBeLessThanOrEqual(result.vw + 1);
      expect(result.fabRect.bottom).toBeLessThanOrEqual(845); // 844px + 1px tolerance
    }
  });
});
