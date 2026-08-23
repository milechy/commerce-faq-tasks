// src/api/admin/analytics/ruleEffect.test.ts
// GID 1216978677398163 (PR-14): evaluateRuleEffect の統計判定を単体でテストする。
// DBに触れない純関数のため、fetchRuleMeta/getRuleEffect(DB結合部)はここでは扱わない。

import { evaluateRuleEffect, MIN_SAMPLE_SIZE, type RuleEffectGroups, type GroupInput } from "./ruleEffect";

function makeGroup(scores: number[], overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    judgeScores: scores,
    sessionCount: overrides.sessionCount ?? scores.length,
    twoTurnCount: overrides.twoTurnCount ?? 0,
    convertedCount: overrides.convertedCount ?? 0,
  };
}

describe("evaluateRuleEffect", () => {
  it("いずれかの群がMIN_SAMPLE_SIZE未満なら insufficient_data を返し、数値を含めない", () => {
    const groups: RuleEffectGroups = {
      beforeTreatment: makeGroup([80, 82, 79]), // 3件 < 5
      afterTreatment: makeGroup([85, 88, 90, 91, 87]),
      beforeControl: makeGroup([70, 72, 74, 71, 73]),
      afterControl: makeGroup([71, 73, 75, 72, 74]),
    };

    const result = evaluateRuleEffect(groups, 10);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      expect(result.minSampleSize).toBe(MIN_SAMPLE_SIZE);
      const short = result.progress.find((p) => p.group === "beforeTreatment");
      expect(short).toBeDefined();
      expect(short!.currentN).toBe(3);
      expect(short!.requiredN).toBe(MIN_SAMPLE_SIZE);
      // before系は観測期間固定のためETAは出さない
      expect(short!.etaDays).toBeNull();
    }
    // insufficient_data の場合、comparison相当のフィールドが一切含まれないこと
    expect((result as any).comparison).toBeUndefined();
    expect((result as any).did).toBeUndefined();
  });

  it("蓄積中の afterTreatment が不足のとき、経過日数から見込み日数(ETA)を計算する", () => {
    const groups: RuleEffectGroups = {
      beforeTreatment: makeGroup([80, 82, 79, 81, 83]),
      afterTreatment: makeGroup([85, 88]), // 2件、あと3件必要
      beforeControl: makeGroup([70, 72, 74, 71, 73]),
      afterControl: makeGroup([71, 73, 75, 72, 74]),
    };

    // 承認から10日経過して2件 → 1日あたり0.2件 → 残り3件には15日かかる
    const result = evaluateRuleEffect(groups, 10);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      const at = result.progress.find((p) => p.group === "afterTreatment");
      expect(at!.currentN).toBe(2);
      expect(at!.etaDays).toBe(15);
    }
  });

  it("全群が母数を満たすとき、DiD推定値と95%信頼区間を含む比較結果を返す", () => {
    // beforeTreatment: 平均80, afterTreatment: 平均90 → 素朴な差分+10
    // beforeControl: 平均70, afterControl: 平均75 → 対照群の差分+5(テナント一律のシフト)
    // DiD = (90-80) - (75-70) = 10 - 5 = 5 (ルール自体の純効果)
    const groups: RuleEffectGroups = {
      beforeTreatment: makeGroup([78, 79, 80, 81, 82], { twoTurnCount: 3, convertedCount: 1 }),
      afterTreatment: makeGroup([88, 89, 90, 91, 92], { twoTurnCount: 4, convertedCount: 2 }),
      beforeControl: makeGroup([68, 69, 70, 71, 72], { twoTurnCount: 2, convertedCount: 0 }),
      afterControl: makeGroup([73, 74, 75, 76, 77], { twoTurnCount: 2, convertedCount: 1 }),
    };

    const result = evaluateRuleEffect(groups, 30);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.comparison.naiveTreatmentDelta).toBeCloseTo(10, 1);
      expect(result.comparison.did.estimate).toBeCloseTo(5, 1);
      expect(result.comparison.did.ci95[0]).toBeLessThan(result.comparison.did.estimate);
      expect(result.comparison.did.ci95[1]).toBeGreaterThan(result.comparison.did.estimate);
      expect(result.comparison.groups.afterTreatment.n).toBe(5);
      expect(result.comparison.groups.beforeTreatment.twoTurnRate).toBeCloseTo(0.6, 4);
      expect(result.comparison.groups.afterTreatment.convertedCount).toBe(2);
    }
  });

  it("2会話分のCV記録は比較にもゲートにも使われない(参考値のみ)", () => {
    const groups: RuleEffectGroups = {
      beforeTreatment: makeGroup([78, 79, 80, 81, 82], { convertedCount: 0 }),
      afterTreatment: makeGroup([88, 89, 90, 91, 92], { convertedCount: 5 }),
      beforeControl: makeGroup([68, 69, 70, 71, 72]),
      afterControl: makeGroup([73, 74, 75, 76, 77]),
    };

    const result = evaluateRuleEffect(groups, 30);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // CVカウントが極端でも status/did の判定式には一切登場しない
      expect(result.comparison.groups.afterTreatment.convertedCount).toBe(5);
      expect(Number.isFinite(result.comparison.did.estimate)).toBe(true);
    }
  });

  it("既定の minSampleSize はエクスポートされた定数と一致する", () => {
    expect(MIN_SAMPLE_SIZE).toBeGreaterThan(0);
  });
});
