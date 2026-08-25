// admin-ui/src/pages/admin/analytics/flowTransitions.schema.test.ts
//
// P0-1 (GID 1217808384631918) の再発防止。
// このテストが守るのは「サーバーの実レスポンス形が変わったら実行時に throw する」
// ことであり、tsc のキャストをすり抜けて undefined を握ったまま描画に進まない
// ことを固定する。フィクスチャは2026-08-25の本番実測レスポンスをそのまま使う。
import { describe, it, expect } from "vitest";
import { parseFlowTransitionsResponse } from "./flowTransitions.schema";

// 2026-08-25 本番実測(carnation, period=30d)
const PRODUCTION_FIXTURE = {
  period: "30d",
  tenant_id: null,
  total_transitions: 0,
  funnel: {
    to_answer_count: 0,
    to_confirm_count: 0,
    to_terminal_count: 0,
    completed_count: 0,
    confirm_rate_pct: 0,
    completion_rate_pct: 0,
  },
  transitions: [],
};

const NONZERO_FIXTURE = {
  period: "30d",
  tenant_id: "carnation",
  total_transitions: 40,
  funnel: {
    to_answer_count: 15,
    to_confirm_count: 8,
    to_terminal_count: 5,
    completed_count: 3,
    confirm_rate_pct: 20.0,
    completion_rate_pct: 60.0,
  },
  transitions: [
    { from_state: null, to_state: "answer", transition_count: 15 },
    { from_state: "answer", to_state: "confirm", transition_count: 8 },
    { from_state: "confirm", to_state: "terminal", transition_count: 5 },
  ],
};

describe("parseFlowTransitionsResponse — 本番実測フィクスチャ", () => {
  it("0件レスポンス(carnation実測)をそのまま受け入れる", () => {
    const parsed = parseFlowTransitionsResponse(PRODUCTION_FIXTURE);
    expect(parsed.total_transitions).toBe(0);
    expect(parsed.funnel.completed_count).toBe(0);
    expect(parsed.transitions).toEqual([]);
  });

  it("非0件レスポンスの全フィールドを正しく通す", () => {
    const parsed = parseFlowTransitionsResponse(NONZERO_FIXTURE);
    expect(parsed.total_transitions).toBe(40);
    expect(parsed.funnel.to_answer_count).toBe(15);
    expect(parsed.funnel.confirm_rate_pct).toBe(20.0);
    expect(parsed.transitions).toHaveLength(3);
    expect(parsed.transitions[0].from_state).toBeNull();
  });
});

describe("parseFlowTransitionsResponse — 事故の再現(旧型定義との不一致)", () => {
  // P0-1事故の直接原因: 旧フロント型は total_sessions / funnel.clarify_rate 等
  // 5フィールドを期待していたが、サーバーは1つも一致しないレスポンスを返していた。
  // その形をここでもう一度投入し、必ず throw することを固定する。
  it("旧フロント型が期待していた形(total_sessions/funnel.clarify_rate等)は拒否する", () => {
    const legacyShapeFromBug = {
      period: "30d",
      total_sessions: 13, // total_transitions ではない
      transitions: [{ from_state: "answer", to_state: "confirm", count: 5 }], // transition_count ではない
      funnel: {
        clarify_rate: 0.5,
        answer_rate: 0.3,
        confirm_rate: 0.2,
        terminal_rate: 0.1,
        loop_abort_rate: 0.05,
      },
    };
    expect(() => parseFlowTransitionsResponse(legacyShapeFromBug)).toThrow();
  });

  it("total_transitions が欠落していれば throw する", () => {
    const { total_transitions, ...rest } = PRODUCTION_FIXTURE;
    expect(() => parseFlowTransitionsResponse(rest)).toThrow(/total_transitions/);
  });

  it("funnel が欠落していれば throw する", () => {
    const { funnel, ...rest } = PRODUCTION_FIXTURE;
    expect(() => parseFlowTransitionsResponse(rest)).toThrow(/funnel/);
  });

  it("funnelの必須フィールドが1つでも欠けていれば throw する", () => {
    const broken = {
      ...PRODUCTION_FIXTURE,
      funnel: { ...PRODUCTION_FIXTURE.funnel, completed_count: undefined },
    };
    expect(() => parseFlowTransitionsResponse(broken)).toThrow(/completed_count/);
  });

  it("transitions が配列でなければ throw する", () => {
    const broken = { ...PRODUCTION_FIXTURE, transitions: null };
    expect(() => parseFlowTransitionsResponse(broken)).toThrow(/transitions/);
  });

  it("null や配列など、そもそもオブジェクトでない入力は throw する", () => {
    expect(() => parseFlowTransitionsResponse(null)).toThrow();
    expect(() => parseFlowTransitionsResponse(undefined)).toThrow();
    expect(() => parseFlowTransitionsResponse([])).toThrow();
    expect(() => parseFlowTransitionsResponse("not json")).toThrow();
  });

  it("funnelの数値がNaN/Infinityなら throw する(pgの型変換ミスを検知する)", () => {
    const brokenNaN = {
      ...PRODUCTION_FIXTURE,
      funnel: { ...PRODUCTION_FIXTURE.funnel, confirm_rate_pct: NaN },
    };
    const brokenInf = {
      ...PRODUCTION_FIXTURE,
      funnel: { ...PRODUCTION_FIXTURE.funnel, confirm_rate_pct: Infinity },
    };
    expect(() => parseFlowTransitionsResponse(brokenNaN)).toThrow();
    expect(() => parseFlowTransitionsResponse(brokenInf)).toThrow();
  });
});

describe("parseFlowTransitionsResponse — 境界値", () => {
  it("transitionsが空配列でも正しく通る(0件は異常ではない)", () => {
    const parsed = parseFlowTransitionsResponse({ ...PRODUCTION_FIXTURE, transitions: [] });
    expect(parsed.transitions).toEqual([]);
  });

  it("from_state が null の行(開始状態からの遷移)を保つ", () => {
    const parsed = parseFlowTransitionsResponse(NONZERO_FIXTURE);
    expect(parsed.transitions.find((t) => t.from_state === null)).toBeDefined();
  });

  it("tenant_id が null(super_adminの全テナント集計)を保つ", () => {
    const parsed = parseFlowTransitionsResponse(PRODUCTION_FIXTURE);
    expect(parsed.tenant_id).toBeNull();
  });

  it("period の妥当性検証はしない(サーバー側で既にallowlist検証済みのため、ここでは値をそのまま通す)", () => {
    const parsed = parseFlowTransitionsResponse({ ...PRODUCTION_FIXTURE, period: "365d" });
    expect(parsed.period).toBe("365d" as never);
  });

  it("period が欠落していれば既定の30dを補う(致命的でないフィールドは補完する)", () => {
    const { period, ...rest } = PRODUCTION_FIXTURE;
    const parsed = parseFlowTransitionsResponse(rest);
    expect(parsed.period).toBe("30d");
  });
});
