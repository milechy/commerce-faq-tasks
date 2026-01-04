import { computeNextSalesStage, getInitialSalesStage } from "./salesStageMachine"
import type { SalesStage } from "./salesStageMachine"

describe("salesStageMachine.getInitialSalesStage", () => {
  it("初期ステージは clarify で、理由は initial_clarify", () => {
    const transition = getInitialSalesStage()

    expect(transition.previousStage).toBeNull()
    expect(transition.nextStage).toBe<SalesStage>("clarify")
    expect(transition.reason).toBe("initial_clarify")
  })
})

describe("salesStageMachine.computeNextSalesStage", () => {
  it("previousStage が null の場合は常に clarify / initial_clarify", () => {
    const transition = computeNextSalesStage({
      previousStage: null,
      hasProposeIntent: true,
      hasRecommendIntent: true,
      hasCloseIntent: true,
    })

    expect(transition.previousStage).toBeNull()
    expect(transition.nextStage).toBe<SalesStage>("clarify")
    expect(transition.reason).toBe("initial_clarify")
  })

  it("manualNextStage があればそれを最優先する", () => {
    const transition = computeNextSalesStage({
      previousStage: "propose",
      hasProposeIntent: false,
      hasRecommendIntent: false,
      hasCloseIntent: false,
      manualNextStage: "close",
    })

    expect(transition.previousStage).toBe<SalesStage>("propose")
    expect(transition.nextStage).toBe<SalesStage>("close")
    expect(transition.reason).toBe("manual_override")
  })

  describe("clarify ステージ", () => {
    it("intent 候補があれば propose へ自動進行", () => {
      const transition = computeNextSalesStage({
        previousStage: "clarify",
        hasProposeIntent: true,
        hasRecommendIntent: false,
        hasCloseIntent: false,
      })

      expect(transition.nextStage).toBe<SalesStage>("propose")
      expect(transition.reason).toBe("auto_progress_by_intent")
    })

    it("intent 候補がなければ clarify 続行", () => {
      const transition = computeNextSalesStage({
        previousStage: "clarify",
        hasProposeIntent: false,
        hasRecommendIntent: false,
        hasCloseIntent: false,
      })

      expect(transition.nextStage).toBe<SalesStage>("clarify")
      expect(transition.reason).toBe("stay_in_stage")
    })
  })

  describe("propose ステージ", () => {
    it("close intent があれば close へ進む", () => {
      const transition = computeNextSalesStage({
        previousStage: "propose",
        hasProposeIntent: false,
        hasRecommendIntent: false,
        hasCloseIntent: true,
      })

      expect(transition.nextStage).toBe<SalesStage>("close")
      expect(transition.reason).toBe("auto_progress_by_intent")
    })

    it("close intent が無く recommend intent があれば recommend へ進む", () => {
      const transition = computeNextSalesStage({
        previousStage: "propose",
        hasProposeIntent: false,
        hasRecommendIntent: true,
        hasCloseIntent: false,
      })

      expect(transition.nextStage).toBe<SalesStage>("recommend")
      expect(transition.reason).toBe("auto_progress_by_intent")
    })

    it("intent 候補がなければ propose 続行", () => {
      const transition = computeNextSalesStage({
        previousStage: "propose",
        hasProposeIntent: false,
        hasRecommendIntent: false,
        hasCloseIntent: false,
      })

      expect(transition.nextStage).toBe<SalesStage>("propose")
      expect(transition.reason).toBe("stay_in_stage")
    })
  })

  describe("recommend ステージ", () => {
    it("close intent があれば close へ進む", () => {
      const transition = computeNextSalesStage({
        previousStage: "recommend",
        hasProposeIntent: false,
        hasRecommendIntent: false,
        hasCloseIntent: true,
      })

      expect(transition.nextStage).toBe<SalesStage>("close")
      expect(transition.reason).toBe("auto_progress_by_intent")
    })

    it("intent 候補がなければ recommend 続行", () => {
      const transition = computeNextSalesStage({
        previousStage: "recommend",
        hasProposeIntent: false,
        hasRecommendIntent: false,
        hasCloseIntent: false,
      })

      expect(transition.nextStage).toBe<SalesStage>("recommend")
      expect(transition.reason).toBe("stay_in_stage")
    })
  })

  describe("close / ended ステージ", () => {
    it("close ではデフォルトでステージ維持", () => {
      const transition = computeNextSalesStage({
        previousStage: "close",
        hasProposeIntent: true,
        hasRecommendIntent: true,
        hasCloseIntent: true,
      })

      expect(transition.nextStage).toBe<SalesStage>("close")
      expect(transition.reason).toBe("stay_in_stage")
    })

    it("ended でもデフォルトでステージ維持", () => {
      const transition = computeNextSalesStage({
        previousStage: "ended",
        hasProposeIntent: true,
        hasRecommendIntent: true,
        hasCloseIntent: true,
      })

      expect(transition.nextStage).toBe<SalesStage>("ended")
      expect(transition.reason).toBe("stay_in_stage")
    })
  })
})
