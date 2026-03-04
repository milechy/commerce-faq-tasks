import { runSalesOrchestrator } from "./salesOrchestrator";
import type { SalesStage } from "./salesStageMachine";

const makeDetection = () => ({
  userMessage: "dummy message",
  history: [],
  plan: undefined,
});

describe("runSalesOrchestrator + salesStageMachine integration", () => {
  it("clarify -> propose: proposeIntent があり、まだ proposeTriggered されていない場合は propose に進む", () => {
    const previousMeta: any = {
      phase: "clarify",
      proposeTriggered: false,
      recommendTriggered: false,
      closeTriggered: false,
    };

    const result = runSalesOrchestrator({
      detection: makeDetection(),
      previousMeta,
      proposeIntent: "trial_lesson_offer" as any,
      recommendIntent: undefined,
      closeIntent: undefined,
      personaTags: ["beginner"],
    });

    expect(result.nextStage).toBe<SalesStage>("propose");
    expect((result.meta as any).phase).toBe<SalesStage>("propose");
    expect((result.meta as any).proposeTriggered).toBe(true);
  });

  it("propose -> recommend: recommendIntent があり、まだ recommendTriggered されていない場合は recommend に進む", () => {
    const previousMeta: any = {
      phase: "propose",
      proposeTriggered: true,
      recommendTriggered: false,
      closeTriggered: false,
    };

    const result = runSalesOrchestrator({
      detection: makeDetection(),
      previousMeta,
      proposeIntent: "trial_lesson_offer" as any,
      recommendIntent: "recommend_course_based_on_level" as any,
      closeIntent: undefined,
      personaTags: ["beginner"],
    });

    expect(result.nextStage).toBe<SalesStage>("recommend");
    expect((result.meta as any).phase).toBe<SalesStage>("recommend");
    expect((result.meta as any).recommendTriggered).toBe(true);
  });

  it("recommend -> close: closeIntent があり、まだ closeTriggered されていない場合は close に進む", () => {
    const previousMeta: any = {
      phase: "recommend",
      proposeTriggered: true,
      recommendTriggered: true,
      closeTriggered: false,
    };

    const result = runSalesOrchestrator({
      detection: makeDetection(),
      previousMeta,
      proposeIntent: "trial_lesson_offer" as any,
      recommendIntent: "recommend_course_based_on_level" as any,
      closeIntent: "close_handle_objection_price" as any,
      personaTags: ["beginner"],
    });

    expect(result.nextStage).toBe<SalesStage>("close");
    expect((result.meta as any).phase).toBe<SalesStage>("close");
    expect((result.meta as any).closeTriggered).toBe(true);
  });

  it("previousMeta が無い初回呼び出しでは clarify ステージにセットされるが、テンプレ生成は行わない", () => {
    const previousMeta: any = undefined;

    const result = runSalesOrchestrator({
      detection: makeDetection(),
      previousMeta,
      proposeIntent: "trial_lesson_offer" as any,
      recommendIntent: undefined,
      closeIntent: undefined,
      personaTags: ["beginner"],
    });

    // state machine 的には clarify スタートだが、初回はまだテンプレを出さない
    expect(result.nextStage).toBeUndefined();
    expect((result.meta as any).phase).toBe<SalesStage>("clarify");
  });
});
