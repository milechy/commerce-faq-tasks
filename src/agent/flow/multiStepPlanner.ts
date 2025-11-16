// src/agent/flow/multiStepPlanner.ts

import type {
  ClarifyStep,
  DialogMessage,
  MultiStepQueryPlan,
  PlanStep,
  SearchStep,
} from '../dialog/types';
import type { QueryPlan } from '../types';
import { planQueryWithLlmAsync } from './llmPlannerRuntime';
import { planQuery } from './queryPlanner';

export interface MultiStepPlannerOptions {
  topK?: number;
  language?: 'ja' | 'en' | 'auto';
  useLlmPlanner?: boolean;
}

/**
 * history から「これはフォローアップっぽいか」をざっくり判定する。
 *
 * MVP では:
 * - 直前の発話が assistant
 * - かつ、過去に user のメッセージが存在する
 *
 * 程度のシンプルなルールにしておく。
 */
function isLikelyFollowup(history?: DialogMessage[]): boolean {
  if (!history || history.length === 0) return false;

  const last = history[history.length - 1];
  if (last.role !== 'assistant') return false;

  const hasUser = history.some((m) => m.role === 'user');
  return hasUser;
}

/**
 * 非常にシンプルな Clarifying Question ヒューリスティック。
 *
 * Phase3 v1 では:
 * - 曖昧な短い問い合わせ
 * - よくある汎用キーワード（配送 / 送料 / 返品 など）
 *
 * に対して、1〜2 個の Clarifying Question を生成する。
 * まだ Clarify フロー自体は強制せず、メタ情報として利用する前提。
 */
function buildClarifyingQuestions(originalQuery: string): string[] {
  const q = originalQuery.trim();
  if (!q) return [];

  // かなりざっくりした長さ判定（短すぎるものは曖昧とみなす）
  const isVeryShort = q.length <= 6;

  const genericJaKeywords = ['配送', '送料', '返品', 'キャンセル', '支払い', '問い合わせ'];
  const hasGenericKeyword = genericJaKeywords.some((kw) => q.includes(kw));

  // ある程度具体的そうな手がかり（数値や地域名など）があれば Clarify は抑える
  const hasSpecificHint = /[0-9０-９]|北海道|本州|沖縄|日時|時間帯|セール|クーポン|キャンペーン|クレジット|銀行振込|コンビニ/.test(
    q,
  );

  if (!hasGenericKeyword) {
    return [];
  }

  if (!isVeryShort && hasSpecificHint) {
    // それなりに具体的 + ヒントがある → 追加質問は今のところ不要とみなす
    return [];
  }

  const questions: string[] = [];

  if (q.includes('配送') || q.includes('送料')) {
    questions.push('どの商品・どの地域への配送／送料について知りたいですか？');
  }

  if (q.includes('返品') || q.includes('キャンセル')) {
    questions.push('通常商品・セール品・予約商品など、どの注文の返品／キャンセルについて知りたいですか？');
  }

  if (q.includes('支払い') || q.toLowerCase().includes('payment')) {
    questions.push('どのお支払い方法（クレジットカード・コンビニ払いなど）について知りたいですか？');
  }

  // 質問が多すぎても扱いづらいので 2 つまでに絞る
  return questions.slice(0, 2);
}

function toMultiStepFromSingle(
  originalQuery: string,
  single: QueryPlan,
  clarifyingQuestions: string[],
  isFollowup: boolean,
  history?: DialogMessage[],
): MultiStepQueryPlan {
  const topK = single.topK ?? 10;
  const needsClarification = clarifyingQuestions.length > 0;

  const steps: PlanStep[] = [];

  if (needsClarification) {
    const clarifyStep: ClarifyStep = {
      id: 'step_clarify_1',
      type: 'clarify',
      description: '曖昧な問い合わせに対する追加確認ステップ',
      questions: clarifyingQuestions,
    };
    steps.push(clarifyStep);
  }

  const searchStep: SearchStep = {
    id: 'step_search_1',
    type: 'search',
    description: isFollowup
      ? '前ターンの回答を踏まえたフォローアップ検索ステップ'
      : 'ユーザー入力に対するメイン検索ステップ',
    query: (single as any).searchQuery ?? originalQuery,
    topK,
    // QueryPlan.filters は Record<string, unknown> | null | undefined を想定
    filters: single.filters ?? undefined,
  };

  steps.push(searchStep);

  return {
    steps,
    needsClarification,
    clarifyingQuestions: clarifyingQuestions.length ? clarifyingQuestions : undefined,
    followupQueries: isFollowup ? [originalQuery] : [],
    confidence: 'medium',
    // language は Phase3 v1 ではまだ未使用なので付けない（optional のまま）
    raw: {
      singleQueryPlan: single,
      isFollowup,
      historySize: history?.length ?? 0,
    },
  };
}

/**
 * Multi-Step Planner のエントリポイント。
 *
 * Phase3 v1:
 *  - 既存の planQuery / planQueryWithLlmAsync を利用して単一 QueryPlan を生成
 *  - それを MultiStepQueryPlan にラップして返す
 *
 * ClarifyStep / followupQueries はメタ情報として付与するだけで、
 * 実際の /agent.dialog の挙動にはまだ影響させない。
 */
export async function planMultiStepQuery(
  input: string,
  options: MultiStepPlannerOptions = {},
  history?: DialogMessage[],
): Promise<MultiStepQueryPlan> {
  const { useLlmPlanner } = options;

  let singlePlan: QueryPlan;

  if (useLlmPlanner) {
    singlePlan = await planQueryWithLlmAsync(input, {
      topK: options.topK,
      // language は PlanOptions にまだないので渡さない
    });
  } else {
    singlePlan = planQuery(input, {
      topK: options.topK,
      // language は PlanOptions にまだないので渡さない
    });
  }

  const clarifyingQuestions = buildClarifyingQuestions(input);
  const isFollowup = isLikelyFollowup(history);

  return toMultiStepFromSingle(
    input,
    singlePlan,
    clarifyingQuestions,
    isFollowup,
    history,
  );
}