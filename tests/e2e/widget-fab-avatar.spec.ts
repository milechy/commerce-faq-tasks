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

  // アバター設定済みテナントのデモページ (test 1/2 が使用)
  const AVATAR_DEMO_URL =
    process.env.E2E_CHAT_TEST_URL || 'https://api.r2c.biz/carnation-demo/index.html';
  // 非アバターテナントのページ (test 3 が使用)。CI で実 URL を注入すると非アバター経路を実検証できる。
  // 未指定時はアバター版にフォールバック → test 3 は従来どおり skip される（誤検証を防ぐ）。
  const NON_AVATAR_DEMO_URL = process.env.E2E_NON_AVATAR_TEST_URL || AVATAR_DEMO_URL;

  // このスイートは毎回 .fab をクリックして isOpen=true にする → widget.js が
  // POST /api/avatar/room-token を connect:true で送る → サーバー側で実際に
  // LiveKitエージェント経由の LemonSlice アバターセッションが起動し課金が発生する
  // (dispatchAgentToRoom はレスポンスを返す前に fire-and-forget で呼ばれるため、
  // クライアント側でレスポンスをどう扱っても後から止められない)。
  // ここでリクエストをブラウザ側でインターセプトし、本番バックエンドに一切到達させずに
  // FABサムネイル永続化ロジック(UI挙動)だけを検証する。
  async function mockAvatarBackend(page: any) {
    await page.route('**/api/avatar/anam-session', (route: any) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false }),
      })
    );
    await page.route('**/api/avatar/room-token', (route: any) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          livekitUrl: 'wss://e2e-mock.invalid',
          token: 'e2e-mock-token',
          roomName: 'e2e-mock-room',
          agentId: 'e2e-mock-agent',
          imageUrl:
            'https://rpqrwifbrhlebbelyqog.supabase.co/storage/v1/object/public/avatar-defaults/default_01.png',
          avatarName: 'E2E Mock Avatar',
          preDispatchEnabled: false,
        }),
      })
    );
  }

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
    await mockAvatarBackend(page);
    // Navigate to carnation demo — widget initializes with avatar config
    const resp = await page.goto(AVATAR_DEMO_URL);
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
    await mockAvatarBackend(page);
    const resp = await page.goto(AVATAR_DEMO_URL);
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
    // NON_AVATAR_DEMO_URL 未指定時は AVATAR_DEMO_URL(アバター設定済み実ページ)にフォールバックする。
    // その場合のみモックが必要 — 真の非アバターテナントは backend 側で avatarEnabled=false により
    // dispatch 前に 403 で早期リターンするため、実バックエンドを叩いても課金は発生しない。
    if (NON_AVATAR_DEMO_URL === AVATAR_DEMO_URL) {
      await mockAvatarBackend(page);
    }
    // Demo page uses a different tenant without avatar configuration
    // If FAB has no avatar image initially, it should have chat SVG — open/close should keep it
    const resp = await page.goto(NON_AVATAR_DEMO_URL);
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
