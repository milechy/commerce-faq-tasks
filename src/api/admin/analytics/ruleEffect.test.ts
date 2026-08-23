// src/api/admin/analytics/ruleEffect.test.ts
// GID 1216978677398163 (PR-14): ルール効果測定。
//
// 方針: 「通るテスト」ではなく壊れやすい箇所を突く。具体的には
//   1. 母数ゲートの境界(ちょうど/1件不足/下限クランプ)
//   2. DiD が control 群の変動を実際に相殺しているか(符号が反転する条件)
//   3. getRuleEffect の SQL 形状(1セッション=1行の保証・テナント絞り)
//   4. before/after 境界と treatment/control 振り分け
//   5. 会話本文が戻り値に漏れないこと(Anti-Slop)

import {
  evaluateRuleEffect,
  getRuleEffect,
  MIN_SAMPLE_SIZE,
  CANDIDATE_SESSION_LIMIT as CANDIDATE_SESSION_LIMIT_FOR_TEST,
  type RuleEffectGroups,
  type GroupInput,
} from "./ruleEffect";

function makeGroup(scores: number[], overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    judgeScores: scores,
    sessionCount: overrides.sessionCount ?? scores.length,
    twoTurnCount: overrides.twoTurnCount ?? 0,
    convertedCount: overrides.convertedCount ?? 0,
  };
}

/** 全群がちょうど n 件ずつ揃った groups を作る。 */
function groupsOfSize(n: number): RuleEffectGroups {
  const scores = Array.from({ length: n }, (_, i) => 70 + i);
  return {
    beforeTreatment: makeGroup([...scores]),
    afterTreatment: makeGroup([...scores]),
    beforeControl: makeGroup([...scores]),
    afterControl: makeGroup([...scores]),
  };
}

describe("evaluateRuleEffect — 母数ゲートの境界", () => {
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
      expect(short!.currentN).toBe(3);
      expect(short!.requiredN).toBe(MIN_SAMPLE_SIZE);
      // before系は観測期間固定のためETAは出さない
      expect(short!.etaDays).toBeNull();
    }
    expect((result as any).comparison).toBeUndefined();
  });

  it("境界: 全群がちょうどMIN_SAMPLE_SIZE件なら ok に切り替わる", () => {
    const result = evaluateRuleEffect(groupsOfSize(MIN_SAMPLE_SIZE), 30);
    expect(result.status).toBe("ok");
  });

  it("境界: 1群だけ1件足りない(MIN_SAMPLE_SIZE-1)と insufficient_data のまま", () => {
    const groups = groupsOfSize(MIN_SAMPLE_SIZE);
    groups.afterControl = makeGroup(groups.afterControl.judgeScores.slice(0, MIN_SAMPLE_SIZE - 1));

    const result = evaluateRuleEffect(groups, 30);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      // 不足している群だけが progress に載る(充足済みの群を混ぜない)
      expect(result.progress.map((p) => p.group)).toEqual(["afterControl"]);
    }
  });

  it("不足群が複数あるときは全て progress に列挙する(1件だけ報告して残りを隠さない)", () => {
    const groups = groupsOfSize(MIN_SAMPLE_SIZE);
    groups.beforeTreatment = makeGroup([80]);
    groups.afterControl = makeGroup([70, 71]);

    const result = evaluateRuleEffect(groups, 30);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      expect(result.progress.map((p) => p.group).sort()).toEqual(
        ["afterControl", "beforeTreatment"].sort(),
      );
    }
  });

  it("回帰: minSampleSize=1 を渡してもNaNを出力しない(下限2にクランプされる)", () => {
    // n=1 では標準誤差が定義できず se=NaN → ci95=[NaN,NaN] が出力に漏れる。
    // JSON化すると null になり、UIには「信頼区間の無い点推定」として出てしまうため、
    // 母数不足時に数値を出さないという本モジュールの前提(CLAUDE.md 禁止34)が破れる。
    const oneEach: RuleEffectGroups = {
      beforeTreatment: makeGroup([80]),
      afterTreatment: makeGroup([90]),
      beforeControl: makeGroup([70]),
      afterControl: makeGroup([75]),
    };

    const result = evaluateRuleEffect(oneEach, 10, 1);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      // 呼び出し側が1を要求しても、到達条件としては2を提示する
      // (到達不能な目標や、到達しても意味の無い目標をUIに出さない)
      expect(result.minSampleSize).toBe(2);
      expect(result.progress.every((p) => p.requiredN === 2)).toBe(true);
    }
    // 点推定・信頼区間を一切出さない(NaN が JSON 化で null になって
    // 「区間の無い数値」としてUIに出る経路そのものを塞ぐ)
    expect((result as any).comparison).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("ci95");
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("回帰: minSampleSize=1 でも各群が2件以上あれば ok になり、ci95にNaNが混入しない", () => {
    // クランプ後の下限(2)を満たすので ok に進む。ここで se が定義できることを確かめる
    // (クランプが「常に insufficient にする」という乱暴な実装になっていないことの確認)。
    const twoEach: RuleEffectGroups = {
      beforeTreatment: makeGroup([80, 84]),
      afterTreatment: makeGroup([90, 94]),
      beforeControl: makeGroup([70, 74]),
      afterControl: makeGroup([75, 79]),
    };

    const result = evaluateRuleEffect(twoEach, 10, 1);

    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("NaN");
    if (result.status === "ok") {
      expect(result.comparison.did.ci95.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("回帰: minSampleSize=2 かつ各群2件なら ok だが ci95 は有限値(NaNでない)", () => {
    const twoEach: RuleEffectGroups = {
      beforeTreatment: makeGroup([80, 84]),
      afterTreatment: makeGroup([90, 94]),
      beforeControl: makeGroup([70, 74]),
      afterControl: makeGroup([75, 79]),
    };

    const result = evaluateRuleEffect(twoEach, 10, 2);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const all = [
        ...result.comparison.groups.beforeTreatment.ci95,
        ...result.comparison.groups.afterTreatment.ci95,
        ...result.comparison.did.ci95,
      ];
      expect(all.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

describe("evaluateRuleEffect — ETA(見込み日数)", () => {
  it("蓄積中の afterTreatment が不足のとき、経過日数から見込み日数(ETA)を計算する", () => {
    const groups = groupsOfSize(MIN_SAMPLE_SIZE);
    groups.afterTreatment = makeGroup([85, 88]); // 2件、あと3件必要

    // 承認から10日で2件 → 1日0.2件 → 残り3件に15日
    const result = evaluateRuleEffect(groups, 10);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      const at = result.progress.find((p) => p.group === "afterTreatment");
      expect(at!.etaDays).toBe(15);
    }
  });

  it("after群が0件ならETAはnull(0除算で Infinity を出さない)", () => {
    const groups = groupsOfSize(MIN_SAMPLE_SIZE);
    groups.afterTreatment = makeGroup([]);

    const result = evaluateRuleEffect(groups, 10);

    if (result.status === "insufficient_data") {
      const at = result.progress.find((p) => p.group === "afterTreatment");
      expect(at!.currentN).toBe(0);
      expect(at!.etaDays).toBeNull(); // Infinity でも 0 でもない
    }
  });

  it("承認直後(経過0日)はETAを出さない(0除算回避)", () => {
    const groups = groupsOfSize(MIN_SAMPLE_SIZE);
    groups.afterTreatment = makeGroup([85, 88]);

    const result = evaluateRuleEffect(groups, 0);

    if (result.status === "insufficient_data") {
      const at = result.progress.find((p) => p.group === "afterTreatment");
      expect(at!.etaDays).toBeNull();
    }
  });
});

describe("evaluateRuleEffect — DiD がバイアスを相殺しているか", () => {
  it("全群が母数を満たすとき、DiD推定値と95%信頼区間を含む比較結果を返す", () => {
    // beforeTreatment 平均80 / afterTreatment 平均90 → 素朴な差分 +10
    // beforeControl 平均70 / afterControl 平均75 → 対照群 +5 (テナント一律のシフト)
    // DiD = 10 - 5 = 5 (ルール自体の純効果)
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
      expect(result.comparison.groups.beforeTreatment.twoTurnRate).toBeCloseTo(0.6, 4);
    }
  });

  it("核心: Judge採点基準がテナント一律に上振れしただけならDiDは約0になる(自己成就バイアスの相殺)", () => {
    // ルール承認で Judge のプロンプトが変わり、マッチ有無に関わらず全会話が
    // +10 された状況。素朴な before/after は +10 に見えるが、真の効果は 0。
    const base = [70, 72, 74, 76, 78];
    const shifted = base.map((v) => v + 10);
    const groups: RuleEffectGroups = {
      beforeTreatment: makeGroup([...base]),
      afterTreatment: makeGroup([...shifted]),
      beforeControl: makeGroup([...base]),
      afterControl: makeGroup([...shifted]),
    };

    const result = evaluateRuleEffect(groups, 30);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.comparison.naiveTreatmentDelta).toBeCloseTo(10, 5); // 素朴だと効果ありに見える
      expect(result.comparison.did.estimate).toBeCloseTo(0, 5); // DiDでは効果0
    }
  });

  it("対照群の伸びが処置群を上回るとDiDは負になる(悪化を悪化として出す)", () => {
    const groups: RuleEffectGroups = {
      beforeTreatment: makeGroup([70, 71, 72, 73, 74]), // 平均72
      afterTreatment: makeGroup([72, 73, 74, 75, 76]), // 平均74 → +2
      beforeControl: makeGroup([70, 71, 72, 73, 74]), // 平均72
      afterControl: makeGroup([78, 79, 80, 81, 82]), // 平均80 → +8
    };

    const result = evaluateRuleEffect(groups, 30);

    if (result.status === "ok") {
      expect(result.comparison.naiveTreatmentDelta).toBeCloseTo(2, 5); // 単体では改善に見える
      expect(result.comparison.did.estimate).toBeCloseTo(-6, 5); // 実際は対照群より劣る
    }
  });

  it("CV件数は比較にもゲートにも使われない(参考値のみ)", () => {
    const groups = groupsOfSize(MIN_SAMPLE_SIZE);
    const withCv = evaluateRuleEffect(
      { ...groups, afterTreatment: makeGroup(groups.afterTreatment.judgeScores, { convertedCount: 999 }) },
      30,
    );
    const withoutCv = evaluateRuleEffect(groups, 30);

    if (withCv.status === "ok" && withoutCv.status === "ok") {
      // CV件数が極端でも DiD 推定値は一切動かない
      expect(withCv.comparison.did.estimate).toBe(withoutCv.comparison.did.estimate);
      expect(withCv.comparison.groups.afterTreatment.convertedCount).toBe(999);
    }
  });
});

// ---------------------------------------------------------------------------
// getRuleEffect (DB結合部)
// ---------------------------------------------------------------------------

const RULE_ROW = {
  id: 42,
  tenant_id: "tenant-a",
  trigger_pattern: "返品,返金",
  created_at: "2026-06-01T00:00:00.000Z",
  approved_at: "2026-07-01T00:00:00.000Z",
};

function sessionRow(over: Partial<{
  session_uuid: string;
  first_message: string;
  first_message_at: string;
  judge_score: number | null;
  user_message_count: number;
  converted: boolean;
}> = {}) {
  return {
    session_uuid: over.session_uuid ?? "s-1",
    first_message: over.first_message ?? "返品したいのですが",
    first_message_at: over.first_message_at ?? "2026-07-10T00:00:00.000Z",
    judge_score: over.judge_score === undefined ? 80 : over.judge_score,
    user_message_count: over.user_message_count ?? 2,
    converted: over.converted ?? false,
  };
}

/**
 * 4群それぞれ指定件数のセッション行を合成する(内容は問わない、件数の境界検証専用)。
 * bt=beforeTreatment, at=afterTreatment, bc=beforeControl, ac=afterControl。
 */
function rowsForBoundary(bt: number, at: number, bc: number, ac: number) {
  const rows: object[] = [];
  const push = (n: number, matched: boolean, after: boolean, tag: string) => {
    for (let i = 0; i < n; i++) {
      rows.push(
        sessionRow({
          session_uuid: `${tag}-${i}`,
          first_message: matched ? "返品したい" : "配送状況を知りたい",
          first_message_at: after ? "2026-07-10T00:00:00.000Z" : "2026-06-10T00:00:00.000Z",
        }),
      );
    }
  };
  push(bt, true, false, "bt");
  push(at, true, true, "at");
  push(bc, false, false, "bc");
  push(ac, false, true, "ac");
  return rows;
}

/** fetchRuleMeta → fetchCandidateSessions の2クエリを順に返す fake db。 */
function fakeDb(ruleRows: object[], sessionRows: object[]) {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: ruleRows })
    .mockResolvedValueOnce({ rows: sessionRows })
    .mockResolvedValue({ rows: [] });
  return { query };
}

describe("getRuleEffect — ルールメタの解決", () => {
  it("存在しないルールIDは rule_not_found(セッションクエリを発行しない)", async () => {
    const db = fakeDb([], []);
    const result = await getRuleEffect(db as any, 999);

    expect(result.status).toBe("rule_not_found");
    expect(db.query).toHaveBeenCalledTimes(1); // 母集団の収集まで進まない
  });

  it("未承認ルール(approved_at=null)は not_yet_approved で、集計クエリを発行しない", async () => {
    const db = fakeDb([{ ...RULE_ROW, approved_at: null }], []);
    const result = await getRuleEffect(db as any, 42);

    expect(result.status).toBe("not_yet_approved");
    // 承認前は before/after の分岐点が無く比較が成立しないため、集計に進まない
    expect(db.query).toHaveBeenCalledTimes(1);
    if (result.status === "not_yet_approved") {
      expect(result.tenantId).toBe("tenant-a"); // 越境判定用にテナントは返す
    }
  });
});

describe("getRuleEffect — SQL形状(1セッション=1行の保証)", () => {
  it("回帰: conversion_attributions を LEFT JOIN しない(行が倍化しCVセッションが二重計上される)", async () => {
    // conversion_attributions は session_id に UNIQUE が無い(UNIQUEは event_id のみ)。
    // LEFT JOIN すると1セッションが複数CVを持つ場合に行が倍化し、そのセッションの
    // Judge スコアが平均に二重計上され、DiD が成約セッション寄りに歪む。
    const db = fakeDb([RULE_ROW], []);
    await getRuleEffect(db as any, 42);

    const sql = String(db.query.mock.calls[1]![0]);
    expect(sql).not.toMatch(/LEFT\s+JOIN\s+conversion_attributions/i);
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM conversion_attributions/i);
  });

  it("回帰: conversation_evaluations を LEFT JOIN せず、tenant_id でも絞る", async () => {
    // UNIQUE は (tenant_id, session_id) であり session_id 単独では一意でない。
    // tenant_id を落とすと他テナントの評価行が混入し、かつ行が倍化しうる。
    const db = fakeDb([RULE_ROW], []);
    await getRuleEffect(db as any, 42);

    const sql = String(db.query.mock.calls[1]![0]);
    expect(sql).not.toMatch(/LEFT\s+JOIN\s+conversation_evaluations/i);
    expect(sql).toMatch(/ev\.tenant_id\s*=\s*cs\.tenant_id/);
  });

  it("母集団は「最初のユーザー発言」で定義される(DISTINCT ON + role='user' + created_at ASC)", async () => {
    // 2通目以降は直前のAI応答に依存する(内生的)ため母集団の定義に使えない。
    const db = fakeDb([RULE_ROW], []);
    await getRuleEffect(db as any, 42);

    const sql = String(db.query.mock.calls[1]![0]);
    expect(sql).toContain("DISTINCT ON (cm.session_id)");
    expect(sql).toContain("cm.role = 'user'");
    expect(sql).toContain("ORDER BY cm.session_id, cm.created_at ASC");
  });

  it("PR-3のトラフィックフィルタを再利用してE2E/未タグ付けを除外する", async () => {
    const db = fakeDb([RULE_ROW], []);
    await getRuleEffect(db as any, 42);

    const sql = String(db.query.mock.calls[1]![0]);
    expect(sql).toContain("cs.metadata->>'source' = 'user'");
  });

  it("観測窓の下限はルール作成時刻(存在しない期間をbeforeに含めない)", async () => {
    const db = fakeDb([RULE_ROW], []);
    await getRuleEffect(db as any, 42);

    const [, params] = db.query.mock.calls[1] as [string, unknown[]];
    expect(params![0]).toBe("tenant-a");
    expect(params![1]).toBe(RULE_ROW.created_at);
    expect(params![2]).toBe(RULE_ROW.approved_at);
  });

  it("直近優先で取得する(ORDER BY first_message_at DESC、before/after個別に)", async () => {
    const db = fakeDb([RULE_ROW], []);
    await getRuleEffect(db as any, 42);

    const [sql, params] = db.query.mock.calls[1] as [string, unknown[]];
    // before_limited / after_limited 2本の独立したウィンドウとして出現する
    expect(sql).toContain("before_limited");
    expect(sql).toContain("after_limited");
    expect((sql.match(/ORDER BY first_message_at DESC/g) ?? []).length).toBe(2);
    expect(params[2]).toBe(RULE_ROW.approved_at);
  });
});

describe("getRuleEffect — 上限とtruncated開示(CLAUDE.md「無言の打ち切り禁止」)", () => {
  const PER_SIDE = CANDIDATE_SESSION_LIMIT_FOR_TEST / 2;

  it("上限以下なら truncated=false で、analyzedSessions は実際の行数と一致する", async () => {
    const rows = rowsForBoundary(5, 5, 5, 5); // 20行、上限を大きく下回る
    const db = fakeDb([RULE_ROW], rows);

    const result = await getRuleEffect(db as any, 42);

    expect(result.status).toBe("ok");
    if (result.status === "ok" || result.status === "insufficient_data") {
      expect(result.truncated).toBe(false);
      expect(result.analyzedSessions).toBe(20);
    }
  });

  it("回帰: after側だけが上限を超えても、before側は上限内であれば1件も欠落しない" +
    "(蓄積が続くafter群が観測期間固定のbefore群を押し出さない — 稼働の長いテナントほど" +
    "計測不能になる回帰の防止)", async () => {
    const beforeCount = Math.floor(PER_SIDE / 2); // before側は上限を大きく下回る
    const afterOverflowTotal = PER_SIDE + 1; // after側だけが上限+1件
    const rows = rowsForBoundary(
      Math.ceil(beforeCount / 2),
      Math.ceil(afterOverflowTotal / 2),
      Math.floor(beforeCount / 2),
      Math.floor(afterOverflowTotal / 2),
    );
    const db = fakeDb([RULE_ROW], rows);

    const result = await getRuleEffect(db as any, 42);

    if (result.status === "ok" || result.status === "insufficient_data") {
      expect(result.truncated).toBe(true); // after側が超過したのでtruncatedはtrue
      // だが analyzedSessions は「before側は無傷、after側だけ上限で切られた」件数になる
      expect(result.analyzedSessions).toBe(beforeCount + PER_SIDE);
    } else {
      throw new Error(`unexpected status: ${result.status}`);
    }
  });

  it("回帰: before側だけが上限を超えていても検出される(単純な合計件数チェックでは片側の超過を見逃す)", async () => {
    const beforeOverflowTotal = PER_SIDE + 1;
    const afterCount = Math.floor(PER_SIDE / 2);
    const rows = rowsForBoundary(
      Math.ceil(beforeOverflowTotal / 2),
      Math.ceil(afterCount / 2),
      Math.floor(beforeOverflowTotal / 2),
      Math.floor(afterCount / 2),
    );
    const db = fakeDb([RULE_ROW], rows);

    const result = await getRuleEffect(db as any, 42);

    if (result.status === "ok" || result.status === "insufficient_data") {
      expect(result.truncated).toBe(true);
      expect(result.analyzedSessions).toBe(PER_SIDE + afterCount);
    } else {
      throw new Error(`unexpected status: ${result.status}`);
    }
  });

  it("truncated=true でも例外を投げず、通常どおり群の集計・DiD計算が完走する", async () => {
    const overLimitRows = rowsForBoundary(
      Math.ceil((PER_SIDE + 1) / 2),
      Math.ceil((PER_SIDE + 1) / 2),
      Math.floor((PER_SIDE + 1) / 2),
      Math.floor((PER_SIDE + 1) / 2),
    );
    const db = fakeDb([RULE_ROW], overLimitRows);

    const result = await getRuleEffect(db as any, 42);

    expect(result.status).toBe("ok");
  });
});

describe("getRuleEffect — 群の振り分け", () => {
  /** 全群が母数を満たすだけの行を生成する。 */
  function rowsFor(counts: { bt: number; at: number; bc: number; ac: number }) {
    const rows: object[] = [];
    const push = (n: number, matched: boolean, after: boolean, tag: string) => {
      for (let i = 0; i < n; i++) {
        rows.push(
          sessionRow({
            session_uuid: `${tag}-${i}`,
            first_message: matched ? "返品したい" : "配送状況を知りたい",
            first_message_at: after ? "2026-07-10T00:00:00.000Z" : "2026-06-10T00:00:00.000Z",
            judge_score: 80,
          }),
        );
      }
    };
    push(counts.bt, true, false, "bt");
    push(counts.at, true, true, "at");
    push(counts.bc, false, false, "bc");
    push(counts.ac, false, true, "ac");
    return rows;
  }

  it("trigger_pattern に一致する会話が treatment、一致しない会話が control に入る", async () => {
    const db = fakeDb([RULE_ROW], rowsFor({ bt: 5, at: 6, bc: 7, ac: 8 }));
    const result = await getRuleEffect(db as any, 42);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.comparison.groups.beforeTreatment.n).toBe(5);
      expect(result.comparison.groups.afterTreatment.n).toBe(6);
      expect(result.comparison.groups.beforeControl.n).toBe(7);
      expect(result.comparison.groups.afterControl.n).toBe(8);
    }
  });

  it("境界: approved_at ちょうどのセッションは after 側に入る(>=)", async () => {
    const rows = rowsFor({ bt: 5, at: 5, bc: 5, ac: 5 });
    rows.push(
      sessionRow({
        session_uuid: "boundary",
        first_message: "返品したい",
        first_message_at: RULE_ROW.approved_at, // ちょうど承認時刻
      }),
    );
    const db = fakeDb([RULE_ROW], rows);
    const result = await getRuleEffect(db as any, 42);

    if (result.status === "ok") {
      expect(result.comparison.groups.afterTreatment.n).toBe(6); // 境界は after
      expect(result.comparison.groups.beforeTreatment.n).toBe(5);
    }
  });

  it("Judgeスコアが無いセッションは n に数えないが sessionCount には数える(母数の水増し/取りこぼしを防ぐ)", async () => {
    const rows = rowsFor({ bt: 5, at: 5, bc: 5, ac: 5 });
    rows.push(
      sessionRow({ session_uuid: "no-score", first_message: "返品したい", judge_score: null }),
    );
    const db = fakeDb([RULE_ROW], rows);
    const result = await getRuleEffect(db as any, 42);

    if (result.status === "ok") {
      const at = result.comparison.groups.afterTreatment;
      expect(at.n).toBe(5); // スコア無しは平均の母数に入らない
      expect(at.sessionCount).toBe(6); // 会話としては存在する
    }
  });

  it("2往復到達率は sessionCount(会話数)基準で、Judgeスコア件数基準ではない", async () => {
    const rows: object[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(
        sessionRow({
          session_uuid: `at-${i}`,
          first_message: "返品したい",
          user_message_count: i < 2 ? 3 : 1, // 5件中2件だけ2往復到達
        }),
      );
    }
    // 他3群を母数まで埋める
    for (const [tag, matched, after] of [
      ["bt", true, false],
      ["bc", false, false],
      ["ac", false, true],
    ] as const) {
      for (let i = 0; i < 5; i++) {
        rows.push(
          sessionRow({
            session_uuid: `${tag}-${i}`,
            first_message: matched ? "返品したい" : "配送状況",
            first_message_at: after ? "2026-07-10T00:00:00.000Z" : "2026-06-10T00:00:00.000Z",
          }),
        );
      }
    }
    const db = fakeDb([RULE_ROW], rows);
    const result = await getRuleEffect(db as any, 42);

    if (result.status === "ok") {
      expect(result.comparison.groups.afterTreatment.twoTurnRate).toBeCloseTo(2 / 5, 4);
    }
  });

  it("Anti-Slop: 会話本文(first_message)が戻り値に一切含まれない", async () => {
    const piiLadenMessage = "私のメールは tanaka@example.com です。返品したい";
    const rows = rowsFor({ bt: 5, at: 5, bc: 5, ac: 5 });
    rows.push(sessionRow({ session_uuid: "pii", first_message: piiLadenMessage }));

    const db = fakeDb([RULE_ROW], rows);
    const result = await getRuleEffect(db as any, 42);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("tanaka@example.com");
    expect(serialized).not.toContain("返品したい");
  });

  it("母集団が0件でも例外にならず insufficient_data(現在0件)を返す", async () => {
    const db = fakeDb([RULE_ROW], []);
    const result = await getRuleEffect(db as any, 42);

    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      expect(result.progress).toHaveLength(4); // 4群すべてが不足として報告される
      expect(result.progress.every((p) => p.currentN === 0)).toBe(true);
    }
  });
});
