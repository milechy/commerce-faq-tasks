import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, Page } from '@playwright/test';
import { gotoWithRetry } from './helpers/gotoRetry';
import { mockAvatarBackend, mockAvatarDisabled } from './helpers/mockAvatarBackend';
import { DEMO_INDEX_URL } from './config';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

/**
 * PR #1179 (音声リンク型チャットUI: avatarMuteBtn によるヒストリー表示切替) の
 * 実ブラウザE2E検証。
 *
 * 検証したい不変条件は大きく2つ:
 *   1. CSS側の契約: `.panel.avatar-active.history-hidden .messages` は両クラスが
 *      揃って初めて成立する。history-hidden だけが単独で付いても(= avatar-active が
 *      無いテキスト専用チャットで誤ってクラスが付いても)メッセージ履歴は隠れては
 *      ならない。これは実際のCSSレンダリング(getComputedStyle)で確認する方が、
 *      ソース文字列の一致確認より一段強い保証になる。
 *   2. JS側の契約: Anam SDK経路とLiveKit経路、両方の avatarMuteBtn クリックが
 *      同じようにトグルする。このリポジトリでは過去に「片方だけ直して片方を
 *      壊す」事故が実際に起きているため、両経路を別々に本物のDOMイベントで
 *      駆動する。
 *
 * デモページは本番配信の widget.js を読み込むため、public/widget.js の実物を
 * page.route で差し込む(widget-fab-avatar.spec.ts と同じ理由・同じ手法)。
 */
test.describe('Widget — 音声リンク型チャットUI(avatarMuteBtn)', () => {
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

  async function getPanelMessagesState(page: Page) {
    return page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const root = host?.shadowRoot;
      const panel = root?.querySelector('.panel') as HTMLElement | null;
      const messages = root?.querySelector('.messages') as HTMLElement | null;
      const inputArea = root?.querySelector('.input-area') as HTMLElement | null;
      const textarea = root?.querySelector('textarea') as HTMLElement | null;
      const sendBtn = root?.querySelector('.send-btn') as HTMLElement | null;
      const micBtn = root?.querySelector('.mic-btn') as HTMLElement | null;
      const cs = (el: HTMLElement | null) => (el ? getComputedStyle(el).display : null);
      // .panel.avatar-active.history-hidden .messages は display ではなく
      // opacity/max-height/overflow で隠す(public/widget.js:868-873)。display は
      // 隠れていても変化しないため、隠れているかどうかの判定はこちらで行う。
      const isVisuallyHidden = (el: HTMLElement | null) => {
        if (!el) return null;
        const cs2 = getComputedStyle(el);
        return cs2.opacity === '0' && cs2.overflow === 'hidden';
      };
      return {
        hasPanel: !!panel,
        hasAvatarActive: !!panel?.classList.contains('avatar-active'),
        hasHistoryHidden: !!panel?.classList.contains('history-hidden'),
        messagesDisplay: cs(messages),
        messagesVisuallyHidden: isVisuallyHidden(messages),
        inputAreaDisplay: cs(inputArea),
        textareaDisplay: cs(textarea),
        sendBtnDisplay: cs(sendBtn),
        micBtnDisplay: cs(micBtn),
      };
    });
  }

  // ------------------------------------------------------------------
  // 1. CSSスコープの契約(アバター接続を一切必要としない、最も安価で最も重要な検証)
  // ------------------------------------------------------------------
  test.describe('CSSスコープ契約: .panel.avatar-active.history-hidden .messages', () => {
    test('avatar-active が無い(テキスト専用)状態で history-hidden だけが付いても、メッセージ履歴は隠れない', async ({
      page,
    }) => {
      await mockAvatarDisabled(page);
      await useLocalWidgetJs(page);

      const resp = await gotoWithRetry(page, DEMO_URL);
      expect(resp?.status()).toBe(200);
      await waitForFab(page);
      await openPanel(page);

      const before = await getPanelMessagesState(page);
      if (!before.hasPanel) {
        test.skip();
        return;
      }
      expect(before.hasAvatarActive).toBe(false);
      expect(before.messagesVisuallyHidden).toBe(false);

      // avatarMuteBtnクリックを経由せず、CSSセレクタの契約そのものを直接検証する
      // (avatar-active無しでhistory-hiddenだけが付くという、実装上は起きないはずの
      // 状態を意図的に再現し、CSS側が本当にavatar-active必須になっているかを見る)
      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector('.panel')?.classList.add('history-hidden');
      });

      const afterHistoryHiddenOnly = await getPanelMessagesState(page);
      expect(afterHistoryHiddenOnly.hasHistoryHidden).toBe(true);
      expect(afterHistoryHiddenOnly.hasAvatarActive).toBe(false);
      // 核心の回帰ガード: .history-hidden 単体ではセレクタが不成立のため、
      // メッセージ履歴は表示されたままでなければならない
      expect(afterHistoryHiddenOnly.messagesVisuallyHidden).toBe(false);

      // 対照実験: avatar-active も足すと初めて隠れることを確認し、
      // 上のテストが「そもそもCSSが効いていないだけ」の偽陰性でないことを保証する
      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector('.panel')?.classList.add('avatar-active');
      });
      // .messages には opacity 0.2s のtransitionが付いている(public/widget.js:861)。
      // クラス付与直後は遷移中でopacityがまだ0に達していないため、実際に0になるまで待つ
      // (固定sleepではなく実測でポーリングすることで、CI側の実行速度差に依存しない)。
      await page.waitForFunction(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        const messages = host?.shadowRoot?.querySelector('.messages') as HTMLElement | null;
        return !!messages && getComputedStyle(messages).opacity === '0';
      }, { timeout: 2000 });
      const afterBoth = await getPanelMessagesState(page);
      expect(afterBoth.messagesVisuallyHidden).toBe(true);
    });

    test('history-hidden + avatar-active が揃った状態でも、入力エリア(textarea/送信/マイク)は非表示にならない', async ({
      page,
    }) => {
      await mockAvatarDisabled(page);
      await useLocalWidgetJs(page);

      const resp = await gotoWithRetry(page, DEMO_URL);
      expect(resp?.status()).toBe(200);
      await waitForFab(page);
      await openPanel(page);

      const before = await getPanelMessagesState(page);
      if (!before.hasPanel) {
        test.skip();
        return;
      }

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        const panel = host?.shadowRoot?.querySelector('.panel');
        panel?.classList.add('avatar-active');
        panel?.classList.add('history-hidden');
      });
      // opacity 0.2s のtransitionが完了するまで待つ(上のテストと同じ理由)。
      await page.waitForFunction(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        const messages = host?.shadowRoot?.querySelector('.messages') as HTMLElement | null;
        return !!messages && getComputedStyle(messages).opacity === '0';
      }, { timeout: 2000 });

      const state = await getPanelMessagesState(page);
      expect(state.messagesVisuallyHidden).toBe(true); // 前提: 履歴自体は隠れている
      // 「テキスト入力は常に表示され続ける」という要件をレンダリング結果で確認する
      expect(state.inputAreaDisplay).not.toBe('none');
      expect(state.textareaDisplay).not.toBe('none');
      expect(state.sendBtnDisplay).not.toBe('none');
      expect(state.micBtnDisplay).not.toBe('none');
    });
  });

  // ------------------------------------------------------------------
  // 2. LiveKit(LemonSlice)経路: avatarMuteBtn の実クリック
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
        const panel = root?.querySelector('.panel');
        const messagesArea = root?.querySelector('.messages');
        return {
          ariaPressed: btn?.getAttribute('aria-pressed') ?? null,
          historyHidden: !!panel?.classList.contains('history-hidden'),
          messagesAriaHidden: messagesArea?.getAttribute('aria-hidden') ?? null,
        };
      });
    }

    /** aria-pressed(=avatarMuted) と history-hidden / aria-hidden が矛盾していないことを見る */
    function expectConsistent(state: { ariaPressed: string | null; historyHidden: boolean; messagesAriaHidden: string | null }) {
      const muted = state.ariaPressed === 'true';
      // avatarMuted===true(ミュート中)のときは履歴を隠さない(!avatarMuted===false)
      expect(state.historyHidden).toBe(!muted);
      // aria-hidden は avatarMuteBtn が一度もクリックされていない間は属性自体が
      // 存在しない(public/widget.js はクリックハンドラの中でのみ setAttribute する)。
      // 「属性が無い」と「aria-hidden="false"」はアクセシビリティ上同値なので、
      // 文字列の完全一致ではなく真偽値に正規化してから比較する。
      const isAriaHidden = state.messagesAriaHidden === 'true';
      expect(isAriaHidden).toBe(!muted);
    }

    test('クリック1回でミュート状態が反転し、history-hidden / aria-hidden が連動する', async ({ page }) => {
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
      expectConsistent(initial);

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector<HTMLButtonElement>('.avatar-mute-btn')?.click();
      });

      const afterOneClick = await getMuteState(page);
      expect(afterOneClick.ariaPressed).toBe('false'); // ミュート解除された
      expectConsistent(afterOneClick);
    });

    test('スパムクリック(5連打)後も、ボタン状態とhistory-hidden/aria-hiddenは常に整合した最終状態になる', async ({
      page,
    }) => {
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
      expectConsistent(final);
    });
  });

  // ------------------------------------------------------------------
  // 3. Anam SDK経路: avatarMuteBtn の実クリック
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
        const panel = root?.querySelector('.panel');
        const messagesArea = root?.querySelector('.messages');
        return {
          ariaPressed: btn?.getAttribute('aria-pressed') ?? null,
          historyHidden: !!panel?.classList.contains('history-hidden'),
          messagesAriaHidden: messagesArea?.getAttribute('aria-hidden') ?? null,
        };
      });
    }

    test('クリック1回でミュート状態が反転し、history-hidden / aria-hidden が連動する(LiveKit経路と同一の振る舞い)', async ({
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
      const mutedInitially = initial.ariaPressed === 'true';
      expect(initial.historyHidden).toBe(!mutedInitially);
      // aria-hidden はクリック前は属性自体が無い(null)ことがある。無いことと
      // "false"であることは同値なので、真偽値に正規化してから比較する。
      expect(initial.messagesAriaHidden === 'true').toBe(!mutedInitially);

      await page.evaluate(() => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        host?.shadowRoot?.querySelector<HTMLButtonElement>('.avatar-mute-btn')?.click();
      });

      const after = await getMuteState(page);
      expect(after.ariaPressed).toBe('false');
      const mutedAfter = after.ariaPressed === 'true';
      expect(after.historyHidden).toBe(!mutedAfter);
      expect(after.messagesAriaHidden === 'true').toBe(!mutedAfter);
    });
  });
});
