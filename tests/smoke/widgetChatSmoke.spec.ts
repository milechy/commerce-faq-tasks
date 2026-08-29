// tests/smoke/widgetChatSmoke.spec.ts
//
// デプロイ直後に「本番のチャットが実際に会話できるか」をブラウザで確認する。
// tests/e2e/** とは目的が違う:
//   - tests/e2e/**  … pull_request で走る。ただし向き先は本番なので、PRの製品コードは
//                     1行も検証していない(検証しているのはそのPRが変更したspec自身だけ)
//   - このファイル  … deploy-vps.sh の最後に走る。デプロイした結果が壊れていないかを見る
//
// 2026-08-29 の障害(#1039 が `var _abExposureSent = false;` の宣言を消し、
// recordAbExposure() の ReferenceError で sendMessage() が停止 → 全テナントの
// チャットが送信不能)は、既存の SCRIPTS/post-deploy-smoke.sh を素通りした。
// widget.js は HTTP 200 を返し Content-Type も javascript だったため、
// HTTPレベルのチェックでは「正常」に見えたからだ。壊れていたのは実行結果だけ。
// だから本ファイルは「実際にブラウザで開いて送信し、応答が描画されるか」を見る。
//
// アバターだけはモックする(実接続は ¥25.9/分の実課金が発生し、デプロイのたびに
// 課金するわけにいかないため)。チャットAPIはモックしない — そこが検証対象。

import { test, expect } from '@playwright/test';

const API_BASE = process.env.SMOKE_API_URL || 'https://api.r2c.biz';
const DEMO_URL = `${API_BASE}/carnation-demo/index.html`;

test.describe('本番スモーク — ウィジェットで会話が成立する', () => {
  test('埋め込みウィジェットで送信すると、例外なくアシスタント応答が描画される', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.message}\n${e.stack ?? ''}`));

    const chatResponses: number[] = [];
    page.on('response', (res) => {
      if (res.url().includes('/api/chat')) chatResponses.push(res.status());
    });

    // アバターは実課金を避けるため無効化して返す(接続を試みさせない)。
    // enabled:false で返すこと — livekitUrl を無効ホストに向ける形にすると
    // widget が接続を試みて失敗し、検証したい経路と無関係な失敗になる。
    await page.route('**/api/avatar/anam-session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false }),
      }),
    );
    await page.route('**/api/avatar/room-token', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: false }),
      }),
    );

    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => {
        const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
        return !!host?.shadowRoot?.querySelector('.fab');
      },
      { timeout: 20000 },
    );

    await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      host?.shadowRoot?.querySelector<HTMLButtonElement>('.fab')?.click();
    });
    await page.waitForTimeout(500);

    const typed = await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const ta = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta) return false;
      ta.focus();
      ta.value = '営業時間を教えてください';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    });
    expect(typed, 'ウィジェットの入力欄が見つからない').toBe(true);

    // 1. ユーザー発言が描画される。
    //    #1039 の障害ではここが 0 件だった(sendMessage が例外で停止したため)。
    //    /api/chat の応答を待たずに描画されるはずなので、短いタイムアウトで十分。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
            return host?.shadowRoot?.querySelectorAll('.msg-wrapper.user').length ?? 0;
          }),
        {
          timeout: 5000,
          message: 'ユーザー発言のバブルが描画されない（送信フローが例外で停止している疑い）',
        },
      )
      .toBeGreaterThan(0);

    // 2. アシスタント応答が描画される（本番の /api/chat を実際に叩いた結果）
    //
    // 「返答を生成中」のローディング表示も className が 'msg-wrapper assistant' なので、
    // .msg-wrapper.assistant を数えるだけだと送信直後に必ず1件ヒットして素通りする
    // (このスモークを書いた最初の版で実際に踏んだ)。中身の .bubble.assistant まで見て、
    // ローディング(.loading-dots しか持たない)と本物の応答を区別する。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
            const bubbles = Array.from(
              host?.shadowRoot?.querySelectorAll('.msg-wrapper.assistant .bubble.assistant') ?? [],
            );
            return bubbles.filter((b) => (b.textContent ?? '').trim().length > 0).length;
          }),
        { timeout: 60000, message: 'アシスタント応答のバブルが描画されない' },
      )
      .toBeGreaterThan(0);

    // 3. /api/chat が 200 を返している
    expect(chatResponses, '/api/chat へのリクエストが発生していない').not.toHaveLength(0);
    expect(chatResponses.every((s) => s === 200), `/api/chat の応答: ${chatResponses.join(',')}`).toBe(
      true,
    );

    // 4. エスカレーションボタンが有効化される（assistant応答を受けた証跡）
    const escalateDisabled = await page.evaluate(() => {
      const host = document.getElementById('faq-chat-widget-host') as HTMLElement | null;
      const btn = host?.shadowRoot?.querySelector('.escalate-btn') as HTMLButtonElement | null;
      return btn ? btn.disabled : null;
    });
    expect(escalateDisabled, 'エスカレーションボタンが有効化されていない').toBe(false);

    // 5. JS例外が1件も起きていない。
    //    これが今回の障害を最短で捕まえる条件。trace のネットワークだけ見ていても写らない。
    expect(pageErrors, `ページ内でJS例外が発生した:\n${pageErrors.join('\n---\n')}`).toEqual([]);
  });
});
