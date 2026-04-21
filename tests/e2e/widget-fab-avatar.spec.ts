import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

/**
 * FAB avatar persistence test
 * Verifies that the FAB retains the avatar thumbnail image after chat close/open cycles.
 * Regression guard for the bug where closePanel() replaced avatar img with chat SVG icon.
 *
 * Test target: carnation chat-test page (avatar-configured tenant)
 * Uses Shadow DOM piercing to inspect FAB internals.
 */
test.describe('Widget FAB — Avatar persistence on chat open/close', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  const CHAT_TEST_URL = process.env.E2E_CHAT_TEST_URL || 'https://admin.r2c.biz';

  /** Wait for FAB to appear inside the widget Shadow DOM */
  async function getFabState(page: any) {
    return page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      if (!host || !host.shadowRoot) return null;
      const fab = host.shadowRoot.querySelector('.fab') as HTMLElement | null;
      if (!fab) return null;

      const hasImg = !!fab.querySelector('img');
      const hasVideo = !!fab.querySelector('video');
      const hasSvg = !!fab.querySelector('svg');
      const hasFabMedia = !!fab.querySelector('.fab-media-container');
      const imgSrc = fab.querySelector('img')?.getAttribute('src') ?? null;
      return { hasImg, hasVideo, hasSvg, hasFabMedia, imgSrc };
    });
  }

  test('FAB retains avatar image after chat close (single cycle)', async ({ page }) => {
    // Navigate to carnation demo — widget initializes with avatar config
    const resp = await page.goto('https://api.r2c.biz/carnation-demo/index.html');
    expect(resp?.status()).toBe(200);

    // Wait for widget init + avatar config prefetch (max 8s)
    await page.waitForFunction(
      () => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        return !!host?.shadowRoot?.querySelector('.fab');
      },
      { timeout: 8000 }
    );
    // Additional wait for avatar config fetch
    await page.waitForTimeout(3000);

    const fabBefore = await getFabState(page);
    if (!fabBefore) {
      test.skip(); // Widget not initialized (possibly no avatar configured for this page)
      return;
    }

    // Record whether FAB had avatar image before open
    const hadAvatarBefore = fabBefore.hasImg || fabBefore.hasVideo;

    // Open chat
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const fab = host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab');
      fab?.click();
    });
    await page.waitForTimeout(500);

    // Close chat via close button inside panel
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const closeBtn = host?.shadowRoot?.querySelector<HTMLButtonElement>('.close-btn');
      closeBtn?.click();
    });
    await page.waitForTimeout(500);

    const fabAfter = await getFabState(page);
    expect(fabAfter).not.toBeNull();

    if (hadAvatarBefore) {
      // Avatar was shown before: must persist after close (not degraded to SVG-only)
      expect(fabAfter!.hasImg || fabAfter!.hasVideo).toBe(true);
      expect(fabAfter!.hasSvg && !fabAfter!.hasImg && !fabAfter!.hasVideo).toBe(false);
    } else {
      // No avatar configured: chat SVG icon is correct
      expect(fabAfter!.hasSvg).toBe(true);
    }
  });

  test('FAB retains avatar image across multiple open/close cycles', async ({ page }) => {
    const resp = await page.goto('https://api.r2c.biz/carnation-demo/index.html');
    expect(resp?.status()).toBe(200);

    await page.waitForFunction(
      () => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        return !!host?.shadowRoot?.querySelector('.fab');
      },
      { timeout: 8000 }
    );
    await page.waitForTimeout(3000);

    const fabInitial = await getFabState(page);
    if (!fabInitial || !(fabInitial.hasImg || fabInitial.hasVideo)) {
      test.skip(); // No avatar configured
      return;
    }
    const initialImgSrc = fabInitial.imgSrc;

    // 3 open/close cycles
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
      });
      await page.waitForTimeout(400);

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector<HTMLButtonElement>('.close-btn')?.click();
      });
      await page.waitForTimeout(400);

      const fabState = await getFabState(page);
      expect(fabState!.hasImg || fabState!.hasVideo).toBe(true);
      // Image src must remain the same across cycles
      if (initialImgSrc && fabState!.imgSrc) {
        expect(fabState!.imgSrc).toBe(initialImgSrc);
      }
    }
  });

  test('FAB shows chat SVG icon for non-avatar tenant (demo page without avatar)', async ({ page }) => {
    // Demo page uses a different tenant without avatar configuration
    // If FAB has no avatar image initially, it should have chat SVG — open/close should keep it
    const resp = await page.goto('https://api.r2c.biz/carnation-demo/index.html');
    expect(resp?.status()).toBe(200);

    await page.waitForFunction(
      () => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        return !!host?.shadowRoot?.querySelector('.fab');
      },
      { timeout: 8000 }
    );
    await page.waitForTimeout(3000);

    const fabInitial = await getFabState(page);
    if (!fabInitial) { test.skip(); return; }
    if (fabInitial.hasImg || fabInitial.hasVideo) { test.skip(); return; } // has avatar — wrong test

    // No avatar: should have SVG
    expect(fabInitial.hasSvg).toBe(true);

    // Open/close: should remain SVG
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.close-btn')?.click();
    });
    await page.waitForTimeout(400);

    const fabAfter = await getFabState(page);
    expect(fabAfter!.hasSvg).toBe(true);
    expect(fabAfter!.hasImg).toBe(false);
  });
});
