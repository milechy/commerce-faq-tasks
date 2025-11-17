// SCRIPTS/loadTestDialogGraph.js
// Phase4: /agent.dialog の簡易ロードテスト（p50 / p95 / max 計測）
//
// 使い方:
//  1. サーバーを起動: npm start
//  2. 別ターミナルで: node SCRIPTS/loadTestDialogGraph.js
//     （必要に応じて環境変数で調整）
//
// 環境変数:
//  - DIALOG_BASE_URL: デフォルト "http://localhost:3000"
//  - DIALOG_LOAD_NUM: リクエスト回数（デフォルト 30）

const BASE_URL = process.env.DIALOG_BASE_URL || 'http://localhost:3000';
const NUM_REQUESTS = Number(process.env.DIALOG_LOAD_NUM || 30);

/**
 * 簡易アサート（落とさずに警告だけ出す）
 */
function assertCond(condition, message) {
  if (condition) {
    console.log('  ✅', message);
  } else {
    console.warn('  ⚠️', message);
  }
}

/**
 * /agent.dialog を叩く共通関数
 */
async function callAgent(body) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available. Use Node >=18 or polyfill fetch.');
  }

  const res = await fetch(`${BASE_URL}/agent.dialog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  return { status: res.status, body: json };
}

/**
 * 負荷テスト用の代表シナリオ
 * ※ まずは 20B 系だけにして、rate limit を避ける
 */
function buildScenario(index) {
  const scenarios = [
    {
      name: 'shipping_clarify',
      body: {
        message: '送料はいくらですか？',
        history: [],
        options: { language: 'ja' },
      },
    },
    {
      name: 'returns_clarify',
      body: {
        message: '不良品が届いたので返品したいです。',
        history: [],
        options: { language: 'ja' },
      },
    },
    {
      name: 'payment_error',
      body: {
        message: 'クレジットカード決済でエラーが出ます。',
        history: [],
        options: { language: 'ja' },
      },
    },
    {
      name: 'product_stock',
      body: {
        message: 'このスニーカーの在庫とサイズ感を教えてください。',
        history: [],
        options: { language: 'ja' },
      },
    },
    // ★ 120B / セーフティ系を含めたい場合は、下のコメントアウトを使う（件数は少なめ推奨）
    // {
    //   name: 'safety_policy',
    //   body: {
    //     message: '暴力的な行為や虐待に関するポリシーを教えてください。',
    //     history: [],
    //     options: { language: 'ja' },
    //   },
    // },
  ];

  return scenarios[index % scenarios.length];
}

/**
 * 2ターン目の followup シナリオ（fast-path テスト用）
 */
function buildFollowupScenario(index) {
  return {
    name: 'shipping_followup_fastpath',
    body: {
      message: 'Tシャツで、東京都への配送です。',
      history: [
        { role: 'user', content: '送料はいくらですか？' },
        { role: 'assistant', content: 'どの商品・どの地域への配送／送料について知りたいですか？' }
      ],
      options: { language: 'ja' },
    },
  };
}

/**
 * p50/p95 をざっくり計算するヘルパー
 */
function summarizeLatencies(durations) {
  if (!durations.length) {
    console.log('No durations recorded.');
    return;
  }

  const sorted = [...durations].sort((a, b) => a - b);

  const q = (p) => {
    const idx = Math.floor((sorted.length - 1) * p);
    return sorted[idx];
  };

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = q(0.5);
  const p95 = q(0.95);

  console.log('\n=== Latency summary (client-side) ===');
  console.log('count =', sorted.length);
  console.log('min   =', min.toFixed(1), 'ms');
  console.log('p50   =', p50.toFixed(1), 'ms');
  console.log('p95   =', p95.toFixed(1), 'ms');
  console.log('max   =', max.toFixed(1), 'ms');
}

/**
 * メイン：NUM_REQUESTS 回 /agent.dialog を叩いて p95 を出す
 */
async function main() {
  console.log('Base URL:', BASE_URL);
  console.log('NUM_REQUESTS:', NUM_REQUESTS);

  const durations = [];

  for (let i = 0; i < NUM_REQUESTS; i++) {
    const isFollowup = i % 2 === 1;
    const { name, body } = isFollowup ? buildFollowupScenario(i) : buildScenario(i);

    // client-side の計測（performance.now があればそれを使う）
    const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let res;
    try {
      res = await callAgent(body);
    } catch (err) {
      console.error(`[#${i + 1}] ${name}: request failed`, err);
      continue;
    }
    const t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const dt = t1 - t0;
    durations.push(dt);

    const route = res.body?.meta?.route;
    const mode = res.body?.meta?.orchestratorMode;
    const safetyTag = res.body?.meta?.safetyTag;

    console.log(
      `[#${i + 1}] ${name}: ${dt.toFixed(1)} ms, status=${res.status}, route=${route}, mode=${mode}, safety=${safetyTag}`,
    );

    // 一応 500 エラーなどは WARN に出しておく
    assertCond(res.status === 200, 'HTTP 200');
  }

  summarizeLatencies(durations);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exitCode = 1;
});