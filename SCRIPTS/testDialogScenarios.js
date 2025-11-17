// SCRIPTS/testDialogScenarios.js
// Phase4: /agent.dialog の代表シナリオをまとめてテストする簡易スクリプト
//
// 使い方:
//  1. サーバーを起動: npm start
//  2. 別ターミナルで: node SCRIPTS/testDialogScenarios.js

const BASE_URL = process.env.DIALOG_BASE_URL || 'http://localhost:3000';

function assertCond(condition, message) {
  if (condition) {
    console.log('  ✅', message);
  } else {
    console.warn('  ⚠️', message);
  }
}

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

async function scenarioShippingClarify() {
  console.log('\n=== scenario: shipping_clarify (1st turn) ===');

  const reqBody = {
    message: '送料はいくらですか？',
    history: [],
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  assertCond(body.needsClarification === true, 'needsClarification === true');
  assertCond(
    Array.isArray(body.clarifyingQuestions) && body.clarifyingQuestions.length > 0,
    'clarifyingQuestions are present',
  );

  return { firstTurn: reqBody, firstResponse: body };
}

async function scenarioShippingFollowup(firstTurn, firstResponse) {
  console.log('\n=== scenario: shipping_followup (2nd turn) ===');

  const history = [
    { role: 'user', content: firstTurn.message },
    { role: 'assistant', content: firstResponse.answer ?? '' },
  ];

  const reqBody = {
    message: 'Tシャツで、東京都への配送です。',
    history,
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  assertCond(body.final === true, 'final === true');
  assertCond(body.needsClarification === false, 'needsClarification === false');
  assertCond(typeof body.answer === 'string' && body.answer.length > 0, 'answer text is present');
}

async function scenarioReturnsClarify() {
  console.log('\n=== scenario: returns_clarify ===');

  const reqBody = {
    message: '不良品が届いたので返品したいです。',
    history: [],
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  assertCond(body.needsClarification === true, 'needsClarification === true');
  assertCond(
    Array.isArray(body.clarifyingQuestions) && body.clarifyingQuestions.length > 0,
    'clarifyingQuestions are present',
  );
}

async function scenarioPaymentError() {
  console.log('\n=== scenario: payment_error ===');

  const reqBody = {
    message: 'クレジットカード決済でエラーが出ます。',
    history: [],
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  assertCond(body.needsClarification === true, 'needsClarification === true');

  if (body.meta && Array.isArray(body.meta.plannerReasons)) {
    const reasons = body.meta.plannerReasons.join(', ');
    console.log('  ℹ️ plannerReasons:', reasons);
  }
}

async function scenarioProductStock() {
  console.log('\n=== scenario: product_stock ===');

  const reqBody = {
    message: 'このスニーカーの在庫とサイズ感を教えてください。',
    history: [],
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  assertCond(body.needsClarification === true, 'needsClarification === true');
  assertCond(
    Array.isArray(body.clarifyingQuestions) && body.clarifyingQuestions.length > 0,
    'clarifyingQuestions are present',
  );
}

async function scenarioSafetyPolicy() {
  console.log('\n=== scenario: safety_policy ===');

  const reqBody = {
    message: '暴力的な行為や虐待に関するポリシーを教えてください。',
    history: [],
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  assertCond(body.meta && body.meta.route === '120b', 'route === 120b (safe-mode upgrade)');
  assertCond(
    body.meta && body.meta.requiresSafeMode === true,
    'requiresSafeMode === true (safety)',
  );
}

async function scenarioLongHistorySummary() {
  console.log('\n=== scenario: long_history_summary ===');

  const history = [];
  for (let i = 0; i < 14; i++) {
    history.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `dummy turn ${i + 1}`,
    });
  }

  const reqBody = {
    message: 'ここまでのやりとりを踏まえて、最適なプランを教えてください。',
    history,
    options: { language: 'ja' },
  };

  const { status, body } = await callAgent(reqBody);
  console.dir(body, { depth: 5 });

  assertCond(status === 200, 'HTTP 200');
  // サマリ自体はサーバー内部で扱うので、ここではレスポンスが正常かどうかだけを見る
  if (body.meta) {
    console.log('  ℹ️ route:', body.meta.route);
    console.log('  ℹ️ plannerReasons:', body.meta.plannerReasons);
  }
}

async function main() {
  try {
    console.log('Base URL:', BASE_URL);

    const { firstTurn, firstResponse } = await scenarioShippingClarify();
    await scenarioShippingFollowup(firstTurn, firstResponse);

    await scenarioReturnsClarify();
    await scenarioPaymentError();
    await scenarioProductStock();
    await scenarioSafetyPolicy();
    await scenarioLongHistorySummary();

    console.log('\nAll scenarios executed.\n');
  } catch (err) {
    console.error('Scenario test failed:', err);
    process.exitCode = 1;
  }
}

main();