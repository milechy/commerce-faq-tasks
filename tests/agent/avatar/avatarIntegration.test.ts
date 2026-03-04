// tests/agent/avatar/avatarIntegration.test.ts

import { evaluateAvatarPolicy, type AvatarPolicyInput } from "../../../src/agent/avatar/avatarPolicy";
import { detectPiiRoute } from "../../../src/agent/avatar/piiRouteDetector";

describe("Phase22 Avatar Integration Tests", () => {
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

  describe("Normal Flow (Avatar Enabled)", () => {
    test("should request avatar for normal conversation", () => {
      const decision = evaluateAvatarPolicy(baseInput);
      expect(decision.status).toBe("requested");
      expect(decision.readinessTimeoutMs).toBe(1500);
    });

    test("should handle avatar readiness timeout", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        timing: { readinessTimeoutMs: 3000 },
      });
      expect(decision.status).toBe("requested");
      expect(decision.readinessTimeoutMs).toBe(3000);
    });
  });

  describe("PII Route Detection", () => {
    test("should block avatar on payment-related messages", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "クレジットカードで支払いたいです",
      });
      expect(decision.status).toBe("forced_off_pii");
      expect(decision.disableReason).toBe("pii_route");
      expect(decision.piiReasons).toContain("payment_billing");
    });

    test("should block avatar on order tracking", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "注文番号12345の配送状況を教えて",
      });
      expect(decision.status).toBe("forced_off_pii");
      expect(decision.piiReasons).toContain("order_tracking");
    });

    test("should block avatar on address-related messages", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "住所を変更したいです",
      });
      expect(decision.status).toBe("forced_off_pii");
      expect(decision.piiReasons).toContain("address_contact");
    });

    test("should detect PII in conversation history", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "変更したいです",
        history: [
          { role: "user", content: "パスワードをリセットしたい" },
          { role: "assistant", content: "承知しました" },
        ],
      });
      expect(decision.status).toBe("forced_off_pii");
      expect(decision.piiReasons).toContain("credentials");
    });
  });

  describe("Feature Flag Control", () => {
    test("should disable avatar when flag is off", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        flags: {
          avatarEnabled: false,
          avatarForceOff: false,
        },
      });
      expect(decision.status).toBe("disabled_by_flag");
      expect(decision.disableReason).toBe("flag_off");
    });

    test("should force off avatar when forceOff flag is true", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        flags: {
          avatarEnabled: true,
          avatarForceOff: true,
        },
      });
      expect(decision.status).toBe("disabled_by_flag");
      expect(decision.disableReason).toBe("flag_off");
    });
  });

  describe("Kill Switch Control", () => {
    test("should disable avatar when kill switch is enabled", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
          reason: "Cost exceeded threshold",
        },
      });
      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.disableReason).toBe("kill_switch");
      expect(decision.killReason).toBe("Cost exceeded threshold");
    });

    test("should disable avatar with generic kill switch", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        killSwitch: {
          enabled: true,
        },
      });
      expect(decision.status).toBe("disabled_by_kill_switch");
      expect(decision.disableReason).toBe("kill_switch");
    });
  });

  describe("Priority Order", () => {
    test("PII should override all other settings", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "クレジットカード情報を入力したい",
        flags: {
          avatarEnabled: true,
          avatarForceOff: false,
        },
        killSwitch: {
          enabled: false,
        },
      });
      expect(decision.status).toBe("forced_off_pii");
    });

    test("Feature flags should be checked before kill switch", () => {
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
    });
  });

  describe("Intent Hint Detection", () => {
    test("should detect payment intent from hint", () => {
      const decision = evaluateAvatarPolicy({
        ...baseInput,
        userMessage: "手続きを進めたい",
        intentHint: "payment",
      });
      expect(decision.status).toBe("forced_off_pii");
      expect(decision.piiReasons).toContain("payment_billing");
    });
  });
});

describe("PII Route Detector Unit Tests", () => {
  test("should detect payment keywords in Japanese", () => {
    const result = detectPiiRoute({
      userMessage: "クレジットカードで決済します",
    });
    expect(result.isPiiRoute).toBe(true);
    expect(result.reasons).toContain("payment_billing");
  });

  test("should detect payment keywords in English", () => {
    const result = detectPiiRoute({
      userMessage: "I want to pay with credit card",
    });
    expect(result.isPiiRoute).toBe(true);
    expect(result.reasons).toContain("payment_billing");
  });

  test("should detect long numeric tokens", () => {
    const result = detectPiiRoute({
      userMessage: "My order number is 1234567890123",
    });
    expect(result.isPiiRoute).toBe(true);
    expect(result.reasons).toContain("id_like_token");
  });

  test("should not flag normal conversation", () => {
    const result = detectPiiRoute({
      userMessage: "英会話レッスンについて教えてください",
    });
    expect(result.isPiiRoute).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  test("should handle multiple PII reasons", () => {
    const result = detectPiiRoute({
      userMessage: "注文番号1234567890でカード決済の住所を変更したい",
    });
    expect(result.isPiiRoute).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(1);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["payment_billing", "order_tracking", "address_contact", "id_like_token"])
    );
  });
});
