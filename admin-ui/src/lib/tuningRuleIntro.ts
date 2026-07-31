// admin-ui/src/lib/tuningRuleIntro.ts
// P6-1: 新規テナントが4段階のオンボーディングを完了した直後、指示ルールの存在に
// 気づけるよう一度だけ紹介する。backend の onboardingStage.ts(単一の情報源)は
// 変更せず、admin-ui 側のブラウザ単位フラグだけで「1回きり」を保証する軽量な接続。
// テナント単位で分ける(super_adminが複数テナントをプレビューしても混ざらないように)。

const KEY_PREFIX = "r2c_tuning_rule_intro_shown_";

export function hasShownTuningRuleIntro(tenantId: string): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY_PREFIX + tenantId) === "true";
  } catch {
    return false;
  }
}

export function markTuningRuleIntroShown(tenantId: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY_PREFIX + tenantId, "true");
  } catch {
    // localStorage無効環境(プライベートブラウズ等)では静かに無視(次回また出るだけで実害は無い)
  }
}
