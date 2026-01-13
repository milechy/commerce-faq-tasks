// jest.config.cjs

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",

  // Only run tests for the main workspace (avoid archived contexts / nested sample apps)
  testMatch: ["<rootDir>/{src,tests}/**/*.test.ts"],

  // These directories contain archived snapshots / minimal repro apps that should NOT be part of CI/dev test runs.
  // They also cause jest-haste-map naming collisions due to duplicate package.json names.
  testPathIgnorePatterns: [
    "/node_modules/",

    // Archived snapshots / minimal repro apps (also cause haste-map collisions)
    "<rootDir>/commerce-faq-phase7-minimal/",
    "<rootDir>/phase12-context/",
    "<rootDir>/phase12-context 2/",

    // Legacy / script-style tests (they run `main()` + process.exit and/or contain no Jest tests)
    "<rootDir>/src/agent/http/agentDialogRoute.test.ts",
    "<rootDir>/src/agent/flow/dialogOrchestrator.test.ts",
    "<rootDir>/src/agent/flow/ruleBasedPlanner.test.ts",
    "<rootDir>/src/agent/orchestrator/langGraphOrchestrator.test.ts",
    "<rootDir>/src/agent/crew/CrewGraph.test.ts",
    "<rootDir>/tests/agent/salesPipeline.test.ts",
    "<rootDir>/tests/agent/pipelineFactory.test.ts",
    "<rootDir>/tests/agent/llm/modelRouter.test.ts",
  ],

  modulePathIgnorePatterns: [
    "<rootDir>/commerce-faq-phase7-minimal/",
    "<rootDir>/phase12-context/",
    "<rootDir>/phase12-context 2/",
  ],

  moduleFileExtensions: ["ts", "js", "json", "node"],
};
