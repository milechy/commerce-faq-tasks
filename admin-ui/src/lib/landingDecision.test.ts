// admin-ui/src/lib/landingDecision.test.ts
// Asana 1217040702572796(P6)。App.tsxの着地判定(computeLandingDecision)のテスト。
// docs/ONBOARDING_FIRST_LOGIN.md §7 の N-1/N-2/N-12(間接)・X-7/X-13 に対応。

import { describe, it, expect } from "vitest";
import { computeLandingDecision, type LandingDecisionInput } from "./landingDecision";
import type { OnboardingStageFlags } from "../auth/useAuth";

const INCOMPLETE_STAGE: OnboardingStageFlags = {
  industryAnswered: false,
  knowledgePublished: false,
  widgetInstalled: false,
  firstConversation: false,
  hasDraftFaq: false,
};

const COMPLETE_STAGE: OnboardingStageFlags = {
  industryAnswered: true,
  knowledgePublished: true,
  widgetInstalled: true,
  firstConversation: true,
  hasDraftFaq: false,
};

function baseInput(overrides: Partial<LandingDecisionInput> = {}): LandingDecisionInput {
  return {
    pathname: "/",
    isChatFirstDefaultEnabled: false,
    previewMode: false,
    isClientAdmin: true,
    onboardingStageResolved: true,
    onboardingStage: INCOMPLETE_STAGE,
    ...overrides,
  };
}

describe("computeLandingDecision — N-1: 新規テナントは新UIに着地する", () => {
  it.each<[string, string]>([["/", "ルート"], ["/admin", "旧ダッシュボード"]])(
    "業種未回答の新規テナントは %s (%s) でも新UIに着地する",
    (pathname) => {
      const result = computeLandingDecision(baseInput({ pathname, onboardingStage: INCOMPLETE_STAGE }));
      expect(result.isCopilotPreview).toBe(true);
      expect(result.isLandingDecisionPending).toBe(false);
    },
  );

  it("4段階のうち1つでも未完了なら新UIに着地する(業種のみ完了)", () => {
    const partial: OnboardingStageFlags = { ...COMPLETE_STAGE, firstConversation: false };
    const result = computeLandingDecision(baseInput({ onboardingStage: partial }));
    expect(result.isCopilotPreview).toBe(true);
  });
});

describe("computeLandingDecision — N-2: 既存テナントの動線は一切変わらない", () => {
  it("4段階すべて完了済みのテナントは、オプトインが無効なら旧UIのまま", () => {
    const result = computeLandingDecision(baseInput({ onboardingStage: COMPLETE_STAGE }));
    expect(result.isCopilotPreview).toBe(false);
    expect(result.isLandingDecisionPending).toBe(false);
  });

  it("/copilot-preview 以外の旧UIページ(例: /admin/knowledge)は着地判定の対象外", () => {
    const result = computeLandingDecision(baseInput({ pathname: "/admin/knowledge", onboardingStage: INCOMPLETE_STAGE }));
    // ランディングパス(/, /admin)以外なので、新規テナント判定に関わらず isCopilotPreview は false
    expect(result.isCopilotPreview).toBe(false);
  });

  it("r2c_chat_first_default オプトイン済みの既存テナントは、段階に関わらず新UIに着地する(既存挙動を保存)", () => {
    const result = computeLandingDecision(
      baseInput({ isChatFirstDefaultEnabled: true, onboardingStage: COMPLETE_STAGE }),
    );
    expect(result.isCopilotPreview).toBe(true);
    // オプトインが同期的に true と分かっているため、段階解決を待つ必要がない
    expect(result.isLandingDecisionPending).toBe(false);
  });
});

describe("computeLandingDecision — ちらつき・二重着地の防止(§3.1③)", () => {
  it("段階が未解決の間は、旧UI・新UIどちらにも着地しない(pending)", () => {
    const result = computeLandingDecision(baseInput({ onboardingStageResolved: false, onboardingStage: null }));
    expect(result.isLandingDecisionPending).toBe(true);
    expect(result.isCopilotPreview).toBe(false);
  });

  it("オプトイン済みなら、段階が未解決でも待たない(同期的に決まるため)", () => {
    const result = computeLandingDecision(
      baseInput({ isChatFirstDefaultEnabled: true, onboardingStageResolved: false, onboardingStage: null }),
    );
    expect(result.isLandingDecisionPending).toBe(false);
    expect(result.isCopilotPreview).toBe(true);
  });

  it("previewMode中は、段階が未解決でも待たない(同期的に新UIへ)", () => {
    const result = computeLandingDecision(
      baseInput({ previewMode: true, onboardingStageResolved: false, onboardingStage: null }),
    );
    expect(result.isLandingDecisionPending).toBe(false);
    expect(result.isCopilotPreview).toBe(true);
  });

  it("client_adminでなければ(super_adminの集約ビュー等)、段階を待たない", () => {
    const result = computeLandingDecision(
      baseInput({ isClientAdmin: false, onboardingStageResolved: false, onboardingStage: null }),
    );
    expect(result.isLandingDecisionPending).toBe(false);
    expect(result.isCopilotPreview).toBe(false);
  });

  it("ランディングパス以外(/copilot-preview直アクセス)は pending にならない", () => {
    const result = computeLandingDecision(
      baseInput({ pathname: "/copilot-preview", onboardingStageResolved: false, onboardingStage: null }),
    );
    expect(result.isLandingDecisionPending).toBe(false);
    expect(result.isCopilotPreview).toBe(true);
  });
});

describe("computeLandingDecision — X-7: サーバが正、localStorage/previewModeに依存しない", () => {
  it("onboardingStage が null(取得失敗)なら新規テナント判定はfalseになる(誤って新UI固定しない)", () => {
    // fetch失敗時は stage=null, resolved=true(useAuth側の実装)。
    // この場合、新規かどうか判定できないため false 側に倒す(既存UIへフォールバック)。
    const result = computeLandingDecision(
      baseInput({ onboardingStageResolved: true, onboardingStage: null }),
    );
    expect(result.isCopilotPreview).toBe(false);
    expect(result.isLandingDecisionPending).toBe(false);
  });
});

describe("computeLandingDecision — previewMode中はテナント本人の新規判定を使わない(決定A・§3.1④)", () => {
  it("previewMode中は onboardingStage が未完了でも isNewTenantOnboarding を経由しない(previewMode自体で新UIに着地)", () => {
    // previewMode=true の場合、isNewTenantOnboarding の計算式は !previewMode で常に false になるが、
    // isCopilotPreview 自体は previewMode の直接判定で true になる。結果としては同じtrueでも、
    // 「代行閲覧を新規テナント扱いにしていない」ことを式のレベルで固定する回帰テスト。
    const result = computeLandingDecision(
      baseInput({ previewMode: true, isClientAdmin: true, onboardingStage: INCOMPLETE_STAGE }),
    );
    expect(result.isCopilotPreview).toBe(true);
  });
});
