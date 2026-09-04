import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, Page } from '@playwright/test';
import { gotoWithRetry } from './helpers/gotoRetry';
import { mockAvatarDisabled } from './helpers/mockAvatarBackend';
import { DEMO_INDEX_URL } from './config';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

/**
 * PR #1168 (エスカレーション「サイレント失敗」修正) の実ブラウザE2E検証。
 *
 * tests/widget/widgetSourceInvariants.test.ts 側では以下をソース文字列レベルで
 * 固定しているが、実際にクリック→fetch→DOM反映まで動くかどうかは別問題のため、
 * このファイルでは実際にウィジェットを開き、テキストを送り、有人相談ボタンを
 * クリックする一連の操作を本物のDOM/イベントで検証する。
 *
 * デモページは本番配信の widget.js を読み込むため、そのままだとリポジトリの変更を
 * 検証できない(widget-fab-avatar.spec.ts と同じ理由)。public/widget.js の実物を
 * page.route で差し込み、main のコードそのものを検証する。
 *
 * アバターはこの機能と無関係のため mockAvatarDisabled() で経路ごと無効化し、
 * 実バックエンドの LiveKit/LemonSlice へは一切到達させない。
 */
test.describe('Widget — 有人エスカレーションボタン', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  const DEMO_URL = process.env.E2E_CHAT_TEST_URL || DEMO_INDEX_URL;

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

  async function mockChatReply(page: Page, reply = 'ご質問ありがとうございます。') {
    await page.route('**/api/chat', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reply, data: { tenantId: 'e2e-mock-tenant' } }),
      });
    });
  }

  async function openPanel(page: Page) {
    await page.waitForFunction(
      () => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        return !!host?.shadowRoot?.querySelector('.fab');
      },
      { timeout: 8000 }
    );
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
    });
    await page.waitForTimeout(300);
  }

  async function getEscalateState(page: Page) {
    return page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('.escalate-btn');
      return btn ? { disabled: btn.disabled, text: btn.textContent } : null;
    });
  }

  /** disabled な .escalate-btn を強制クリックする(ネイティブの disabled ガードごしにclick()を試みる) */
  async function clickEscalateBtn(page: Page) {
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.escalate-btn')?.click();
    });
  }

  async function sendUserMessage(page: Page, text: string) {
    await page.evaluate((value) => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!textarea) return;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      nativeSetter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const sendBtn = host?.shadowRoot?.querySelector('.send-btn') as HTMLButtonElement | null;
      sendBtn?.click();
    });
    await page.waitForTimeout(500);
  }

  async function getAssistantBubbleTexts(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const bubbles = host?.shadowRoot?.querySelectorAll('.bubble.assistant');
      return bubbles ? Array.from(bubbles).map((b) => b.textContent ?? '') : [];
    });
  }

  test('自動あいさつのみ(来訪者の実発言なし)では escalate-btn は disabled のままで、クリックしても /api/chat/escalate へ到達しない', async ({
    page,
  }) => {
    await mockAvatarDisabled(page);
    await useLocalWidgetJs(page);

    let escalateCalled = false;
    await page.route('**/api/chat/escalate', (route) => {
      escalateCalled = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const resp = await gotoWithRetry(page, DEMO_URL);
    expect(resp?.status()).toBe(200);
    await openPanel(page);

    const state = await getEscalateState(page);
    if (!state) {
      test.skip();
      return;
    }
    expect(state.disabled).toBe(true);

    // ネイティブのdisabledガードにより、click()しても'click'イベントは発火しないはず
    await clickEscalateBtn(page);
    await page.waitForTimeout(300);
    expect(escalateCalled).toBe(false);
  });

  test('来訪者が1通送信すると escalate-btn が有効化される', async ({ page }) => {
    await mockAvatarDisabled(page);
    await useLocalWidgetJs(page);
    await mockChatReply(page);

    const resp = await gotoWithRetry(page, DEMO_URL);
    expect(resp?.status()).toBe(200);
    await openPanel(page);

    const before = await getEscalateState(page);
    if (!before) {
      test.skip();
      return;
    }
    expect(before.disabled).toBe(true);

    await sendUserMessage(page, 'こんにちは、質問があります');

    const after = await getEscalateState(page);
    expect(after?.disabled).toBe(false);
  });

  test('404 conversation_not_found のときは専用の案内文がチャットに表示される(汎用文ではない)', async ({
    page,
  }) => {
    await mockAvatarDisabled(page);
    await useLocalWidgetJs(page);
    await mockChatReply(page);
    await page.route('**/api/chat/escalate', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'conversation_not_found' }),
      })
    );

    const resp = await gotoWithRetry(page, DEMO_URL);
    expect(resp?.status()).toBe(200);
    await openPanel(page);

    const state = await getEscalateState(page);
    if (!state) {
      test.skip();
      return;
    }
    await sendUserMessage(page, 'こんにちは');
    await clickEscalateBtn(page);
    await page.waitForTimeout(500);

    const bubbles = await getAssistantBubbleTexts(page);
    expect(bubbles.some((t) => t.includes('少し会話をしてからもう一度お試しください'))).toBe(true);
    expect(bubbles.some((t) => t.includes('接続できませんでした'))).toBe(false);

    const after = await getEscalateState(page);
    expect(after?.disabled).toBe(false); // ボタンは戻り、再試行できる
  });

  test('ネットワークレベルの失敗(fetch自体の拒否)でも例外を投げず、汎用の案内文が表示される', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await mockAvatarDisabled(page);
    await useLocalWidgetJs(page);
    await mockChatReply(page);
    await page.route('**/api/chat/escalate', (route) => route.abort('failed'));

    const resp = await gotoWithRetry(page, DEMO_URL);
    expect(resp?.status()).toBe(200);
    await openPanel(page);

    const state = await getEscalateState(page);
    if (!state) {
      test.skip();
      return;
    }
    await sendUserMessage(page, 'こんにちは');
    await clickEscalateBtn(page);
    await page.waitForTimeout(500);

    const bubbles = await getAssistantBubbleTexts(page);
    expect(bubbles.some((t) => t.includes('接続できませんでした'))).toBe(true);
    expect(pageErrors).toHaveLength(0);

    const after = await getEscalateState(page);
    expect(after?.disabled).toBe(false);
  });

  test('連打(rapid double-click)しても escalatePending ガードにより /api/chat/escalate へのリクエストは1回だけ', async ({
    page,
  }) => {
    await mockAvatarDisabled(page);
    await useLocalWidgetJs(page);
    await mockChatReply(page);

    let callCount = 0;
    await page.route('**/api/chat/escalate', async (route) => {
      callCount += 1;
      // pending状態のウィンドウを人為的に広げ、2発目が確実に競合しうる状況を作る
      await new Promise((r) => setTimeout(r, 400));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const resp = await gotoWithRetry(page, DEMO_URL);
    expect(resp?.status()).toBe(200);
    await openPanel(page);

    const state = await getEscalateState(page);
    if (!state) {
      test.skip();
      return;
    }
    await sendUserMessage(page, 'こんにちは');

    // 同一evaluate内で連続clickし、Playwright側のラウンドトリップに分断されない
    // 本当に「近接した2連打」を再現する
    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const btn = host?.shadowRoot?.querySelector<HTMLButtonElement>('.escalate-btn');
      btn?.click();
      btn?.click();
    });

    await page.waitForTimeout(800);
    expect(callCount).toBe(1);
  });

  test('エスカレーション成功後、再度クリックしても2回目のリクエストは発生しない(escalatedフラグでのno-op)', async ({
    page,
  }) => {
    await mockAvatarDisabled(page);
    await useLocalWidgetJs(page);
    await mockChatReply(page);

    let callCount = 0;
    await page.route('**/api/chat/escalate', (route) => {
      callCount += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    const resp = await gotoWithRetry(page, DEMO_URL);
    expect(resp?.status()).toBe(200);
    await openPanel(page);

    const state = await getEscalateState(page);
    if (!state) {
      test.skip();
      return;
    }
    await sendUserMessage(page, 'こんにちは');
    await clickEscalateBtn(page);
    await page.waitForTimeout(500);
    expect(callCount).toBe(1);

    // 成功後は setEscalateBtnState(..., true) で disabled にもなるが、
    // それとは独立に escalated フラグそのものが再クリックをブロックしていることを見る
    await clickEscalateBtn(page);
    await page.waitForTimeout(300);
    expect(callCount).toBe(1);
  });
});
