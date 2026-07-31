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

// P6(#627, 2026-07-31T13:55:06+09:00)がmainにマージされる前に作られたテナントは、
// 4段階モデル自体が存在しない時期に作られている。onboarding_industry は導入前の
// 全テナントで一律 NULL のため、カットオフ無しだと「新規テナント」と誤判定され
// 全既存テナントが新UIへ強制着地する(オンボ 是正A-1)。この列だけで新規/既存を
// 見分けられないので、テナントの作成日時で線を引く。
const ONBOARDING_MODEL_CUTOFF = '2026-07-31T04:55:06Z';

export interface OnboardingStageFacts {
  tenantCreatedAt: Date | string;
  onboardingIndustry: string | null;
  onboardingWidgetSeenAt: Date | string | null;
  hasPublishedFaq: boolean;
  hasRealConversation: boolean;
  // オンボ 是正A-2: 段階(4つ)ではなくヒント。stage2「下書きを見る」と「たたき台を
  // 作る」を切り分けるためだけに使い、isOnboardingComplete/nextIncompleteStage の
  // 判定には混ぜない。
  hasDraftFaq: boolean;
}

export interface OnboardingStageStatus {
  industryAnswered: boolean;
  knowledgePublished: boolean;
  widgetInstalled: boolean;
  firstConversation: boolean;
  hasDraftFaq: boolean;
}

/** カットオフより前に作られたテナントは4段階モデルの対象外として null を返す。 */
export function deriveOnboardingStage(facts: OnboardingStageFacts): OnboardingStageStatus | null {
  if (new Date(facts.tenantCreatedAt) < new Date(ONBOARDING_MODEL_CUTOFF)) {
    return null;
  }
  return {
    industryAnswered: facts.onboardingIndustry !== null,
    knowledgePublished: facts.hasPublishedFaq,
    widgetInstalled: facts.onboardingWidgetSeenAt !== null,
    firstConversation: facts.hasRealConversation,
    hasDraftFaq: facts.hasDraftFaq,
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
