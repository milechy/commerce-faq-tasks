import { test, expect } from '@playwright/test';
import { ADMIN_BASE_URL, API_BASE_URL, DEMO_BASE_URL } from './config';
import { isBootstrapMessage } from './helpers/agentChatMock';

// QA irregular (異常系) sweep — 2026-07-17
// 3ロールが「イレギュラーな動作」をした場合に、拒むべき操作が正しく拒まれるか / スコープが
// 守られるかを検証する。非破壊のみ：作成・削除・kill-switch 等の副作用のある操作はしない。
// - Role A: 匿名公開API(api.r2c.biz)への不正リクエスト（キー無し/偽装/超過/未知セッション）
// - Role B: client_admin の RBAC 越境・?tenant= 偽装・判明済みRBACギャップの実害確認
// - Role C: super_admin の横断アクセス正常系 + プレビュー中のテナントスコープ挙動(既知ギャップ)
//
// 認証:
//   Role B — tests/e2e/.auth/user.json (auth.setup.ts, TEST_ADMIN_EMAIL/PASSWORD = carnation client_admin)
//   Role C — beforeAll で TEST_SUPERADMIN_EMAIL/PASSWORD からログインし superadmin.json を再生成

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;
const API = API_BASE_URL;
const ADMIN = ADMIN_BASE_URL;
const DEMO_BASE = DEMO_BASE_URL;
const USER_AUTH = 'tests/e2e/.auth/user.json';
const SA_AUTH = 'tests/e2e/.auth/superadmin.json';
const OWN_TENANT = 'carnation';
const FOREIGN_TENANT = 'r2c_default';

// ───────────────────────────────────────────────────────────────────────────
// Role A — 匿名公開API 異常系
// ───────────────────────────────────────────────────────────────────────────
test.describe('Irregular — Role A (anonymous public API)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  let apiKey = '';

  test.beforeAll(async ({ playwright }) => {
    // 公開ウィジェットに埋め込まれた tenant agent API キーを実配信HTMLから取得（秘匿情報ではない）
    const ctx = await playwright.request.newContext();
    const res = await ctx.get(`${DEMO_BASE}/index.html`);
    if (res.ok()) {
      const html = await res.text();
      const m = html.match(/data-api-key="([^"]+)"/);
      if (m) apiKey = m[1];
    }
    await ctx.dispose();
  });

  test('A-IRR-1: escalate をAPIキー無しで叩くと 401（テナント解決不可で拒否）', async ({ request }) => {
    const res = await request.post(`${API}/api/chat/escalate`, {
      data: { sessionId: 'irregular-nokey' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('A-IRR-2: escalate をデタラメなAPIキーで叩くと 401', async ({ request }) => {
    const res = await request.post(`${API}/api/chat/escalate`, {
      data: { sessionId: 'irregular-badkey' },
      headers: { 'content-type': 'application/json', 'x-api-key': 'rjc_totally_bogus_key_zzzz' },
    });
    expect(res.status()).toBe(401);
  });

  test('A-IRR-3: 2000字超のメッセージは 400（保存前にバリデーション拒否）', async ({ request }) => {
    expect(apiKey, 'anon api key extracted from demo html').not.toBe('');
    const res = await request.post(`${API}/api/chat`, {
      data: { message: 'あ'.repeat(2001) },
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      timeout: 20000,
    });
    expect(res.status()).toBe(400);
  });

  test('A-IRR-4: X-Tenant-ID ヘッダ偽装は無視され、応答は鍵のテナントにスコープされる', async ({ request }) => {
    expect(apiKey).not.toBe('');
    // conversationId を省略すると src/api/chat/route.ts:135 の
    // `body.conversationId ?? 'anon'` が全匿名リクエスト共有の 'anon' バケットに
    // フォールバックし、同日中の他のテスト実行と合算されて「同じ内容が繰り返されています」
    // (repeat_abuse, src/middleware/inputSanitizer.ts) に誤爆する。実際のwidgetは常に
    // sessionStorage由来の固有 conversationId を送るため本番では起きないが、テストでは
    // 明示的にユニークなIDを渡してこの共有バケットを回避する。
    const res = await request.post(`${API}/api/chat`, {
      data: { message: 'こんにちは', conversationId: crypto.randomUUID() },
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'X-Tenant-ID': FOREIGN_TENANT, // 偽装
      },
      timeout: 30000,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const resolvedTenant = body?.tenantId ?? body?.data?.tenantId;
    test.info().annotations.push({ type: 'resolved-tenant', description: String(resolvedTenant) });
    // ボディで指定した / ヘッダで偽装した FOREIGN_TENANT ではなく、鍵の carnation に解決されること
    expect(resolvedTenant).toBe(OWN_TENANT);
    expect(resolvedTenant).not.toBe(FOREIGN_TENANT);
  });

  test('A-IRR-5: escalate を空sessionIdで叩くと 400（DB変更前にバリデーション拒否＝非破壊）', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.post(`${API}/api/chat/escalate`, {
      data: { sessionId: '' },
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    });
    expect(res.status()).toBe(400);
  });

  test('A-IRR-6: poll を sessionId 無しで叩くと 400', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.get(`${API}/api/chat/poll`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(res.status()).toBe(400);
  });

  test('A-IRR-7: poll を未知のsessionIdで叩いても他人の会話は漏れず空配列', async ({ request }) => {
    expect(apiKey).not.toBe('');
    const res = await request.get(
      `${API}/api/chat/poll?sessionId=00000000-0000-0000-0000-000000000000`,
      { headers: { 'x-api-key': apiKey } },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.messages)).toBe(true);
    expect(body.messages.length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Role B — client_admin 越境/RBAC 異常系（読取のみ）
// ───────────────────────────────────────────────────────────────────────────
test.describe('Irregular — Role B (client_admin RBAC/tenant boundary)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');
  test.use({ storageState: USER_AUTH });

  async function gotoAdmin(page: any, path: string) {
    const apiCalls: string[] = [];
    page.on('request', (req: any) => {
      const u = req.url();
      if (u.includes('/v1/admin/')) apiCalls.push(u);
    });
    const res = await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1800);
    return { res, apiCalls };
  }

  test('B-IRR-1: super専用 /admin/tenants へ直URL → /admin へ弾かれる', async ({ page }) => {
    await gotoAdmin(page, '/admin/tenants');
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    expect(page.url()).not.toContain('/admin/tenants');
    expect(page.url()).toMatch(/\/admin\/?$/);
  });

  test('B-IRR-2: /admin/chat-history?tenant=<他テナント> でも自テナントにスコープされ越境しない', async ({ page }) => {
    const { apiCalls } = await gotoAdmin(page, `/admin/chat-history?tenant=${FOREIGN_TENANT}`);
    // client_admin は ?tenant= を無視し carnation に強制スコープされる（body/クエリ経由の指定禁止）
    const foreignLeak = apiCalls.some(
      (u) => u.includes(`tenant=${FOREIGN_TENANT}`) || u.includes(`tenantId=${FOREIGN_TENANT}`),
    );
    test.info().annotations.push({ type: 'admin-api-calls', description: JSON.stringify(apiCalls) });
    expect(foreignLeak).toBe(false);
  });

  // Asana 1217080725079367: 旧実装は select 要素の全件カウントが0であることだけを
  // 見ていたが、/admin/knowledge/books はリダイレクトスタブ(books.tsx、13行)のため
  // role=anonymous(JWT修正前)だと画面自体が退化描画され select が無いだけでも
  // このテストは通っていた。つまり越境を一度も検証できていなかった。
  // 画面が実際に描画されたことを先に確認したうえで、描画された select の選択肢に
  // 自テナント(carnation)以外のテナントIDが含まれないことを検証する。
  test('B-IRR-3: 判明済みギャップ /admin/knowledge/books へ直URL到達しても他テナント選択UIは出ない', async ({ page }) => {
    const { res } = await gotoAdmin(page, '/admin/knowledge/books');
    // RequireAuth のため到達自体は許容され得る。実害＝クロステナント選択/データが出ないことを確認。
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    test.info().annotations.push({ type: 'status', description: String(res?.status()) });

    // books.tsx は /admin/knowledge へリダイレクトするだけのスタブ。画面が実際に
    // 描画されたことをまず確認する(描画されていなければ select が0件でも無意味)。
    await expect(page.getByText('AIの知識データ').first()).toBeVisible({ timeout: 10000 });

    const optionValues = await page.locator('select option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    test.info().annotations.push({ type: 'select-option-values', description: JSON.stringify(optionValues) });

    // r2c_defaultは本ファイル冒頭のFOREIGN_TENANTを再利用(値の二重管理を避ける)。
    // lp-demoはqa-preview-scope-leak.spec.tsのPREVIEW_TENANT_2と同値だが、
    // spec間でテナントID定数を共有する仕組みが無いため手動で複製している。
    // 仮に他テナント選択UIが実装されて選択肢に混入すればこのアサーションで落ちる
    // (単なる0件カウントには戻さない)。
    const OTHER_TENANT_IDS = [FOREIGN_TENANT, 'lp-demo'];
    const foreignOptions = optionValues.filter((v) => OTHER_TENANT_IDS.includes(v));
    expect(foreignOptions).toEqual([]);
  });

  // GID 1217040818410419(2026-07-31): 「書籍/PDFはR2C運用限定」の実装反映。
  // client_adminには旧UIのPDFタブボタン自体が出ず、?tab=pdf直リンクもlistへフォールバックする。
  test('B-IRR-4: client_adminは/admin/knowledge/:tenantId?tab=pdfへ直URL到達してもPDFタブに入れない', async ({ page }) => {
    await gotoAdmin(page, `/admin/knowledge/${OWN_TENANT}?tab=pdf`);
    test.info().annotations.push({ type: 'final-url', description: page.url() });
    const pdfTabCount = await page.getByText('PDFアップロード', { exact: true }).count();
    expect(pdfTabCount).toBe(0);
  });

  // このファイルの方針(非破壊のみ)に従い、以下2件も /v1/admin/agent/chat・fal/generate・
  // configs PATCH をモックする(理由は qa-copilot-preview.spec.ts CP-B-3 のコメントと同じ:
  // 実LLM/実課金/carnationの実データ書き換えに依存させない)。検証対象はUIの実配線であり、
  // モックは非破壊性を担保する手段そのものである。
  async function mockAvatarFlowUpToAdopted(page: any) {
    const sentMessages: string[] = [];
    await page.route('**/v1/admin/agent/chat', async (route: any) => {
      const body = JSON.parse(route.request().postData() || '{}') as { message?: string };
      sentMessages.push(body.message ?? '');
      // Asana 1217080508665459: 起動時ブリーフィングは回数ではなく内容で判定する
      // (qa-copilot-preview.spec.ts CP-B-3と同じ理由)。
      if (isBootstrapMessage(body.message)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '今週も順調です。', actions: [] }) });
      }
      if (body.message?.includes('アバターを作りたい')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: '見本をご提案しました。',
            actions: [{
              tool: 'suggest_avatar_preset',
              result: '「Haruka」というアバターの見本があります。\nプリセットID: preset-e2e-1\nこのまま採用しますか？',
              card: { kind: 'avatar_preset', presetId: 'preset-e2e-1', name: 'Haruka', imageUrl: null, description: 'とても丁寧な性格です。' },
            }],
          }),
        });
      }
      if (body.message === '採用してください') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: '採用しました。',
            actions: [{
              tool: 'adopt_avatar_preset',
              result: 'アバター「Haruka」を採用しました。まだ公開はされていません。',
              card: { kind: 'avatar_adopted', configId: 'cfg-e2e-1', name: 'Haruka', imageUrl: null, description: 'とても丁寧な性格です。' },
            }],
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '了解しました。', actions: [] }) });
    });
    await page.route('**/v1/admin/avatar/fal/generate', (route: any) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ images: ['https://img.example/1.png', 'https://img.example/2.png', 'https://img.example/3.png', 'https://img.example/4.png'] }),
      }),
    );
    return {
      countMessage: (message: string) => sentMessages.filter((m) => m === message).length,
    };
  }

  // 下書き(画像候補)そのものはサーバに永続化されない一方、採用済みアバター自体
  // (avatar_configs行 = adopt_avatar_presetの結果)はサーバ側に実在する。
  // sessionStorage(chatSessionStore)からの会話復元が、生成完了後の状態を正しく
  // 保つことを検証する。「生成の途中(status=generating)」でのリロードは、対応する
  // fetchそのものが中断されるため復帰しない(既知の制約。カードは永久にgenerating表示の
  // ままになる)。本テストは生成が完了した状態からのリロードのみを対象とする。
  test('B-IRR-5: 画像候補の生成が完了した状態でリロードしても会話が復元し、採用を続けられる', async ({ page }) => {
    await mockAvatarFlowUpToAdopted(page);
    let patchCount = 0;
    await page.route('**/v1/admin/avatar/configs/cfg-e2e-1', (route: any) => {
      if (route.request().method() === 'PATCH') {
        patchCount += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'cfg-e2e-1' }) });
      }
      return route.continue();
    });

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('アバターを作りたい');
    await send.click();
    await page.getByRole('button', { name: '採用して' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '採用して' }).click();
    await page.getByRole('button', { name: '画像を新しく生成する' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '画像を新しく生成する' }).click();
    await page.getByRole('button', { name: 'これにする' }).first().waitFor({ timeout: 10000 });

    // 会話の保存(chatSessionStore)は msgs 更新から300msデバウンスされている
    // (index.tsx: タイプライター演出の1応答あたり数百回書き込みを避けるため)。
    // 保存が実際にflushされる前にリロードすると、復元対象が無く会話が最初から
    // やり直しになってしまうため、デバウンス分より余裕を持って待つ。
    await page.waitForTimeout(800);

    // このタイミングで4枚の候補が既に描画され、保存も完了している(=生成は完了済み)。ここでリロードする。
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // 会話(sessionStorage)が復元し、候補カードとボタンがそのまま操作できる
    await expect(page.getByRole('button', { name: 'これにする' }).first()).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'これにする' }).first().click();
    await expect(page.getByRole('button', { name: 'これに決定' })).toBeVisible({ timeout: 10000 });
    expect(patchCount).toBe(1);
  });

  // GID: 下書き提案のチップを連打しても、2通目の「採用してください」が二重送信されない
  // (Msg.chipsUsed による使用済み化。連打はユーザーが実際にやりがちな操作)。
  test('B-IRR-6: 「採用して」チップを連打しても採用は1回しか実行されない', async ({ page }) => {
    const mock = await mockAvatarFlowUpToAdopted(page);

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('アバターを作りたい');
    await send.click();
    const adoptChip = page.getByRole('button', { name: '採用して' });
    await adoptChip.waitFor({ timeout: 10000 });

    // 連打(2回)。1回目のクリックでチップは使用済みになり消えるため、2回目は
    // 同じ要素に当たらず何も起きない想定。
    await adoptChip.click();
    await adoptChip.click({ timeout: 1000 }).catch(() => {}); // 消えていれば即タイムアウトでよい

    await expect(page.getByRole('button', { name: '画像を新しく生成する' })).toBeVisible({ timeout: 10000 });
    // 二重の実UI状態(チップが残っていない)と、実際の送信回数(サーバ視点)の両方を確認する
    expect(await page.getByRole('button', { name: '採用して' }).count()).toBe(0);
    expect(mock.countMessage('採用してください')).toBe(1);
  });

  // P6-1: アバターと同じ理由(実LLM/実carnationデータの書き換えに依存させない)で
  // suggest_tuning_rule/save_tuning_ruleをモックする。
  async function mockTuningRuleFlowUpToDraft(page: any) {
    let saveCalls = 0;
    const sentMessages: string[] = [];
    await page.route('**/v1/admin/agent/chat', async (route: any) => {
      const body = JSON.parse(route.request().postData() || '{}') as { message?: string };
      sentMessages.push(body.message ?? '');
      // Asana 1217080508665459: 起動時ブリーフィングは回数ではなく内容で判定する
      // (qa-copilot-preview.spec.ts CP-B-3と同じ理由)。
      if (isBootstrapMessage(body.message)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '今週も順調です。', actions: [] }) });
      }
      if (body.message?.includes('保証について聞かれたら')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: 'こう提案します。保存してよいですか？',
            actions: [{
              tool: 'suggest_tuning_rule',
              result: '提案:\nトリガー: 保証\n対応方針: 保証期間は2年とお伝えする\n優先度: 5',
              card: { kind: 'tuning_rule_draft', triggerPattern: '保証', expectedBehavior: '保証期間は2年とお伝えする', priority: 5 },
            }],
          }),
        });
      }
      if (body.message === '保存してください') {
        saveCalls += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: '保存しました。',
            actions: [{ tool: 'save_tuning_rule', result: '指示ルールを保存しました（ID: 999）: 「保証」→ 保証期間は2年とお伝えする' }],
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: '了解しました。', actions: [] }) });
    });
    return { saveCallCount: () => saveCalls, sentMessages };
  }

  // GID: 指示ルールの下書き提案チップ(保存して/やめておく)を連打しても、二重保存されない
  // (アバターの採用チップ連打(B-IRR-6)と同じ仕組み・同じ検証)。
  test('B-IRR-7 (P6-1): 指示ルールの「保存して」チップを連打しても保存は1回しか実行されない', async ({ page }) => {
    const mock = await mockTuningRuleFlowUpToDraft(page);

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('保証について聞かれたら2年と答えて');
    await send.click();
    const saveChip = page.getByRole('button', { name: '保存して' });
    await saveChip.waitFor({ timeout: 10000 });

    // 連打(2回)。1回目のクリックでチップは使用済みになり消えるため、2回目は同じ要素に当たらない想定。
    await saveChip.click();
    await saveChip.click({ timeout: 1000 }).catch(() => {});

    await expect(page.getByText('保存しました。', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(await page.getByRole('button', { name: '保存して' }).count()).toBe(0);
    expect(mock.saveCallCount()).toBe(1);
  });

  // GID: 下書き(保存して/やめておくチップ提示中)にリロードしても、sessionStorage復元で
  // 会話とチップが機能したまま続けられる(アバターの生成完了後リロード(B-IRR-5)と対の
  // シナリオ: こちらは「まだ何も書き込まれていない下書き段階」でのリロード)。
  test('B-IRR-8 (P6-1): 指示ルールの下書き提示中にリロードしても会話が復元し、保存を続けられる', async ({ page }) => {
    const mock = await mockTuningRuleFlowUpToDraft(page);

    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('保証について聞かれたら2年と答えて');
    await send.click();
    await page.getByRole('button', { name: '保存して' }).waitFor({ timeout: 10000 });

    // 会話保存(chatSessionStore)のデバウンス分の余裕を持って待つ(B-IRR-5と同じ理由)
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    await expect(page.getByRole('button', { name: '保存して' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: '保存して' }).click();
    await expect(page.getByText('保存しました。', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(mock.saveCallCount()).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Role C — super_admin 横断アクセス + プレビュー中スコープ（既知ギャップ）
// ───────────────────────────────────────────────────────────────────────────
test.describe('Irregular — Role C (super_admin cross-tenant & preview)', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  // super_admin の storageState は事前に superadmin.setup.ts で生成する（Role B の user.json と同方式）。
  // 生成済みトークンが有効セッションを含むかを確認し、無ければ skip。
  const fs = require('fs');
  let saReady = false;
  try {
    const raw = JSON.parse(fs.readFileSync(SA_AUTH, 'utf8'));
    const tokenEntry = raw?.origins?.[0]?.localStorage?.find((e: any) => /auth-token/.test(e.name));
    if (tokenEntry) {
      const parsed = JSON.parse(tokenEntry.value);
      // exp が未来（有効）か確認
      saReady = typeof parsed?.expires_at === 'number' && parsed.expires_at * 1000 > Date.now();
    }
  } catch {
    saReady = false;
  }

  test.use({ storageState: SA_AUTH });
  test.beforeEach(() => {
    test.skip(!saReady, 'super_admin storageState 未生成/期限切れ — superadmin.setup.ts を先に実行');
  });

  test('C-IRR-1: super_admin は super専用 /admin/tenants に到達できる（弾かれない）', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/tenants`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/admin/tenants');
    expect(page.url()).not.toContain('/login');
    const body = (await page.textContent('body')) ?? '';
    expect(body.length).toBeGreaterThan(0);
  });

  test('C-IRR-2: super_admin の共通ページには横断テナント選択UIが出る（client_adminとの差）', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/chat-history`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    // super_admin は全テナント集約ビュー → テナント選択セレクタ等の横断UIが存在するはず
    const selectCount = await page.locator('select').count();
    test.info().annotations.push({ type: 'select-count', description: String(selectCount) });
    expect(selectCount).toBeGreaterThan(0);
  });

  test('C-IRR-3: プレビュー導線の有無を確認（escalations/tuning のスコープ既知ギャップの足がかり）', async ({ page }) => {
    // テナント詳細を開き「クライアントビューで見る」導線が存在するかを確認する。
    // プレビュー状態は in-memory のため、ここでは導線の存在確認と、非プレビュー時の
    // escalations 横断ビュー挙動の観測に留める（完全なリーク再現は要seed fixtureのため別途）。
    await page.goto(`${ADMIN}/admin/tenants`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    const previewLink = page.getByText(/クライアントビュー|プレビュー|preview/i);
    const hasPreviewEntry = (await previewLink.count()) > 0;
    test.info().annotations.push({ type: 'preview-entry-found', description: String(hasPreviewEntry) });

    // 非プレビュー時: super_admin の escalations は横断ビュー（tenant scope=null）である想定。
    await page.goto(`${ADMIN}/admin/escalations`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    expect(page.url()).toContain('/admin/escalations');
    expect(page.url()).not.toContain('/login');
  });

  // GID 1217040818410419(2026-07-31): super_admin(previewMode外)は「書籍/PDFはR2C運用限定」
  // の対象そのものなので、旧UIのPDFタブは従来通り出ることを固定する(client_adminのB-IRR-4と対)。
  test('C-IRR-4: super_adminは/admin/knowledge/global?tab=pdfでPDFタブに到達できる（弾かれない）', async ({ page }) => {
    await page.goto(`${ADMIN}/admin/knowledge/global?tab=pdf`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const pdfTabCount = await page.getByText('PDFアップロード', { exact: true }).count();
    expect(pdfTabCount).toBeGreaterThan(0);
  });

  // previewMode を一切設定せず /copilot-preview を直接開く(page.gotoで良い。previewMode
  // 未設定=状態を消す心配が無いため他のC-LEAK系テストのような制約が無い)。
  // activate_avatar はテナントが解決できないため未確定のIDに対しても実行前に拒否され、
  // DBへは触れない(既存jestテスト同様のガード。実backendに対して安全に実行できる)。
  test('C-IRR-5: super_adminがpreview未選択のままアバターの有効化を指示すると拒否される', async ({ page }) => {
    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page
      .waitForResponse((res) => res.url().includes('/v1/admin/agent/chat') && res.request().method() === 'POST', { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(2000);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('アバターを有効化してください');
    const chatResP = page.waitForResponse(
      (res) => res.url().includes('/v1/admin/agent/chat') && res.request().method() === 'POST',
      { timeout: 20000 },
    );
    await send.click();
    await chatResP;
    await page.waitForTimeout(1500);

    const body = (await page.textContent('body')) ?? '';
    expect(body).toContain('テナントが特定できません');
  });

  // P6-1: C-IRR-5(activate_avatar)と同型。suggest_tuning_rule/save_tuning_ruleも
  // tenantId未解決の場合、Groq呼び出し・DB読み書きの手前で拒否される(実backendに安全に実行できる)。
  test('C-IRR-6 (P6-1): super_adminがpreview未選択のまま指示ルールの作成・保存を指示すると拒否される', async ({ page }) => {
    await page.goto(`${ADMIN}/copilot-preview`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page
      .waitForResponse((res) => res.url().includes('/v1/admin/agent/chat') && res.request().method() === 'POST', { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(2000);

    const composer = page.getByPlaceholder(/指示ルール/);
    const send = page.getByLabel('送信');
    await composer.fill('「保証について聞かれたら2年と答えて」という指示ルールを作って保存してください');
    const chatResP = page.waitForResponse(
      (res) => res.url().includes('/v1/admin/agent/chat') && res.request().method() === 'POST',
      { timeout: 20000 },
    );
    await send.click();
    await chatResP;
    await page.waitForTimeout(1500);

    const body = (await page.textContent('body')) ?? '';
    expect(body).toContain('テナントが特定できません');
  });
});
