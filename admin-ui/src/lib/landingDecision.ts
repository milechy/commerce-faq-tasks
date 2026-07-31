// admin-ui/src/lib/landingDecision.ts
//
// Asana 1217040702572796(P6)のロジックを純関数として切り出したもの。
// App.tsx の AppInner は ~30個のページコンポーネントを import しており、
// 直接テストしようとすると全てをモックする重いテストになる(既存にも
// App.test.tsx は無い)。着地判定という「壊れると新規テナントがずっと
// 旧UIに落ちる/既存テナントが誤って新UIに飛ばされる」重要なロジックだけを
// テスト可能な形に切り出す(CLAUDE.md「テスト可能な純関数として切り出す場合」
// に該当する新規ファイル。src/lib/onboardingWidgetSeen.ts と同じ考え方)。
//
// このファイルの出力を変えたら、必ず App.tsx 側の呼び出し箇所も追随させること。

import type { OnboardingStageFlags } from "../auth/useAuth";

export interface LandingDecisionInput {
  pathname: string;
  isChatFirstDefaultEnabled: boolean;
  previewMode: boolean;
  isClientAdmin: boolean;
  onboardingStageResolved: boolean;
  onboardingStage: OnboardingStageFlags | null;
}

export interface LandingDecision {
  /** true なら /copilot-preview(新UI)を描画する */
  isCopilotPreview: boolean;
  /**
   * true の間はランディングパスで何も描画しない(旧UI・新UIどちらも出さない)。
   * onboardingStageResolved が確定するまでの、ちらつき・二重着地の防止用。
   */
  isLandingDecisionPending: boolean;
}

function isOnboardingComplete(stage: OnboardingStageFlags): boolean {
  return (
    stage.industryAnswered &&
    stage.knowledgePublished &&
    stage.widgetInstalled &&
    stage.firstConversation
  );
}

export function computeLandingDecision(input: LandingDecisionInput): LandingDecision {
  const isLandingPath = input.pathname === "/" || input.pathname === "/admin";

  // 「新規」の範囲は onboarding_completed_at 単体ではなく4段階全完了までとする
  // (docs/ONBOARDING_FIRST_LOGIN.md §3.1③)。previewMode(super_adminの代行閲覧)は
  // 決定Aの対象外 — テナント本人の初回ログインの話であり、代行閲覧を新規テナント
  // 扱いにしてはならない。
  const isNewTenantOnboarding =
    !input.previewMode &&
    input.isClientAdmin &&
    input.onboardingStageResolved &&
    input.onboardingStage !== null &&
    !isOnboardingComplete(input.onboardingStage);

  const isCopilotPreview =
    input.pathname === "/copilot-preview" ||
    (isLandingPath && (input.isChatFirstDefaultEnabled || input.previewMode || isNewTenantOnboarding));

  // ブラウザのオプトイン(同期的に判定可能)が無効・previewModeでもない場合のみ、
  // 非同期の段階取得が確定するまで待つ。それ以外は着地先が同期的に決まるため待たない。
  const isLandingDecisionPending =
    isLandingPath &&
    !input.previewMode &&
    input.isClientAdmin &&
    !input.isChatFirstDefaultEnabled &&
    !input.onboardingStageResolved;

  return { isCopilotPreview, isLandingDecisionPending };
}
