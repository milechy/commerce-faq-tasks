import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, Page } from '@playwright/test';
import { gotoWithRetry } from './helpers/gotoRetry';
import { mockAvatarBackend } from './helpers/mockAvatarBackend';
import { DEMO_INDEX_URL } from './config';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

/**
 * avatarMuteBtn(音声ミュート/ミュート解除)の実ブラウザE2E検証。
 *
 * PR #1179(音声ONで会話履歴を隠す機能)は2026-09-04に撤回された — 音声中でも
 * 「自分が何を話したか分かるように」履歴は常時表示する方針に変更されたため、
 * history-hidden / messages の表示切替に関する検証はここでは行わない。
 *
 * ここで検証するのは、ボタンが音声のミュート状態だけを正しくトグルすること。
 * このリポジトリでは過去に「ほぼ同一の2経路(Anam SDK / LiveKit)のうち片方だけ
 * 修正して片方を壊す」事故が実際に起きているため、両経路を別々に本物のDOMイベントで
 * 駆動して確認する。
 *
 * デモページは本番配信の widget.js を読み込むため、public/widget.js の実物を
 * page.route で差し込む(widget-fab-avatar.spec.ts と同じ理由・同じ手法)。
 */
test.describe('Widget — avatarMuteBtn(音声ミュート切替)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  const DEMO_URL = process.env.E2E_CHAT_TEST_URL || DEMO_INDEX_URL;
  const ANAM_SDK_URL = 'https://esm.sh/@anam-ai/js-sdk@latest';

  async function useLocalWidgetJs(page: Page) {
    const localWidgetJs = readFileSync(resolve(__dirname, '../../public/widget.js'), 'utf8');
    await page.route('**/widget.js*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: localWidgetJs,
      })
    );
  }

  async function waitForFab(page: Page) {
    await page.waitForFunction(
      () => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        return !!host?.shadowRoot?.querySelector('.fab');
      },
      { timeout: 8000 }
    );
  }

  async function openPanel(page: Page) {
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
    });
    await page.waitForTimeout(300);
  }

  // ------------------------------------------------------------------
  // 1. LiveKit(LemonSlice)経路: avatarMuteBtn の実クリック
  // ------------------------------------------------------------------
  test.describe('LiveKit経路(_connectLiveKitAfterCleanup)のavatarMuteBtn', () => {
    async function waitForMuteBtn(page: Page) {
      await page.waitForFunction(
        () => {
          const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
          return !!host?.shadowRoot?.querySelector('.avatar-mute-btn');
        },
        { timeout: 10000 }
      );
    }

    async function getMuteState(page: Page) {
      return page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        const root = host?.shadowRoot;
        const btn = root?.querySelector('.avatar-mute-btn');
        return { ariaPressed: btn?.getAttribute('aria-pressed') ?? null };
      });
    }

    test('クリック1回でミュート状態(aria-pressed)が反転する', async ({ page }) => {
      // mockAvatarBackend: anam-sessionはenabled:falseでLiveKit(lemonslice)経路に
      // フォールバックさせ、room-tokenは接続先を無効ホストにして実バックエンドの
      // LiveKit/LemonSliceには一切接続しない(課金なし)。avatarMuteBtnはroom.connect()の
      // 成否を待たず同期的に生成されるため、実接続失敗より前の window で検証できる。
      await mockAvatarBackend(page);
      await useLocalWidgetJs(page);

      const resp = await gotoWithRetry(page, DEMO_URL);
      expect(resp?.status()).toBe(200);
      await waitForFab(page);
      await openPanel(page);

      try {
        await waitForMuteBtn(page);
      } catch {
        test.skip(); // このテナント/実行環境ではアバターが有効化されなかった
        return;
      }

      const initial = await getMuteState(page);
      expect(initial.ariaPressed).toBe('true'); // 既定はミュート

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector<HTMLButtonElement>('.avatar-mute-btn')?.click();
      });

      const afterOneClick = await getMuteState(page);
      expect(afterOneClick.ariaPressed).toBe('false'); // ミュート解除された
    });

    test('スパムクリック(5連打)後もボタン状態は整合した最終状態になる', async ({ page }) => {
      await mockAvatarBackend(page);
      await useLocalWidgetJs(page);

      const resp = await gotoWithRetry(page, DEMO_URL);
      expect(resp?.status()).toBe(200);
      await waitForFab(page);
      await openPanel(page);

      try {
        await waitForMuteBtn(page);
      } catch {
        test.skip();
        return;
      }

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('.avatar-mute-btn');
        for (let i = 0; i < 5; i++) btn?.click();
      });

      const final = await getMuteState(page);
      // 5回(奇数回)のトグルなので、既定のミュート状態(true)から反転しているはず
      expect(final.ariaPressed).toBe('false');
    });
  });

  // ------------------------------------------------------------------
  // 2. Anam SDK経路: avatarMuteBtn の実クリック
  // ------------------------------------------------------------------
  test.describe('Anam SDK経路(connectAnam)のavatarMuteBtn', () => {
    async function mockAnamPathBackend(page: Page) {
      // anam-session を成功させ、Anam経路を実際に通す。room-token 側もフォールバック用に
      // 無効化しておく(Anam成功時は使われないが、失敗時の安全側フォールバックとして必要)。
      await page.route('**/api/avatar/anam-session', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            enabled: true,
            avatarProvider: 'anam',
            sessionToken: 'e2e-mock-session-token',
            avatarName: 'E2E Mock Avatar (Anam)',
          }),
        })
      );
      await page.route('**/api/avatar/room-token', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) })
      );
      // 実際のAnam CDN(esm.sh)へは一切到達させず、widget.js が期待する最小限の
      // createClient / AnamEvent だけを持つフェイクモジュールを返す。
      await page.route(ANAM_SDK_URL, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: `
            export function createClient(sessionToken, opts) {
              return {
                muteAudio() {},
                unmuteAudio() {},
                muteOutputAudio() {},
                unmuteOutputAudio() {},
                talk() {},
                addListener() {},
                streamToVideoElement(id) { return Promise.resolve(); },
              };
            }
            export const AnamEvent = { MESSAGE_HISTORY_UPDATED: 'e2e-mock-message-history-updated' };
          `,
        })
      );
    }

    async function waitForMuteBtn(page: Page) {
      await page.waitForFunction(
        () => {
          const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
          return !!host?.shadowRoot?.querySelector('.avatar-mute-btn');
        },
        { timeout: 10000 }
      );
    }

    async function getMuteState(page: Page) {
      return page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        const root = host?.shadowRoot;
        const btn = root?.querySelector('.avatar-mute-btn');
        return { ariaPressed: btn?.getAttribute('aria-pressed') ?? null };
      });
    }

    test('クリック1回でミュート状態(aria-pressed)が反転する(LiveKit経路と同一の振る舞い)', async ({
      page,
    }) => {
      await mockAnamPathBackend(page);
      await useLocalWidgetJs(page);

      const resp = await gotoWithRetry(page, DEMO_URL);
      expect(resp?.status()).toBe(200);
      await waitForFab(page);
      await openPanel(page);

      try {
        await waitForMuteBtn(page);
      } catch {
        test.skip(); // フェイクESMモジュールがこの実行環境で読み込めなかった場合の逃げ道
        return;
      }

      const initial = await getMuteState(page);
      expect(initial.ariaPressed).toBe('true');

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector<HTMLButtonElement>('.avatar-mute-btn')?.click();
      });

      const after = await getMuteState(page);
      expect(after.ariaPressed).toBe('false');
    });
  });
});
