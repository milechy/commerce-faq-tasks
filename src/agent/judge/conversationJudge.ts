// src/agent/judge/conversationJudge.ts
// Phase45: Judge評価エンジン - Groq 70b (llama-3.3-70b-versatile) で会話を評価

import pino from 'pino';
import { callGroqWith429Retry } from '../llm/groqClient';

const logger = pino();

const JUDGE_MODEL = 'llama-3.3-70b-versatile';

export interface JudgeInput {
  tenantId: string;
  sessionId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  usedPrinciples: string[];
  salesStages: string[]; // ステージ遷移の記録
}

export interface JudgeResult {
  score: number; // 0-100
  evaluationAxes: {
    principle_appropriateness: number;
    customer_reaction: number;
    stage_progression: number;
    contraindication_compliance: number;
  };
  effectivePrinciples: string[];
  failedPrinciples: string[];
  notes: string;
  modelUsed: string;
}

const FEW_SHOT_EXAMPLES = `
## 評価例（few-shot calibration）

### 例1: 高スコア (score: 85)
会話:
- user: 「他のお客さんはどうですか？」
- assistant: 「多くのお客様が同様の選択をされています（社会的証明）。また、今月中のご注文で特別価格が適用されます（希少性）。」
評価:
{
  "principle_appropriateness": 90,
  "customer_reaction": 85,
  "stage_progression": 80,
  "contraindication_compliance": 85,
  "effective_principles": ["社会的証明", "希少性"],
  "failed_principles": [],
  "notes": "希少性原則を適切に使用し、顧客反応もポジティブ。ステージ遷移もスムーズ。"
}

### 例2: 低スコア (score: 35)
会話:
- user: 「どんな商品ですか？」
- assistant: 「商品Aです。」
評価:
{
  "principle_appropriateness": 20,
  "customer_reaction": 40,
  "stage_progression": 30,
  "contraindication_compliance": 50,
  "effective_principles": [],
  "failed_principles": ["社会的証明", "希少性"],
  "notes": "心理原則を全く活用していない。顧客への価値提供が不十分でステージが進んでいない。"
}

### 例3: 禁忌違反 (score: 20)
会話:
- user: 「やっぱりいらないです」
- assistant: 「絶対に後悔します！今すぐ買ってください！特別価格は今だけです！断ったら損ですよ！」
評価:
{
  "principle_appropriateness": 10,
  "customer_reaction": 5,
  "stage_progression": 15,
  "contraindication_compliance": 10,
  "effective_principles": [],
  "failed_principles": ["希少性"],
  "notes": "顧客の拒絶を無視した強引な押し売りは禁忌。顧客反応は完全にネガティブ。信頼を破壊する行為。"
}
`;

function buildJudgePrompt(input: JudgeInput): string {
  // 会話履歴は各メッセージを200文字でスライス
  const truncatedHistory = input.history.map(
    (msg) => `${msg.role}: ${msg.content.slice(0, 200)}`,
  );

  const historyText = truncatedHistory.join('\n');
  const principlesText =
    input.usedPrinciples.length > 0
      ? input.usedPrinciples.join(', ')
      : '（なし）';
  const stagesText =
    input.salesStages.length > 0 ? input.salesStages.join(' → ') : '（なし）';

  return `あなたはコマース会話品質の厳格な評価者です。
厳格に採点してください。曖昧な効果は否定してください。

${FEW_SHOT_EXAMPLES}

## 評価対象会話

使用された心理原則: ${principlesText}
セールスステージ遷移: ${stagesText}

会話履歴:
${historyText}

## 評価指示

以下の4軸を0-100で評価してください:
1. principle_appropriateness: 心理原則の適切さ（使用タイミング・文脈の適切さ）
2. customer_reaction: 顧客反応（ポジティブな反応、関心度、信頼構築）
3. stage_progression: ステージ進行（clarify→propose→recommend→closeの流れ）
4. contraindication_compliance: 禁忌遵守（強引な押し売りなし、顧客否定反応への配慮）

effective_principles: 効果的に使用された原則のリスト
failed_principles: 使用されなかった・逆効果だった原則のリスト
notes: 評価の根拠（100文字以内）

厳格に採点し、以下のJSON形式のみで回答してください:
{
  "principle_appropriateness": <0-100>,
  "customer_reaction": <0-100>,
  "stage_progression": <0-100>,
  "contraindication_compliance": <0-100>,
  "effective_principles": [...],
  "failed_principles": [...],
  "notes": "..."
}`;
}

interface RawJudgeResponse {
  principle_appropriateness: number;
  customer_reaction: number;
  stage_progression: number;
  contraindication_compliance: number;
  effective_principles: string[];
  failed_principles: string[];
  notes: string;
}

function parseJudgeResponse(raw: string): RawJudgeResponse {
  // JSON部分を抽出
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in judge response');
  }
  const parsed = JSON.parse(jsonMatch[0]) as RawJudgeResponse;

  // 必須フィールドの検証
  const axes = [
    'principle_appropriateness',
    'customer_reaction',
    'stage_progression',
    'contraindication_compliance',
  ] as const;
  for (const axis of axes) {
    if (typeof parsed[axis] !== 'number') {
      throw new Error(`Missing or invalid axis: ${axis}`);
    }
    // 0-100にクランプ
    parsed[axis] = Math.max(0, Math.min(100, Math.round(parsed[axis])));
  }

  if (!Array.isArray(parsed.effective_principles)) {
    parsed.effective_principles = [];
  }
  if (!Array.isArray(parsed.failed_principles)) {
    parsed.failed_principles = [];
  }
  if (typeof parsed.notes !== 'string') {
    parsed.notes = '';
  }

  return parsed;
}

export async function evaluateConversation(input: JudgeInput): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(input);

  let parsed: RawJudgeResponse | null = null;
  let lastError: unknown = null;

  // 最大2回リトライ
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callGroqWith429Retry(
        {
          model: JUDGE_MODEL,
          messages: [
            {
              role: 'system',
              content:
                '厳格なコマース会話品質評価者です。指定されたJSON形式のみで回答します。',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          maxTokens: 512,
          tag: 'judge',
        },
        { logger },
      );

      parsed = parseJudgeResponse(raw);
      break;
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        logger.warn({ err, attempt }, 'judge.parse.retry');
      }
    }
  }

  if (!parsed) {
    logger.error({ err: lastError, sessionId: input.sessionId }, 'judge.evaluation.parse.failed');
    // デフォルト値を返す（エラーをthrowしない）
    return {
      score: 0,
      evaluationAxes: {
        principle_appropriateness: 0,
        customer_reaction: 0,
        stage_progression: 0,
        contraindication_compliance: 0,
      },
      effectivePrinciples: [],
      failedPrinciples: [],
      notes: 'Judge evaluation failed',
      modelUsed: JUDGE_MODEL,
    };
  }

  const axes = {
    principle_appropriateness: parsed.principle_appropriateness,
    customer_reaction: parsed.customer_reaction,
    stage_progression: parsed.stage_progression,
    contraindication_compliance: parsed.contraindication_compliance,
  };

  const score = Math.round(
    axes.principle_appropriateness * 0.3 +
    axes.customer_reaction * 0.3 +
    axes.stage_progression * 0.2 +
    axes.contraindication_compliance * 0.2,
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    evaluationAxes: axes,
    effectivePrinciples: parsed.effective_principles,
    failedPrinciples: parsed.failed_principles,
    notes: parsed.notes,
    modelUsed: JUDGE_MODEL,
  };
}
