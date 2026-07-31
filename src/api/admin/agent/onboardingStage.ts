// src/api/admin/agent/onboardingStage.ts
//
// 新規テナントの初回ログインオンボーディング、4段階の状態モデル（単一の情報源）。
// docs/ONBOARDING_FIRST_LOGIN.md §3.1③ の決定に基づく。
//
// このモジュールは「導出」だけを行う純関数の集まりで、DBアクセスは持たない。
// 呼び出し側（GET /v1/admin/my-tenant、agentRoutes.ts の計測、copilot-preview の
// 「次の一手」）が既存データを取得し、この関数に渡す。
//
// 4段階のうち3段階は既存データから導出でき、新規に持つ状態は
// onboarding_widget_seen_at（migration_onboarding.sql）だけ。
//   - industry_answered:   tenants.onboarding_industry（既存列）
//   - knowledge_published: 【決定1】テナント全体の faq_docs.is_published=true 件数
//                          （オンボーディング由来の知識に限定しない）
//   - widget_installed:    【決定2】tenants.onboarding_widget_seen_at の有無
//                          （記録元は /api/widget/features。P4で実装）
//   - first_conversation:  chat_sessions に metadata->>'source'='user' が1件以上

export type OnboardingStage =
  | 'industry_answered'
  | 'knowledge_published'
  | 'widget_installed'
  | 'first_conversation';

export interface OnboardingStageFacts {
  onboardingIndustry: string | null;
  onboardingWidgetSeenAt: Date | string | null;
  hasPublishedFaq: boolean;
  hasRealConversation: boolean;
}

export interface OnboardingStageStatus {
  industryAnswered: boolean;
  knowledgePublished: boolean;
  widgetInstalled: boolean;
  firstConversation: boolean;
}

export function deriveOnboardingStage(facts: OnboardingStageFacts): OnboardingStageStatus {
  return {
    industryAnswered: facts.onboardingIndustry !== null,
    knowledgePublished: facts.hasPublishedFaq,
    widgetInstalled: facts.onboardingWidgetSeenAt !== null,
    firstConversation: facts.hasRealConversation,
  };
}

// 段階の順序（次の一手の判定に使う固定順）。
const STAGE_ORDER: OnboardingStage[] = [
  'industry_answered',
  'knowledge_published',
  'widget_installed',
  'first_conversation',
];

/**
 * 4段階のうち、まだ到達していない最初の段階を返す。全段階到達済みなら null。
 * P5「中断・再開時に次の一手を提示する」の判定に使う。
 */
export function nextIncompleteStage(status: OnboardingStageStatus): OnboardingStage | null {
  const flags: Record<OnboardingStage, boolean> = {
    industry_answered: status.industryAnswered,
    knowledge_published: status.knowledgePublished,
    widget_installed: status.widgetInstalled,
    first_conversation: status.firstConversation,
  };
  for (const stage of STAGE_ORDER) {
    if (!flags[stage]) return stage;
  }
  return null;
}

/** 4段階すべてに到達しているか。 */
export function isOnboardingComplete(status: OnboardingStageStatus): boolean {
  return nextIncompleteStage(status) === null;
}
