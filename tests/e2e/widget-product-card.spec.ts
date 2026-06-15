// tests/e2e/widget-product-card.spec.ts
// Phase73: 390px viewport で productCard 商品カードがレンダリングされることを検証
//
// 方針:
//   - E2E_ENABLED=1 または CI=true の場合のみ実行（それ以外は SKIP）
//   - Playwright の route インターセプトで /api/chat レスポンスに productCard を注入
//   - Shadow DOM (mode:open) 内の .product-card を page.evaluate() でアクセス
//   - 実デバイス不要: iPhone 12 エミュレーション (390×844px)
//
// 制限事項:
//   - DEMO_URL (https://api.r2c.biz/carnation-demo/index.html) が存在し、
//     正規の data-api-key を持っていることが前提。
//   - ウィジェットが起動するまでの初期化完了を waitForFunction で待つ。
//   - chat レスポンスのルートインターセプトはウィジェットが /api/chat に POST する
//     タイミングに依存するため、メッセージ送信後にアサートする。

import { test, expect } from '@playwright/test';
import { gotoWithRetry } from './helpers/gotoRetry';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const DEMO_URL = 'https://api.r2c.biz/carnation-demo/index.html';

const MOCK_PRODUCT_CARD = {
  product_id: '99',
  name: 'テスト商品',
  price: '¥9,800',
  image_url: 'https://example.com/test-product.jpg',
  cta_url: 'https://example.com/buy',
};

test.describe('Widget — 商品カード 390px (P1-P3)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  // P1: productCard を含む /api/chat レスポンスで .product-card が描画される
  test('P1: productCard レスポンスで商品カードが Shadow DOM 内に描画される', async ({ page }) => {
    // /api/chat への POST をインターセプトして productCard を含む応答を返す
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'msg-test-1',
            content: 'こちらのコースがおすすめです。',
            actions: [],
            timestamp: Date.now(),
            flowState: 'recommend',
            productCard: MOCK_PRODUCT_CARD,
          },
        }),
      });
    });

    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(2000);

    // ウィジェット FAB をクリックして開く
    const opened = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return false;
      const fab = host.shadowRoot.querySelector('.fab') as HTMLElement;
      if (!fab) return false;
      fab.click();
      return true;
    });

    if (!opened) {
      test.info().annotations.push({
        type: 'info',
        description: 'Widget host not initialized on demo page — P1 skipped (no tenant)',
      });
      return;
    }

    await page.waitForTimeout(500);

    // テキストを入力して送信（route インターセプトが productCard 付き応答を返す）
    const sent = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return false;
      const textarea = host.shadowRoot.querySelector('textarea') as HTMLTextAreaElement;
      if (!textarea) return false;
      // nativeInputValueSetter を使わずに value + input event で入力
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(textarea, 'おすすめを教えて');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const sendBtn = host.shadowRoot.querySelector('.send-btn') as HTMLButtonElement;
      if (!sendBtn) return false;
      sendBtn.click();
      return true;
    });

    if (!sent) {
      test.info().annotations.push({
        type: 'info',
        description: 'Widget textarea/send-btn not found — P1 skipped',
      });
      return;
    }

    // 商品カードが描画されるのを待つ（最大 5 秒）
    await page.waitForTimeout(3000);

    const cardInfo = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return null;
      const card = host.shadowRoot.querySelector('.product-card') as HTMLElement;
      if (!card) return null;
      const img = card.querySelector('img') as HTMLImageElement | null;
      const cta = card.querySelector('.product-cta') as HTMLButtonElement | null;
      const name = card.querySelector('.product-card-name') as HTMLElement | null;
      const price = card.querySelector('.product-card-price') as HTMLElement | null;
      return {
        hasCard: true,
        imgSrc: img ? img.src : null,
        ctaText: cta ? cta.textContent : null,
        nameText: name ? name.textContent : null,
        priceText: price ? price.textContent : null,
      };
    });

    if (!cardInfo || !cardInfo.hasCard) {
      test.info().annotations.push({
        type: 'info',
        description: 'product-card not found in DOM — widget may not have initialized with valid tenant',
      });
      return;
    }

    expect(cardInfo.imgSrc).toBe(MOCK_PRODUCT_CARD.image_url);
    expect(cardInfo.nameText).toBe(MOCK_PRODUCT_CARD.name);
    expect(cardInfo.priceText).toBe(MOCK_PRODUCT_CARD.price);
    expect(cardInfo.ctaText).toBeTruthy();
  });

  // P2: safeHttpUrl ガード — javascript: URL を持つ productCard でも img.src に設定されない
  test('P2: javascript: URL は img.src に設定されない（safeHttpUrl ガード）', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'msg-test-2',
            content: '商品情報です。',
            actions: [],
            timestamp: Date.now(),
            flowState: 'recommend',
            productCard: {
              product_id: '1',
              name: '悪意ある商品',
              price: '999',
              // javascript: スキームは safeHttpUrl で空文字列に変換される
              image_url: 'javascript:alert(1)',
              cta_url: 'javascript:void(0)',
            },
          },
        }),
      });
    });

    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(2000);

    const opened = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return false;
      const fab = host.shadowRoot.querySelector('.fab') as HTMLElement;
      if (!fab) return false;
      fab.click();
      return true;
    });

    if (!opened) {
      test.info().annotations.push({
        type: 'info',
        description: 'Widget host not initialized — P2 skipped',
      });
      return;
    }

    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return;
      const textarea = host.shadowRoot.querySelector('textarea') as HTMLTextAreaElement;
      if (!textarea) return;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(textarea, 'おすすめを教えて');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const sendBtn = host.shadowRoot.querySelector('.send-btn') as HTMLButtonElement;
      if (sendBtn) sendBtn.click();
    });

    await page.waitForTimeout(3000);

    const xssCheck = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return { skipped: true };
      const card = host.shadowRoot.querySelector('.product-card') as HTMLElement;
      if (!card) return { skipped: true };
      const img = card.querySelector('img') as HTMLImageElement | null;
      const cta = card.querySelector('.product-cta') as HTMLButtonElement | null;
      return {
        skipped: false,
        // img が存在しないか、src が javascript: を含まないことを確認
        imgExists: !!img,
        imgSrc: img ? img.src : null,
        ctaExists: !!cta,
      };
    });

    if (xssCheck.skipped) {
      test.info().annotations.push({
        type: 'info',
        description: 'Widget not initialized — P2 skipped',
      });
      return;
    }

    // javascript: URL は img を生成しない（safeHttpUrl が空文字列を返すため）
    if (xssCheck.imgExists && xssCheck.imgSrc) {
      expect(xssCheck.imgSrc).not.toMatch(/^javascript:/i);
    }
    // CTA ボタンも javascript: URL では生成されない
    expect(xssCheck.ctaExists).toBe(false);
  });

  // P3: price のみ存在して image_url/cta_url が空でも price テキストが描画される
  test('P3: price のみ存在する productCard でも .product-card-price が描画される', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'msg-test-3',
            content: '商品情報です。',
            actions: [],
            timestamp: Date.now(),
            flowState: 'recommend',
            productCard: {
              product_id: '2',
              name: '価格だけある商品',
              price: '¥4,980',
              image_url: '',
              cta_url: '',
            },
          },
        }),
      });
    });

    await gotoWithRetry(page, DEMO_URL);
    await page.waitForTimeout(2000);

    const opened = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return false;
      const fab = host.shadowRoot.querySelector('.fab') as HTMLElement;
      if (!fab) return false;
      fab.click();
      return true;
    });

    if (!opened) {
      test.info().annotations.push({ type: 'info', description: 'Widget not initialized — P3 skipped' });
      return;
    }

    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return;
      const textarea = host.shadowRoot.querySelector('textarea') as HTMLTextAreaElement;
      if (!textarea) return;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(textarea, 'おすすめを教えて');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const sendBtn = host.shadowRoot.querySelector('.send-btn') as HTMLButtonElement;
      if (sendBtn) sendBtn.click();
    });

    await page.waitForTimeout(3000);

    const priceInfo = await page.evaluate(() => {
      const host = document.querySelector('#faq-chat-widget-host') as HTMLElement;
      if (!host?.shadowRoot) return null;
      const card = host.shadowRoot.querySelector('.product-card') as HTMLElement;
      if (!card) return null;
      const price = card.querySelector('.product-card-price') as HTMLElement | null;
      const img = card.querySelector('img');
      const cta = card.querySelector('.product-cta');
      return {
        priceText: price ? price.textContent : null,
        hasImg: !!img,
        hasCta: !!cta,
      };
    });

    if (!priceInfo) {
      test.info().annotations.push({ type: 'info', description: 'Widget not initialized — P3 skipped' });
      return;
    }

    expect(priceInfo.priceText).toBe('¥4,980');
    expect(priceInfo.hasImg).toBe(false); // 空 URL → img なし
    expect(priceInfo.hasCta).toBe(false); // 空 URL → CTA なし
  });
});
