import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { mockAvatarBackend } from './helpers/mockAvatarBackend';
import { DEMO_INDEX_URL } from './config';

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
    process.env.E2E_CHAT_TEST_URL || DEMO_INDEX_URL;
  // 非アバターテナントのページ (test 3 が使用)。CI で実 URL を注入すると非アバター経路を実検証できる。
  // 未指定時はアバター版にフォールバック → test 3 は従来どおり skip される（誤検証を防ぐ）。
  const NON_AVATAR_DEMO_URL = process.env.E2E_NON_AVATAR_TEST_URL || AVATAR_DEMO_URL;

  // mockAvatarBackend の理由は tests/e2e/helpers/mockAvatarBackend.ts のコメントを参照。
  // このスイートは毎回 .fab をクリックして isOpen=true にするため、必ず先に呼ぶこと。

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

  test('PiP: closePanel() no longer disconnects window.__rajiuceRoom', async ({ page }) => {
    // 回帰ガード: closePanel() が LiveKit Room を切断する実装に戻っていないことを検証する。
    // window.__rajiuceRoom は connectLiveKit() 実行時に room.connect() の成否を待たず
    // 同期的に設定される(widget.js: window.__rajiuceRoom = room)ため、
    // モックのLiveKit URL(wss://e2e-mock.invalid、実際には接続できない)でも
    // 「closePanelがnull化するかどうか」だけは確認できる。
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
      test.skip(); // No avatar configured — connectLiveKit() が走らないため対象外
      return;
    }

    // パネルを開く(connectLiveKit()がwindow.__rajiuceRoomを同期的にセットする)
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
    });
    await page.waitForTimeout(500);

    const roomAfterOpen = await page.evaluate(() => !!(window as any).__rajiuceRoom);
    if (!roomAfterOpen) {
      test.skip(); // このページ/実行環境ではRoomが生成されなかった
      return;
    }

    // パネルを閉じる
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.close-btn')?.click();
    });
    await page.waitForTimeout(500);

    const roomAfterClose = await page.evaluate(() => !!(window as any).__rajiuceRoom);
    expect(roomAfterClose).toBe(true); // PiP: 閉じてもRoomは保持される(nullにならない)
  });

  test('アバター接続に失敗したら、2カラムのアバターレイアウトを残さずテキストへ戻して案内する', async ({ page }) => {
    // 回帰ガード: 接続失敗時に avatarArea を隠すだけの実装へ戻っていないことを検証する。
    // .panel.avatar-active は 2 カラム Grid(左=アバター固定幅・右=チャット)なので、
    // クラスを付けたまま avatarArea だけ隠すと左カラムが幅を確保したまま残り、
    // 訪問者には「左半分が空白の巨大パネル」が見える。
    //
    // mockAvatarBackend は room-token に enabled:true + wss://e2e-mock.invalid を返すため、
    // room.connect() は必ず失敗する。実 LiveKit / 実 LemonSlice には一切接続しないので
    // このテストはアバターセッションの課金を発生させない。
    await mockAvatarBackend(page);

    // デモページは本番配信の widget.js を読み込むため、そのままだとリポジトリの変更を
    // 検証できない(デプロイ後にしか赤にならない回帰ガードになってしまう)。
    // public/widget.js の実物を差し込み、main のコードそのものを検証する。
    const localWidgetJs = readFileSync(resolve(__dirname, '../../public/widget.js'), 'utf8');
    await page.route('**/widget.js*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: localWidgetJs,
      })
    );

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
      test.skip(); // アバター未設定 — connectLiveKit() が走らないため対象外
      return;
    }

    // パネルを開く → showAvatarPlaceholder() + setAvatarActive() が走り、
    // その後 room.connect() が mock URL で失敗する。
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
    });
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const root = host?.shadowRoot;
      const panel = root?.querySelector('.panel') as HTMLElement | null;
      const errorBanner = root?.querySelector('.error-banner') as HTMLElement | null;
      const textarea = root?.querySelector('textarea') as HTMLTextAreaElement | null;
      return {
        stillAvatarLayout: !!root?.querySelector('.panel.avatar-active'),
        panelOpen: !!panel?.classList.contains('open'),
        errorVisible: !!errorBanner && errorBanner.style.display !== 'none',
        errorText: errorBanner?.textContent ?? '',
        canStillType: !!textarea && !textarea.disabled,
      };
    });

    // 1. アバター用の2カラムレイアウトが残っていないこと（本命の回帰ガード）
    expect(state.stillAvatarLayout).toBe(false);
    // 2. 会話自体は続けられること（テキストへのフォールバックが成立している）
    expect(state.panelOpen).toBe(true);
    expect(state.canStillType).toBe(true);
    // 3. 無言で消えるのではなく案内が出ること。専門用語を画面に出さないこと
    expect(state.errorVisible).toBe(true);
    expect(state.errorText).toContain('アバター');
    for (const jargon of ['LiveKit', 'LemonSlice', '429', 'WebSocket', 'error', 'Error']) {
      expect(state.errorText).not.toContain(jargon);
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
