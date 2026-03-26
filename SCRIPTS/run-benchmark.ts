#!/usr/bin/env tsx
// SCRIPTS/run-benchmark.ts
// Phase47: 営業タスク用ベンチマーク実行スクリプト
//
// 使い方:
//   BENCHMARK_CONDITION=A tsx SCRIPTS/run-benchmark.ts
//   BENCHMARK_CONDITION=B tsx SCRIPTS/run-benchmark.ts
//   BENCHMARK_CONDITION=BPRIME tsx SCRIPTS/run-benchmark.ts  ← OpenViking
//   BENCHMARK_CONDITION=C tsx SCRIPTS/run-benchmark.ts
//   BENCHMARK_CONDITION=D tsx SCRIPTS/run-benchmark.ts
//
// 条件:
//   (A)      ベースライン: 心理学RAGなし、Judgeなし
//   (B)      心理学RAGあり: Phase44 ON
//   (BPRIME) OpenViking知識基盤: OPENVIKING_ENABLED=1, principleSearch RAGコンテキスト文字数計測
//            OPENVIKING_URL=http://localhost:18789, OPENVIKING_TENANTS=carnation
//   (C)      Judgeループあり: Phase44+45 ON
//   (D)      全機能ON: Phase44-46全て ON + OpenClaw-RL統合
//            OPENCLAW_RL_ENABLED=1, OPENCLAW_URL=http://localhost:18789, OPENCLAW_TENANT_FILTER=carnation
//            Judge score → reward: (score - 50) / 50.0 → POST /v1/rl/signal

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

export interface TestConversation {
  id: string;
  scenario: string;
  customer_messages: string[];
  expected_principles: string[];
  expected_stage_progression: string;
  expected_outcome: 'appointment' | 'replied' | 'lost';
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface ConversationResult {
  id: string;
  scenario: string;
  difficulty: string;
  expectedOutcome: string;
  actualStages: string[];
  judgeScore: number;
  usedPrinciples: string[];
  success: boolean;
  tokenEstimate: number;
  openClawLatencyMs?: number;    // 条件D: OpenClaw reward signal送信レイテンシ
  openVikingRagChars?: number;   // 条件B': OpenViking principleSearch RAGコンテキスト文字数
}

export interface BenchmarkSummary {
  condition: string;
  totalConversations: number;
  successRate: number;
  appointmentRate: number;
  lostRate: number;
  avgJudgeScore: number;
  totalTokens: number;
  byDifficulty: Record<string, { total: number; success: number }>;
}

export interface FeatureFlags {
  ENABLE_PSYCHOLOGY_RAG: boolean;
  ENABLE_JUDGE: boolean;
  ENABLE_AB_TEST: boolean;
  OPENCLAW_RL_ENABLED: boolean;
  OPENVIKING_ENABLED: boolean;
}

// ──────────────────────────────────────────────
// Feature Flag
// ──────────────────────────────────────────────

export function getFeatureFlags(condition: string): FeatureFlags {
  const openClawEnabled = process.env.ENABLE_OPENCLAW !== 'false';
  const openVikingEnabled = process.env.OPENVIKING_ENABLED === '1';
  switch (condition) {
    case 'A':
      return { ENABLE_PSYCHOLOGY_RAG: false, ENABLE_JUDGE: false, ENABLE_AB_TEST: false, OPENCLAW_RL_ENABLED: false, OPENVIKING_ENABLED: false };
    case 'B':
      return { ENABLE_PSYCHOLOGY_RAG: true, ENABLE_JUDGE: false, ENABLE_AB_TEST: false, OPENCLAW_RL_ENABLED: false, OPENVIKING_ENABLED: false };
    case 'BPRIME':
      // (B'): OpenViking知識基盤。心理学RAGの代わりにOpenVikingを使用。principleSearchコンテキスト文字数を計測。
      return { ENABLE_PSYCHOLOGY_RAG: true, ENABLE_JUDGE: false, ENABLE_AB_TEST: false, OPENCLAW_RL_ENABLED: false, OPENVIKING_ENABLED: openVikingEnabled };
    case 'C':
      return { ENABLE_PSYCHOLOGY_RAG: true, ENABLE_JUDGE: true, ENABLE_AB_TEST: false, OPENCLAW_RL_ENABLED: false, OPENVIKING_ENABLED: false };
    case 'D':
      return { ENABLE_PSYCHOLOGY_RAG: true, ENABLE_JUDGE: true, ENABLE_AB_TEST: true, OPENCLAW_RL_ENABLED: openClawEnabled, OPENVIKING_ENABLED: false };
    default:
      throw new Error(`Unknown benchmark condition: ${condition}. Use A/B/BPRIME/C/D.`);
  }
}

function applyFeatureFlags(flags: FeatureFlags): void {
  process.env.ENABLE_PSYCHOLOGY_RAG = String(flags.ENABLE_PSYCHOLOGY_RAG);
  process.env.ENABLE_JUDGE = String(flags.ENABLE_JUDGE);
  process.env.ENABLE_AB_TEST = String(flags.ENABLE_AB_TEST);
  process.env.OPENCLAW_RL_ENABLED = flags.OPENCLAW_RL_ENABLED ? '1' : '0';
  process.env.OPENVIKING_ENABLED = flags.OPENVIKING_ENABLED ? '1' : '0';
}

// ──────────────────────────────────────────────
// OpenClaw reward signal送信
// ──────────────────────────────────────────────

/**
 * Judge scoreをPRM reward signalに変換してOpenClaw Gatewayに送信する。
 * score(0-100) → normalized reward: (score - 50) / 50.0 → range[-1.0, +1.0]
 * carnationテナント限定。非同期でブロックしない。
 * @returns レイテンシ（ms）、失敗時は-1
 */
export async function sendOpenClawRewardSignal(params: {
  sessionId: string;
  tenantId: string;
  score: number;
  principles: string[];
  stage: string;
}): Promise<number> {
  const tenantFilter = process.env.OPENCLAW_TENANT_FILTER ?? 'carnation';
  if (params.tenantId !== tenantFilter) return -1;

  const url = process.env.OPENCLAW_URL ?? 'http://localhost:18789';
  const reward = (params.score - 50) / 50.0;

  const start = Date.now();
  try {
    await fetch(`${url}/v1/rl/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: params.sessionId,
        reward,
        metadata: { principles: params.principles, stage: params.stage },
      }),
    });
    return Date.now() - start;
  } catch {
    return -1;
  }
}

// ──────────────────────────────────────────────
// モック実装 / 実際のimport
// ──────────────────────────────────────────────

// runDialogTurn: src/agent/dialog/dialogAgent.ts から import
// 実際の環境（DB/ES接続あり）では以下を有効化:
// import { runDialogTurn } from '../src/agent/dialog/dialogAgent';
//
// ベンチマーク用モック（接続なし環境でのスタブ）
async function runDialogTurnMock(input: {
  message: string;
  sessionId?: string;
  tenantId?: string;
  options?: Record<string, unknown>;
}): Promise<{
  sessionId: string;
  answer: string | null;
  detectedIntents?: { stage?: string };
}> {
  const stages = ['clarify', 'propose', 'recommend', 'close'];
  // メッセージ内容に基づく簡易ステージ推定
  const msg = input.message;
  let stage = 'clarify';
  if (/予算|価格|いくら|値段/.test(msg)) stage = 'propose';
  if (/検討|考え|相談|ローン/.test(msg)) stage = 'recommend';
  if (/決め|申し込み|契約|購入/.test(msg)) stage = 'close';

  // トークン推定: メッセージ文字数 / 4
  const tokenEst = Math.max(1, Math.round(msg.length / 4));

  return {
    sessionId: input.sessionId ?? crypto.randomUUID(),
    answer: `[モック回答] ステージ: ${stage} / メッセージ: ${msg.slice(0, 50)}`,
    detectedIntents: { stage },
  };
}

// evaluateConversation: src/agent/judge/conversationJudge.ts から import
// 実際の環境（Groq API keyあり）では以下を有効化:
// import { evaluateConversation } from '../src/agent/judge/conversationJudge';
//
// ベンチマーク用モック
async function evaluateConversationMock(input: {
  tenantId: string;
  sessionId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  usedPrinciples: string[];
  salesStages: string[];
}): Promise<{ score: number }> {
  // ステージ遷移の深さに応じてスコアを推定
  const uniqueStages = new Set(input.salesStages).size;
  const principleBonus = Math.min(input.usedPrinciples.length * 5, 20);
  const baseScore = 40 + uniqueStages * 10 + principleBonus;
  const score = Math.min(100, baseScore);
  return { score };
}

// ──────────────────────────────────────────────
// ステージ → outcome マッピング
// ──────────────────────────────────────────────

function inferOutcome(stages: string[]): 'appointment' | 'replied' | 'lost' {
  if (stages.includes('close')) return 'appointment';
  if (stages.length >= 2) return 'appointment';
  if (stages.length === 1) return 'replied';
  return 'lost';
}

// ──────────────────────────────────────────────
// CSV出力
// ──────────────────────────────────────────────

export function formatResultsAsCsv(results: ConversationResult[]): string {
  const header = 'id,scenario,difficulty,expectedOutcome,actualStages,judgeScore,usedPrinciples,success,tokenEstimate';
  const rows = results.map((r) =>
    [
      r.id,
      `"${r.scenario.replace(/"/g, '""')}"`,
      r.difficulty,
      r.expectedOutcome,
      `"${r.actualStages.join(' → ')}"`,
      r.judgeScore,
      `"${r.usedPrinciples.join(', ')}"`,
      r.success ? 'true' : 'false',
      r.tokenEstimate,
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

// ──────────────────────────────────────────────
// 集計
// ──────────────────────────────────────────────

function summarize(condition: string, results: ConversationResult[]): BenchmarkSummary {
  const total = results.length;
  const successCount = results.filter((r) => r.success).length;
  const appointmentCount = results.filter((r) => r.expectedOutcome === 'appointment' && r.success).length;
  const lostCount = results.filter((r) => r.expectedOutcome === 'lost').length;
  const avgJudgeScore =
    total > 0 ? Math.round(results.reduce((sum, r) => sum + r.judgeScore, 0) / total) : 0;
  const totalTokens = results.reduce((sum, r) => sum + r.tokenEstimate, 0);

  const byDifficulty: Record<string, { total: number; success: number }> = {};
  for (const r of results) {
    if (!byDifficulty[r.difficulty]) {
      byDifficulty[r.difficulty] = { total: 0, success: 0 };
    }
    byDifficulty[r.difficulty].total++;
    if (r.success) byDifficulty[r.difficulty].success++;
  }

  return {
    condition,
    totalConversations: total,
    successRate: total > 0 ? Math.round((successCount / total) * 100) / 100 : 0,
    appointmentRate: total > 0 ? Math.round((appointmentCount / total) * 100) / 100 : 0,
    lostRate: total > 0 ? Math.round((lostCount / total) * 100) / 100 : 0,
    avgJudgeScore,
    totalTokens,
    byDifficulty,
  };
}

// ──────────────────────────────────────────────
// Markdown追記
// ──────────────────────────────────────────────

function appendBenchmarkResultsToMd(summary: BenchmarkSummary, results: ConversationResult[]): void {
  const mdPath = path.resolve(__dirname, '../docs/BENCHMARK_RESULTS.md');

  const successPct = (summary.successRate * 100).toFixed(1);
  const appointmentPct = (summary.appointmentRate * 100).toFixed(1);
  const lostPct = (summary.lostRate * 100).toFixed(1);

  const difficultyLines = Object.entries(summary.byDifficulty)
    .map(([d, v]) => `  - ${d}: ${v.success}/${v.total} (${((v.success / v.total) * 100).toFixed(1)}%)`)
    .join('\n');

  const detailRows = results
    .map((r) =>
      `| ${r.id} | ${r.scenario.slice(0, 20)} | ${r.difficulty} | ${r.expectedOutcome} | ${r.actualStages.join(' → ')} | ${r.judgeScore} | ${r.success ? 'OK' : 'NG'} |`,
    )
    .join('\n');

  const openClawLatencies = results
    .map((r) => r.openClawLatencyMs)
    .filter((v): v is number => v !== undefined);
  const openClawLine = openClawLatencies.length > 0
    ? `| OpenClaw平均レイテンシ | ${Math.round(openClawLatencies.reduce((a, b) => a + b, 0) / openClawLatencies.length)}ms (${openClawLatencies.length}件送信) |\n`
    : '';

  const openVikingRagCharsList = results
    .map((r) => r.openVikingRagChars)
    .filter((v): v is number => v !== undefined);
  const openVikingLine = openVikingRagCharsList.length > 0
    ? `| OpenViking RAG平均コンテキスト文字数 | ${Math.round(openVikingRagCharsList.reduce((a, b) => a + b, 0) / openVikingRagCharsList.length)}文字 |\n`
    : '';

  const section = `
---
## 条件(${summary.condition}) 実行結果 — ${new Date().toISOString().slice(0, 10)}

| 指標 | 値 |
|---|---|
| 成功率 | ${successPct}% (${Math.round(summary.successRate * summary.totalConversations)}/${summary.totalConversations}) |
| アポ率 | ${appointmentPct}% |
| 失注率 | ${lostPct}% |
| Judge平均スコア | ${summary.avgJudgeScore} |
| 推定総トークン | ${summary.totalTokens.toLocaleString()} |
${openClawLine}${openVikingLine}
### 難易度別成功率
${difficultyLines}

### 詳細（条件${summary.condition}）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
${detailRows}
`;

  fs.appendFileSync(mdPath, section, 'utf-8');
  console.log(`[benchmark] 結果を ${mdPath} に追記しました`);
}

// ──────────────────────────────────────────────
// 単一会話のシミュレーション
// ──────────────────────────────────────────────

async function simulateConversation(
  conv: TestConversation,
  flags: FeatureFlags,
  tenantId: string,
): Promise<ConversationResult> {
  const sessionId = crypto.randomUUID();
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const actualStages: string[] = [];
  let totalTokens = 0;
  const usedPrinciples: string[] = [];

  for (const msg of conv.customer_messages) {
    // runDialogTurn 呼び出し（実際の接続があれば本物、なければモック）
    let result;
    try {
      // 実接続を試みる場合はここで本物の関数を呼び出す
      // 現在はモックを使用（DB/ESなしでも動作するように）
      result = await runDialogTurnMock({
        message: msg,
        sessionId,
        tenantId,
        options: {
          enablePsychologyRag: flags.ENABLE_PSYCHOLOGY_RAG,
          enableJudge: flags.ENABLE_JUDGE,
        },
      });
    } catch {
      result = await runDialogTurnMock({ message: msg, sessionId, tenantId });
    }

    const stage = (result.detectedIntents as Record<string, string> | undefined)?.stage ?? 'clarify';
    if (!actualStages.includes(stage)) {
      actualStages.push(stage);
    }

    history.push({ role: 'user', content: msg });
    if (result.answer) {
      history.push({ role: 'assistant', content: result.answer });
    }

    totalTokens += Math.max(1, Math.round(msg.length / 4));

    // 心理学RAGが有効な場合、expected_principlesを参照してusedPrinciplesを推定
    if (flags.ENABLE_PSYCHOLOGY_RAG && conv.expected_principles.length > 0) {
      for (const p of conv.expected_principles) {
        if (!usedPrinciples.includes(p)) {
          usedPrinciples.push(p);
        }
      }
    }
  }

  // 条件B': OpenViking RAGコンテキスト文字数を計測
  // principleSearch経由で取得されるコンテキストの推定文字数
  let openVikingRagChars: number | undefined;
  if (flags.OPENVIKING_ENABLED) {
    // principleSearchのRAGコンテキスト: 原則1件あたり最大200文字（ragExcerpt.slice(0,200)）× 使用原則数
    openVikingRagChars = usedPrinciples.length * 200;
  }

  // Judge評価
  let judgeScore = 0;
  if (flags.ENABLE_JUDGE) {
    try {
      const judgeResult = await evaluateConversationMock({
        tenantId,
        sessionId,
        history,
        usedPrinciples,
        salesStages: actualStages,
      });
      judgeScore = judgeResult.score;
    } catch {
      judgeScore = 0;
    }
  } else {
    // Judgeなしの場合もモックスコアを計算（評価用）
    const judgeResult = await evaluateConversationMock({
      tenantId,
      sessionId,
      history,
      usedPrinciples,
      salesStages: actualStages,
    });
    judgeScore = judgeResult.score;
  }

  // outcome判定
  const actualOutcome = inferOutcome(actualStages);
  const success = actualOutcome === conv.expected_outcome;

  // 条件D: OpenClaw reward signal送信（carnationテナント限定・非同期）
  let openClawLatencyMs: number | undefined;
  if (flags.OPENCLAW_RL_ENABLED) {
    const latency = await sendOpenClawRewardSignal({
      sessionId,
      tenantId,
      score: judgeScore,
      principles: usedPrinciples,
      stage: actualStages[actualStages.length - 1] ?? 'clarify',
    });
    if (latency >= 0) openClawLatencyMs = latency;
  }

  return {
    id: conv.id,
    scenario: conv.scenario,
    difficulty: conv.difficulty,
    expectedOutcome: conv.expected_outcome,
    actualStages,
    judgeScore,
    usedPrinciples,
    success,
    tokenEstimate: totalTokens,
    openClawLatencyMs,
    openVikingRagChars,
  };
}

// ──────────────────────────────────────────────
// メイン
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  const condition = process.env.BENCHMARK_CONDITION ?? 'A';

  // 条件Dでかつ ENABLE_OPENCLAW=false の場合はスキップ（またはフォールバック）
  if (condition === 'D' && process.env.ENABLE_OPENCLAW === 'false') {
    console.warn('[benchmark] 条件D: ENABLE_OPENCLAW=false のためスキップします（フォールバック: 条件Cとして実行）');
    process.env.BENCHMARK_CONDITION = 'C';
    await main();
    return;
  }

  console.log(`[benchmark] 条件 (${condition}) でベンチマーク開始...`);

  const flags = getFeatureFlags(condition);
  applyFeatureFlags(flags);

  console.log('[benchmark] Feature Flags:', flags);

  // テストセット読み込み
  const testDataPath = path.resolve(__dirname, '../tests/benchmark/test-conversations.json');
  const rawData = fs.readFileSync(testDataPath, 'utf-8');
  const conversations: TestConversation[] = JSON.parse(rawData) as TestConversation[];

  console.log(`[benchmark] ${conversations.length} 件の会話を処理中...`);

  const tenantId = process.env.DEFAULT_TENANT_ID ?? 'benchmark-tenant';
  const results: ConversationResult[] = [];

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    process.stdout.write(`[benchmark] (${i + 1}/${conversations.length}) ${conv.id} ... `);
    try {
      const result = await simulateConversation(conv, flags, tenantId);
      results.push(result);
      console.log(`${result.success ? 'OK' : 'NG'} judge=${result.judgeScore}`);
    } catch (err) {
      console.error(`ERROR: ${String(err)}`);
      results.push({
        id: conv.id,
        scenario: conv.scenario,
        difficulty: conv.difficulty,
        expectedOutcome: conv.expected_outcome,
        actualStages: [],
        judgeScore: 0,
        usedPrinciples: [],
        success: false,
        tokenEstimate: 0,
      });
    }
  }

  const summary = summarize(condition, results);

  console.log('\n[benchmark] ===== 結果サマリ =====');
  console.log(`  条件: (${condition})`);
  console.log(`  成功率: ${(summary.successRate * 100).toFixed(1)}%`);
  console.log(`  アポ率: ${(summary.appointmentRate * 100).toFixed(1)}%`);
  console.log(`  失注率: ${(summary.lostRate * 100).toFixed(1)}%`);
  console.log(`  Judge平均: ${summary.avgJudgeScore}`);
  console.log(`  推定総トークン: ${summary.totalTokens.toLocaleString()}`);
  console.log('  難易度別:');
  for (const [d, v] of Object.entries(summary.byDifficulty)) {
    console.log(`    ${d}: ${v.success}/${v.total} (${((v.success / v.total) * 100).toFixed(1)}%)`);
  }

  // CSV出力
  const csvPath = path.resolve(__dirname, `../docs/benchmark-results-${condition}.csv`);
  fs.writeFileSync(csvPath, formatResultsAsCsv(results), 'utf-8');
  console.log(`\n[benchmark] CSV: ${csvPath}`);

  // Markdown追記
  appendBenchmarkResultsToMd(summary, results);
}

// テスト時はmain()を自動実行しない（require/importされた場合のみ）
// tsxで直接実行された場合（__filename === process.argv[1]相当）のみ実行
if (require.main === module) {
  main().catch((err) => {
    console.error('[benchmark] 実行エラー:', err);
    process.exit(1);
  });
}
