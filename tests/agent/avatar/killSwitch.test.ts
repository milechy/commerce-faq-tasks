// tests/agent/avatar/killSwitch.test.ts

import { evaluateAvatarPolicy, type AvatarPolicyInput } from "../../../src/agent/avatar/avatarPolicy";

describe("Phase22 Kill Switch Operational Tests", () => {
  const baseInput: AvatarPolicyInput = {
    provider: "lemon_slice",
    locale: "ja",
    userMessage: "こんにちは",
    history: [],
    flags: {
      avatarEnabled: true,
      avatarForceOff: false,
    },
    killSwitch: {
      enabled: false,
    },
    timing: {
      readinessTimeoutMs: 1500,
    },
  };

  describe("Kill Switch Activation", () => {
    test("should disable avatar immediately when kill switch is activated", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Connection failure rate exceeded 50%",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.disableReason).toBe("kill_switch");
      expect(decision.killReason).toBe("Connection failure rate exceeded 50%");
    });

    test("should disable avatar for cost overrun", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Cost budget exceeded: $500 limit reached",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("Cost budget exceeded");
    });

    test("should disable avatar for latency issues", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Latency degradation: p95 > 5000ms for 10 minutes",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("Latency degradation");
    });

    test("should disable avatar for security concerns", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "PII mixing detected in avatar responses",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("PII mixing");
    });

    test("should disable avatar for loop detection", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Conversation loop rate exceeded threshold: 15%",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("loop rate");
    });
  });

  describe("Kill Switch Priority", () => {
    test("should respect PII over kill switch", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "クレジットカード番号を入力したい",
        killSwitch: {
          enabled: true,
          reason: "Should not reach here",
        },
      });

      expect(decision.status).toBe("forced_off_pii");
      expect(decision.disableReason).toBe("pii_route");
    });

    test("should respect feature flags over kill switch", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        flags: {
          avatarEnabled: false,
          avatarForceOff: false,
        },
        killSwitch: {
          enabled: true,
          reason: "Should not reach here",
        },
      });

      expect(decision.status).toBe("disabled_by_flag");
      expect(decision.disableReason).toBe("flag_off");
    });
  });

  describe("Kill Switch Operational Scenarios", () => {
    test("should allow normal operation when kill switch is off", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: false,
        },
      });

      expect(decision.status).toBe("requested");
      expect(decision.disableReason).toBeUndefined();
    });

    test("should work without kill reason", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.disableReason).toBe("kill_switch");
      expect(decision.killReason).toBeUndefined();
    });
  });

  describe("Environment Variable Integration", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    test("should read kill switch from environment (simulated)", () => {
      // This test simulates environment-based kill switch
      // In real implementation, this would be read from process.env.KILL_SWITCH_AVATAR
      const envKillSwitchEnabled = process.env.KILL_SWITCH_AVATAR === "true";
      const envKillSwitchReason = process.env.KILL_SWITCH_REASON;

      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: envKillSwitchEnabled,
          reason: envKillSwitchReason,
        },
      });

      // Should be requested when env var is not set
      expect(decision.status).toBe("requested");
    });
  });

  describe("Kill Criteria Scenarios (from PHASE22.md)", () => {
    test("should trigger on connection failure spike", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Avatar connection failure rate: 45% (threshold: 30%)",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("connection failure");
    });

    test("should trigger on latency degradation", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Avatar response latency degraded: p95=6.2s (threshold: 5.0s)",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("latency degraded");
    });

    test("should trigger on loop rate increase", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Conversation loop detection rate: 12% (threshold: 10%)",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("loop detection");
    });

    test("should trigger on security/privacy concern", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Privacy concern: potential PII leakage detected in avatar logs",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("Privacy concern");
    });

    test("should trigger on cost threshold", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Cost threshold approaching: $450/$500 daily limit (90%)",
        },
      });

      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.killReason).toContain("Cost threshold");
    });
  });
});
